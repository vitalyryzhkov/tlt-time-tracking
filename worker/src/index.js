// One-device-per-email gate for the TLT tracker behind Cloudflare Access.
//
// Cloudflare Access already decides WHO may enter (one-time code to an
// allow-listed email). This module decides FROM WHERE: the first device that
// shows up with a given email gets a random id in a cookie and the pair is
// stored in KV. Any later request with that email must carry the same cookie,
// otherwise it gets a 403 page. The owner (ADMIN_EMAIL) can list and reset
// bindings via /admin/*.
//
// The same handler is used two ways (see README.md):
//   - functions/_middleware.js  -> Pages Function, `forward` is context.next()
//   - export default below      -> standalone Worker, `forward` proxies to ORIGIN_URL

// How many devices one email may use. 1 = strict one-device mode.
export const DEVICE_LIMIT = 1;

export const COOKIE_NAME = 'tlt_device';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // one year
const KV_PREFIX = 'email:';
const JWKS_TTL_MS = 60 * 60 * 1000; // re-fetch Access public keys hourly
const JWKS_MIN_INTERVAL_MS = 60 * 1000; // unknown kid may force a re-fetch, but not more often

// Module-level cache of Access public keys: survives across requests inside
// one isolate, which is all we need (JWKS is tiny and rarely rotates).
let jwksCache = { fetchedAt: 0, keys: new Map() };

/**
 * Main entry point.
 * @param {Request} request
 * @param {object} env  bindings: DEVICES (KV), ADMIN_EMAIL, ACCESS_TEAM_DOMAIN,
 *                      ACCESS_AUD, optional DEVICE_LIMIT, optional ORIGIN_URL
 * @param {(request: Request) => Promise<Response>} forward  how to reach the site
 * @param {object} [deps]  test seams: fetchJwks(url), now(), randomId()
 */
export async function handle(request, env, forward, deps = {}) {
  const now = deps.now || (() => Date.now());
  const url = new URL(request.url);

  const who = await identify(request, env, deps);
  if (!who.email) {
    return htmlResponse(403, pageNoEmail(who.reason));
  }
  const email = who.email;

  if (url.pathname === '/admin/reset' || url.pathname === '/admin/list') {
    if (!isAdmin(email, env)) {
      // Non-admins must not learn that admin endpoints exist.
      return htmlResponse(404, PAGE_NOT_FOUND);
    }
    return handleAdmin(url, env, now);
  }

  const key = KV_PREFIX + email;
  const record = (await env.DEVICES.get(key, 'json')) || { devices: [] };
  const limit = resolveLimit(env);

  const cookieId = readCookie(request.headers.get('Cookie'), COOKIE_NAME);
  const cookieHash = cookieId ? await sha256Hex(cookieId) : null;

  if (cookieHash && record.devices.some((d) => d.hash === cookieHash)) {
    return forward(request);
  }

  if (record.devices.length >= limit) {
    return htmlResponse(403, PAGE_OTHER_DEVICE);
  }

  // First visit of a new device (or a slot freed by an admin reset): bind it.
  // Always mint the id server-side so a client cannot pick a value in advance.
  const deviceId = (deps.randomId || randomId)();
  const hash = await sha256Hex(deviceId);
  record.devices.push({
    hash,
    firstSeen: new Date(now()).toISOString(),
    ua: (request.headers.get('User-Agent') || '').slice(0, 300),
  });
  await env.DEVICES.put(key, JSON.stringify(record));

  const response = await forward(request);
  // Response from fetch()/next() may be immutable, so copy before touching headers.
  const out = new Response(response.body, response);
  out.headers.append('Set-Cookie', buildCookie(deviceId));
  return out;
}

// ---------------------------------------------------------------------------
// Identity: who is making this request, according to Cloudflare Access.

// Returns {email} or {email: null, reason}. The reason is a short code shown
// on the 403 page so the owner can tell a missing variable from a bad one
// without reading logs; it never includes the token or variable values.
async function identify(request, env, deps) {
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    readCookie(request.headers.get('Cookie'), 'CF_Authorization');
  if (!token) return { email: null, reason: 'no-token' };
  if (!env.ACCESS_TEAM_DOMAIN) return { email: null, reason: 'no-team-domain' };
  if (!env.ACCESS_AUD) return { email: null, reason: 'no-aud' };

  const result = await verifyAccessJwt(token, env, deps);
  if (!result.payload) return { email: null, reason: result.reason };
  if (typeof result.payload.email !== 'string') return { email: null, reason: 'no-email-claim' };
  return { email: normalizeEmail(result.payload.email) };
}

/**
 * Verifies the Access JWT (RS256) against the team's JWKS.
 * Returns {payload} on success, {payload: null, reason} otherwise.
 */
