// Cloudflare Pages Function: runs on the same hostname as the site, after
// Cloudflare Access. All logic lives in worker/src/index.js; here we only
// hand it the request and tell it how to reach the static files (next()).
import { handle } from '../worker/src/index.js';

export async function onRequest(context) {
  return handle(context.request, context.env, () => context.next());
}
