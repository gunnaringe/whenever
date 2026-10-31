// API. Static files never reach this Worker (see run_worker_first in
// wrangler.jsonc). Admin and personal links travel as
// `Authorization: Bearer <token>`; the Poll object checks them (src/link.js).
//
//   POST   /api/events                       { event, email? } -> { id, token, view }
//   GET    /api/events/:id                   -> { view }
//   PUT    /api/events/:id                   { event, email? } (admin) -> { view }
//   DELETE /api/events/:id                   (admin) -> { ok }
//   POST   /api/events/:id/admin-link        (admin) new admin link -> { token }
//   POST   /api/events/:id/people            { name, email?, comment?, answers } -> { pid, token, view }
//   PUT    /api/events/:id/people/:pid       entry -> { view }
//   DELETE /api/events/:id/people/:pid       -> { view }
//   POST   /api/events/:id/people/:pid/link  { reset? } (self or admin) -> { token }

import { Poll } from './poll.ts';
import type { Cred, Failure } from './poll.ts';
import { parse, PID_RE } from './link.ts';
import { sanitizeEvent, cleanEmail } from '../shared/model.ts';

export { Poll };

const ID_RE = /^[A-Za-z0-9]{12}$/;
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MAX_BODY = 256 * 1024;
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers: HEADERS });

class HttpError extends Error {
  status: number;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

// 12 characters of base62 (~71 bits); rejection sampling keeps it uniform.
function newId(): string {
  let out = '';
  while (out.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && out.length < 12) out += ID_ALPHABET[b % 62];
    }
  }
  return out;
}

async function limited(req: Request, env: Env): Promise<boolean> {
  if (!env.LIMIT) return false;
  const key = req.headers.get('cf-connecting-ip') ?? 'local';
  const { success } = await env.LIMIT.limit({ key });
  return !success;
}

// JSON only: a cross-site form or simple fetch can't send it without a preflight.
async function readJson(req: Request): Promise<unknown> {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) throw new HttpError(415, 'type');
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw new HttpError(413, 'size');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'size');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'json');
  }
}

function credential(req: Request): Cred {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!m) return null;
  return parse(m[1]) ?? { bad: true };
}

const failed = (r: object): r is Failure => typeof (r as Partial<Failure>).error === 'string';
const send = (r: object): Response => (failed(r) ? json({ error: r.error }, r.status) : json(r));

// body.k, or undefined when the body isn't an object.
const field = (body: unknown, k: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[k] : undefined);

function event(body: unknown) {
  const r = sanitizeEvent(field(body, 'event'));
  if (!r.ok) throw new HttpError(400, r.error);
  return r.event;
}

function adminEmail(body: unknown, optional: boolean): string | undefined {
  if (optional && field(body, 'email') === undefined) return undefined;
  const e = cleanEmail(field(body, 'email'));
  if (!e.ok) throw new HttpError(400, 'email');
  return e.email;
}

const stub = (env: Env, id: string) => env.POLLS.get(env.POLLS.idFromName(id));

async function route(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  const method = req.method;

  if (pathname === '/api/events') {
    if (method !== 'POST') throw new HttpError(405, 'method');
    const body = await readJson(req);
    const ev = event(body);
    const email = adminEmail(body, false) ?? '';
    for (let i = 0; i < 5; i++) {
      const id = newId();
      const made = await stub(env, id).create(ev, email);
      if (made) return json({ id, ...made });
    }
    throw new HttpError(503, 'busy');
  }

  const m = pathname.match(/^\/api\/events\/([^/]+)(?:\/(admin-link|people)(?:\/([^/]+)(\/link)?)?)?$/);
  if (!m || !ID_RE.test(m[1])) throw new HttpError(404, 'notFound');
  const [, id, sub, pid, linkPath] = m;
  if (pid !== undefined && !PID_RE.test(pid)) throw new HttpError(404, 'person');
  const cred = credential(req);
  const poll = stub(env, id);

  if (!sub) {
    if (method === 'GET') return send(await poll.get(cred));
    if (method === 'PUT') {
      const body = await readJson(req);
      return send(await poll.update(cred, event(body), adminEmail(body, true)));
    }
    if (method === 'DELETE') return send(await poll.destroy(cred));
    throw new HttpError(405, 'method');
  }

  if (sub === 'admin-link') {
    if (method !== 'POST' || pid) throw new HttpError(405, 'method');
    return send(await poll.resetAdmin(cred));
  }

  // people
  if (!pid) {
    if (method !== 'POST') throw new HttpError(405, 'method');
    return send(await poll.add(cred, await readJson(req)));
  }
  if (linkPath) {
    if (method !== 'POST') throw new HttpError(405, 'method');
    const body = await readJson(req);
    return send(await poll.link(cred, pid, field(body, 'reset') === true));
  }
  if (method === 'PUT') return send(await poll.edit(cred, pid, await readJson(req)));
  if (method === 'DELETE') return send(await poll.drop(cred, pid));
  throw new HttpError(405, 'method');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      if (await limited(req, env)) return json({ error: 'rate' }, 429);
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'server' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