export async function verifyAccessJwt(token, env, deps = {}) {
  const fail = (reason) => ({ payload: null, reason });
  const parts = token.split('.');
  if (parts.length !== 3) return fail('bad-token');
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecodeToString(parts[0]));
    payload = JSON.parse(b64urlDecodeToString(parts[1]));
  } catch {
    return fail('bad-token');
  }
  if (header.alg !== 'RS256' || !header.kid) return fail('bad-token');

  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`;
  const nowSec = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== issuer) return fail('team-domain-mismatch');
  if (!aud.includes(env.ACCESS_AUD)) return fail('aud-mismatch');
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return fail('expired');
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) return fail('not-yet-valid');

  const key = await getAccessKey(issuer, header.kid, deps);
  if (!key) return fail('jwks');

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = b64urlDecodeToBytes(parts[2]);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  } catch {
    ok = false;
  }
  return ok ? { payload } : fail('bad-signature');
}

async function getAccessKey(issuer, kid, deps) {
  const now = deps.now ? deps.now() : Date.now();
  const age = now - jwksCache.fetchedAt;
  const unknownKid = !jwksCache.keys.has(kid) && age > JWKS_MIN_INTERVAL_MS;
  if (age > JWKS_TTL_MS || unknownKid) {
    const fetchJwks = deps.fetchJwks || defaultFetchJwks;
    let jwks;
    try {
      jwks = await fetchJwks(`${issuer}/cdn-cgi/access/certs`);
    } catch {
      // Certs endpoint unavailable: keep the keys we have, retry no sooner
      // than JWKS_MIN_INTERVAL_MS, and let known kids keep working.
      jwksCache = { fetchedAt: now, keys: jwksCache.keys };
      return jwksCache.keys.get(kid) || null;
    }
    const keys = new Map();
    for (const jwk of jwks?.keys || []) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      try {
        const cryptoKey = await crypto.subtle.importKey(
          'jwk',
          { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        );
        keys.set(jwk.kid, cryptoKey);
      } catch {
        // Skip malformed keys; a missing kid simply fails verification.
      }
    }
    jwksCache = { fetchedAt: now, keys };
  }
  return jwksCache.keys.get(kid) || null;
}

async function defaultFetchJwks(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  return res.json();
}

/** Test seam: drop cached keys. */
export function resetJwksCache() {
  jwksCache = { fetchedAt: 0, keys: new Map() };
}

// ---------------------------------------------------------------------------
// Admin endpoints.

function isAdmin(email, env) {
  return Boolean(env.ADMIN_EMAIL) && normalizeEmail(env.ADMIN_EMAIL) === email;
}

async function handleAdmin(url, env, now) {
  if (url.pathname === '/admin/reset') {
    const target = url.searchParams.get('email');
    if (!target || !target.includes('@')) {
      return textResponse(400, 'Нужен параметр ?email=адрес');
    }
    const key = KV_PREFIX + normalizeEmail(target);
    const existed = (await env.DEVICES.get(key)) !== null;
    await env.DEVICES.delete(key);
    return textResponse(
      200,
      existed
        ? `Привязка ${normalizeEmail(target)} удалена. Следующее устройство с этой почтой станет новым.`
        : `Для ${normalizeEmail(target)} привязки не было — удалять нечего.`,
    );
  }

  // /admin/list
  const rows = [];
  let cursor;
  do {
    const page = await env.DEVICES.list({ prefix: KV_PREFIX, cursor });
    for (const k of page.keys) {
      const record = await env.DEVICES.get(k.name, 'json');
      const email = k.name.slice(KV_PREFIX.length);
      for (const d of record?.devices || []) {
        rows.push({ email, firstSeen: d.firstSeen, ua: d.ua });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  rows.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  const body = rows.length
    ? `<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><th>Почта</th><th>Привязано</th><th>Устройство (User-Agent)</th><th></th></tr>
${rows
  .map(
    (r) =>
      `<tr><td>${esc(r.email)}</td><td>${esc(r.firstSeen)}</td><td>${esc(r.ua)}</td>` +
      `<td><a href="/admin/reset?email=${encodeURIComponent(r.email)}">сбросить</a></td></tr>`,
  )
  .join('\n')}
</table>`
    : '<p>Привязок пока нет.</p>';
  const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Привязки устройств</title></head>
<body style="font-family:system-ui,sans-serif;padding:16px">
<h1>Привязки устройств</h1>
<p>Всего записей: ${rows.length}. Лимит устройств на почту: ${resolveLimit(env)}.
Сейчас ${esc(new Date(now()).toISOString())}.</p>
${body}
</body></html>`;
  return htmlResponse(200, page);
}

// ---------------------------------------------------------------------------
// Standalone Worker entry: proxy allowed requests to ORIGIN_URL.

export default {
  async fetch(request, env) {
    return handle(request, env, (req) => proxyToOrigin(req, env.ORIGIN_URL));
  },
};

function proxyToOrigin(request, originUrl) {
  if (!originUrl) {
    return Promise.resolve(textResponse(500, 'ORIGIN_URL is not configured'));
  }
  const origin = new URL(originUrl);
  const url = new URL(request.url);
  url.protocol = origin.protocol;
  url.hostname = origin.hostname;
  url.port = origin.port;
  return fetch(new Request(url.toString(), request));
}

// ---------------------------------------------------------------------------
// Helpers.

function resolveLimit(env) {
  const n = Number.parseInt(env.DEVICE_LIMIT, 10);
  return Number.isInteger(n) && n > 0 ? n : DEVICE_LIMIT;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

export function readCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      const value = part.slice(idx + 1).trim();
      return value || null;
    }
  }
  return null;
}

function buildCookie(deviceId) {
  return `${COOKIE_NAME}=${deviceId}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64urlDecodeToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecodeToString(s) {
  return new TextDecoder().decode(b64urlDecodeToBytes(s));
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlResponse(status, html) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function textResponse(status, text) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function simplePage(title, text) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;max-width:32em;margin:auto">
<h1 style="font-size:1.3em">${esc(title)}</h1>
<p>${esc(text)}</p>
</body></html>`;
}

const PAGE_OTHER_DEVICE = simplePage(
  'Вход с этого устройства закрыт',
  'Этот адрес уже привязан к другому устройству. Доступ разрешён только с одного устройства.',
);
function pageNoEmail(reason) {
  return simplePage(
    'Нет входа',
    'Не удалось определить, кто вы. Откройте сайт заново и войдите по коду из письма. '
      + 'Код: ' + (reason || 'unknown') + '.',
  );
}
const PAGE_NOT_FOUND = simplePage('Страница не найдена', 'Такой страницы нет.');
