// Small guards for the Worker and the Poll object, pure so the tests can
// check them: plain HTTP, the size of a request body, and how many live
// sockets one event keeps.

// What browsers are told on every HTTPS answer: only ever come back over
// HTTPS (for a year). The static files say the same in public/_headers.
export const HSTS = 'max-age=31536000';

const LOOPBACK = ['127.0.0.1', '::1'];

// A request that came in the clear from outside this machine: links carry
// secrets, so the app and the API are never served that way. (wrangler dev
// is plain http on loopback; in production Cloudflare sets cf-connecting-ip
// to the client's address, which is never loopback.)
export function plainHttp(url: URL, ip: string | null): boolean {
  return url.protocol === 'http:' && !LOOPBACK.includes(ip ?? '');
}

// The request's body as text, or null when it is longer than `max` bytes.
// Read piece by piece, so one that is too long (whatever its content-length
// says, if it has one) is dropped without being held in memory.
export async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

// One event keeps at most MAX_SOCKETS live sockets: every change does some
// work for each. At the limit a new one takes the place of the one heard from
// longest ago (those that never said hello first; `at` is when it last did,
// 0 for never). A page that is still there connects again by itself.
export const MAX_SOCKETS = 300;

// The sockets to close so that one more fits.
export function evict<T>(sockets: readonly T[], at: (s: T) => number, max = MAX_SOCKETS): T[] {
  const over = sockets.length - max + 1;
  if (over <= 0) return [];
  return sockets
    .map((s) => ({ s, at: at(s) }))
    .sort((a, b) => a.at - b.at)
    .slice(0, over)
    .map((x) => x.s);
}
