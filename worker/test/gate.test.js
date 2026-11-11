import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle, resetJwksCache, COOKIE_NAME, readCookie } from '../src/index.js';

// ---------------------------------------------------------------------------
// Test doubles: KV namespace, Access JWT signing, site origin.

class MockKV {
  constructor() {
    this.store = new Map();
  }
  async get(key, type) {
    if (!this.store.has(key)) return null;
    const raw = this.store.get(key);
    return type === 'json' ? JSON.parse(raw) : raw;
  }
  async put(key, value) {
    this.store.set(key, value);
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list({ prefix = '' } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

const TEAM = 'testteam';
const AUD = 'aud-tag-123';
const ADMIN = 'owner@example.com';
const KID = 'key-1';

let privateKey;
let jwks;

function b64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
  return buf.toString('base64url');
}

async function signJwt(payload, { kid = KID, key = privateKey } = {}) {
  const header = { alg: 'RS256', kid, typ: 'JWT' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function accessToken(email, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: `https://${TEAM}.cloudflareaccess.com`,
    aud: [AUD],
    email,
    iat: now,
    exp: now + 3600,
    ...overrides,
  });
}

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  privateKey = pair.privateKey;
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  jwks = { keys: [{ kty: 'RSA', kid: KID, n: pub.n, e: pub.e, alg: 'RS256', use: 'sig' }] };
});

let kv;
let env;
let forwarded;
const deps = { fetchJwks: async () => jwks };

beforeEach(() => {
  resetJwksCache();
  kv = new MockKV();
  env = { DEVICES: kv, ADMIN_EMAIL: ADMIN, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  forwarded = [];
});

async function forward(request) {
  forwarded.push(request);
  return new Response('SITE OK', { status: 200, headers: { 'X-Origin': 'yes' } });
}

async function visit({ email, cookie, path = '/', token, ua = 'TestBrowser/1.0' } = {}) {
  const headers = { 'User-Agent': ua };
  if (email !== undefined) headers['Cf-Access-Jwt-Assertion'] = token ?? (await accessToken(email));
  else if (token) headers['Cf-Access-Jwt-Assertion'] = token;
  if (cookie) headers.Cookie = `${COOKIE_NAME}=${cookie}`;
  const request = new Request(`https://tlt.example.com${path}`, { headers });
  return handle(request, env, forward, deps);
}

function deviceCookie(response) {
  const setCookie = response.headers.get('Set-Cookie');
  if (!setCookie) return null;
  return readCookie(setCookie.split(';')[0], COOKIE_NAME);
}

// ---------------------------------------------------------------------------

test('first visit: binds the device, sets a secure cookie, serves the site', async () => {
  const res = await visit({ email: 'driver@example.com' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'SITE OK');
  assert.equal(res.headers.get('X-Origin'), 'yes', 'origin headers pass through');

  const setCookie = res.headers.get('Set-Cookie');
  assert.ok(setCookie, 'cookie is issued');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=31536000/);
  const id = deviceCookie(res);
  assert.match(id, /^[0-9a-f]{32}$/);

  const record = await kv.get('email:driver@example.com', 'json');
  assert.equal(record.devices.length, 1);
  assert.equal(record.devices[0].ua, 'TestBrowser/1.0');
  assert.ok(Date.parse(record.devices[0].firstSeen) > 0, 'firstSeen is a date');
  assert.notEqual(record.devices[0].hash, id, 'KV stores a hash, not the raw cookie');
  assert.equal(forwarded.length, 1);
});

test('same device: passes without a new cookie', async () => {
  const first = await visit({ email: 'driver@example.com' });
  const id = deviceCookie(first);

  const again = await visit({ email: 'driver@example.com', cookie: id, path: '/index.html?x=1' });
  assert.equal(again.status, 200);
  assert.equal(await again.text(), 'SITE OK');
  assert.equal(again.headers.get('Set-Cookie'), null);
  assert.equal(forwarded.length, 2);
  assert.equal(new URL(forwarded[1].url).pathname, '/index.html');
});

test('other device (foreign cookie or no cookie): 403 in Russian, nothing leaks', async () => {
  const first = await visit({ email: 'driver@example.com', ua: 'SecretPhone/9' });
  const id = deviceCookie(first);

  const noCookie = await visit({ email: 'driver@example.com' });
  assert.equal(noCookie.status, 403);
  const body = await noCookie.text();
  assert.match(body, /уже привязан к другому устройству\. Доступ разрешён только с одного устройства/);
  assert.doesNotMatch(body, /Виталию/);
  assert.doesNotMatch(body, /SecretPhone/);
  assert.doesNotMatch(body, new RegExp(id));
  assert.equal(noCookie.headers.get('Set-Cookie'), null, 'no cookie handed out on refusal');

  const wrongCookie = await visit({ email: 'driver@example.com', cookie: 'deadbeef'.repeat(4) });
  assert.equal(wrongCookie.status, 403);
  assert.equal(wrongCookie.headers.get('Set-Cookie'), null);

  assert.equal(forwarded.length, 1, 'site was never reached by the other device');
  const record = await kv.get('email:driver@example.com', 'json');
  assert.equal(record.devices.length, 1, 'binding unchanged');
});

test('a cookie chosen by the client is never adopted; the server mints its own', async () => {
  const chosen = 'c0ffee'.repeat(5) + 'aa';
  const res = await visit({ email: 'driver@example.com', cookie: chosen });
  assert.equal(res.status, 200);
  const issued = deviceCookie(res);
  assert.ok(issued, 'a fresh cookie is issued');
  assert.notEqual(issued, chosen);
  assert.equal((await visit({ email: 'driver@example.com', cookie: chosen })).status, 403);
  assert.equal((await visit({ email: 'driver@example.com', cookie: issued })).status, 200);
});

test('email is case-insensitive for the binding', async () => {
  const first = await visit({ email: 'Driver@Example.com' });
  const id = deviceCookie(first);
  const same = await visit({ email: 'driver@example.com', cookie: id });
  assert.equal(same.status, 200);
  const other = await visit({ email: 'DRIVER@example.com' });
  assert.equal(other.status, 403);
});

test('admin reset frees the email; the next device becomes the bound one', async () => {
  await visit({ email: 'driver@example.com' });
  assert.equal((await visit({ email: 'driver@example.com' })).status, 403);

  const reset = await visit({ email: ADMIN, path: '/admin/reset?email=Driver@example.com' });
  assert.equal(reset.status, 200);
  assert.match(await reset.text(), /удалена/);
  assert.equal(await kv.get('email:driver@example.com'), null);

  const fresh = await visit({ email: 'driver@example.com', ua: 'NewPhone/2' });
  assert.equal(fresh.status, 200);
  assert.ok(deviceCookie(fresh));
  const record = await kv.get('email:driver@example.com', 'json');
  assert.equal(record.devices[0].ua, 'NewPhone/2');

  const nothing = await visit({ email: ADMIN, path: '/admin/reset?email=nobody@example.com' });
  assert.equal(nothing.status, 200);
  assert.match(await nothing.text(), /не было/);

  const missing = await visit({ email: ADMIN, path: '/admin/reset' });
  assert.equal(missing.status, 400);
});

test('admin list shows emails with date and user agent', async () => {
  await visit({ email: 'a@example.com', ua: 'PhoneA' });
  await visit({ email: 'b@example.com', ua: 'PhoneB' });
  const res = await visit({ email: ADMIN, path: '/admin/list' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /a@example\.com/);
  assert.match(body, /b@example\.com/);
  assert.match(body, /PhoneA/);
  assert.match(body, /PhoneB/);
  assert.match(body, /\d{4}-\d{2}-\d{2}T/);
  assert.match(body, /reset\?email=a%40example\.com/);
  assert.equal(forwarded.length, 2, 'admin pages are served by the gate, not the site');
});

test('non-admin on /admin/*: 404, nothing happens', async () => {
  await visit({ email: 'victim@example.com' });
  const list = await visit({ email: 'driver@example.com', path: '/admin/list' });
  assert.equal(list.status, 404);
  assert.doesNotMatch(await list.text(), /victim/);

  const reset = await visit({ email: 'driver@example.com', path: '/admin/reset?email=victim@example.com' });
  assert.equal(reset.status, 404);
  assert.notEqual(await kv.get('email:victim@example.com'), null, 'binding survived');

  const anon = await visit({ path: '/admin/list' });
  assert.equal(anon.status, 403);
});

test('no email (no Access JWT): 403, site not reached, nothing stored', async () => {
  const res = await visit({});
  assert.equal(res.status, 403);
  assert.match(await res.text(), /войдите по коду/);
  assert.equal(forwarded.length, 0);
  assert.equal(kv.store.size, 0);
});

test('forged or stale JWT is rejected', async () => {
  const otherPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const forged = await signJwt(
    { iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: 'x@example.com', exp: Math.floor(Date.now() / 1000) + 3600 },
    { key: otherPair.privateKey },
  );
  assert.equal((await visit({ token: forged })).status, 403);

  const expired = await accessToken('x@example.com', { exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal((await visit({ token: expired })).status, 403);

  const wrongAud = await accessToken('x@example.com', { aud: ['someone-else'] });
  assert.equal((await visit({ token: wrongAud })).status, 403);

  const wrongIssuer = await accessToken('x@example.com', { iss: 'https://evil.cloudflareaccess.com' });
  assert.equal((await visit({ token: wrongIssuer })).status, 403);

  // A plain header without a JWT must not be trusted either.
  const headerOnly = new Request('https://tlt.example.com/', {
    headers: { 'Cf-Access-Authenticated-User-Email': ADMIN },
  });
  assert.equal((await handle(headerOnly, env, forward, deps)).status, 403);

  assert.equal(forwarded.length, 0);
  assert.equal(kv.store.size, 0);
});

test('403 page names the reason without leaking values', async () => {
  const codeOf = async (res) => (await res.text()).match(/Код: ([a-z-]+)\./)[1];
  assert.equal(await codeOf(await visit({})), 'no-token');
  assert.equal(await codeOf(await visit({ token: await accessToken('x@example.com', { aud: ['someone-else'] }) })), 'aud-mismatch');
  assert.equal(await codeOf(await visit({ token: await accessToken('x@example.com', { iss: 'https://evil.cloudflareaccess.com' }) })), 'team-domain-mismatch');
  assert.equal(await codeOf(await visit({ token: await accessToken('x@example.com', { exp: Math.floor(Date.now() / 1000) - 10 }) })), 'expired');
  const noAud = await handle(new Request('https://tlt.example.com/', { headers: { 'Cf-Access-Jwt-Assertion': await accessToken('x@example.com') } }), { ...env, ACCESS_AUD: '' }, forward, deps);
  assert.equal(await codeOf(noAud), 'no-aud');
  const body = await (await visit({ token: await accessToken('x@example.com', { aud: ['someone-else'] }) })).text();
  assert.ok(!body.includes(AUD) && !body.includes(TEAM));

  assert.equal(forwarded.length, 0);
  assert.equal(kv.store.size, 0);
});

test('DEVICE_LIMIT=2 lets a second device in and blocks the third', async () => {
  env.DEVICE_LIMIT = '2';
  const a = await visit({ email: 'driver@example.com', ua: 'A' });
  const b = await visit({ email: 'driver@example.com', ua: 'B' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const c = await visit({ email: 'driver@example.com', ua: 'C' });
  assert.equal(c.status, 403);

  assert.equal((await visit({ email: 'driver@example.com', cookie: deviceCookie(a) })).status, 200);
  assert.equal((await visit({ email: 'driver@example.com', cookie: deviceCookie(b) })).status, 200);
  const record = await kv.get('email:driver@example.com', 'json');
  assert.equal(record.devices.length, 2);
});
