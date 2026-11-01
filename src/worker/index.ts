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
//   POST   /api/lookup                       { email, lang } -> { ok } (a code by email, see below)
//   POST   /api/lookup/code                  { email, code } -> { events: [{ id, name, admin?, me?, pid? }] }
//
// Email codes: asking answers { ok } whether or not the address is on any
// event (only then is a code made and mailed, after the reply), or 429
// { error: 'wait.minute' | 'wait.hour' | 'wait.day' } when a limit is
// reached (codes.ts). Mail goes by SMTP (mail.ts) with the secrets SMTP_USER
// and SMTP_PASS. In `wrangler dev --var MAIL_ECHO:1`, from this machine, nothing is
// mailed: the reply carries the code as `echo`, and x-dev-ip stands in for
// the client's IP, so the smoke test can run often.

import { connect } from 'cloudflare:sockets';
import { Poll } from './poll.ts';
import type { Cred, Failure } from './poll.ts';
import { Lookup } from './lookup.ts';
import { parse, PID_RE } from './link.ts';
import { cleanCode, dailyMax } from './codes.ts';
import { SMTP_HOST, SMTP_PORT, MAILABLE_RE, isMailLang, codeMail, sendMail, SmtpError } from './mail.ts';
import type { Mail } from './mail.ts';
import { sanitizeEvent, cleanEmail } from '../shared/model.ts';

export { Poll, Lookup };

// Secrets and dev vars, which `wrangler types` doesn't know about.
type Vars = { SMTP_USER?: string; SMTP_PASS?: string; MAIL_ECHO?: string };

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
const lookup = (env: Env) => env.LOOKUP.getByName('lookup');

// --- Email codes ---------------------------------------------------------------------------

// Dev only: the var and a request from this machine. (wrangler dev rewrites
// the URL and Host to the route's host, but cf-connecting-ip stays loopback;
// in production Cloudflare sets it to the client's address.)
const echoing = (req: Request, env: Env & Vars): boolean => env.MAIL_ECHO === '1' && ['127.0.0.1', '::1'].includes(req.headers.get('cf-connecting-ip') ?? '');
const clientIp = (req: Request, echo: boolean): string => (echo && req.headers.get('x-dev-ip')) || req.headers.get('cf-connecting-ip') || 'local';

async function mailLimited(env: Env, ip: string): Promise<boolean> {
  if (!env.MAIL_LIMIT) return false;
  const { success } = await env.MAIL_LIMIT.limit({ key: ip });
  return !success;
}

function lookupEmail(body: unknown): string {
  const e = cleanEmail(field(body, 'email'));
  if (!e.ok || !e.email || !MAILABLE_RE.test(e.email)) throw new HttpError(400, 'email');
  return e.email;
}

// After the reply (so known and unknown addresses answer alike). Failures go
// to the log with the step and the server's reply, never the address or code.
async function deliver(auth: { user: string; pass: string }, mail: Mail): Promise<void> {
  let socket: ReturnType<typeof connect> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    socket = connect({ hostname: SMTP_HOST, port: SMTP_PORT }, { secureTransport: 'on', allowHalfOpen: false });
    await Promise.race([
      sendMail(socket, auth, mail),
      new Promise((_, no) => {
        timer = setTimeout(() => no(new SmtpError('timeout', 0, '')), 20_000);
      }),
    ]);
    console.log('code mail sent');
  } catch (e) {
    console.error(e instanceof SmtpError ? e.message : `smtp: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
  } finally {
    if (timer !== null) clearTimeout(timer);
    socket?.close().catch(() => {});
  }
}

async function askCode(req: Request, env: Env & Vars, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson(req);
  const email = lookupEmail(body);
  const lang = isMailLang(field(body, 'lang')) ? (field(body, 'lang') as Parameters<typeof codeMail>[0]) : 'en';
  const echo = echoing(req, env);
  const auth = env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : null;
  if (!echo && !auth) throw new HttpError(503, 'mail');
  const ip = clientIp(req, echo);
  if (await mailLimited(env, ip)) throw new HttpError(429, 'rate');
  const r = await lookup(env).ask(email, ip, dailyMax(env.MAIL_DAILY_MAX));
  if ('wait' in r) throw new HttpError(429, `wait.${r.wait}`);
  if (r.code && echo) return json({ ok: true, echo: r.code });
  if (r.code && auth) ctx.waitUntil(deliver(auth, codeMail(lang, r.code, auth.user, email)));
  return json({ ok: true });
}

async function useCode(req: Request, env: Env & Vars): Promise<Response> {
  const body = await readJson(req);
  const email = lookupEmail(body);
  const code = cleanCode(field(body, 'code'));
  if (!code) throw new HttpError(400, 'code');
  if (await mailLimited(env, clientIp(req, echoing(req, env)))) throw new HttpError(429, 'rate');
  const r = await lookup(env).check(email, code);
  if (!r) throw new HttpError(400, 'code');
  const found = await Promise.all(
    r.events.map(async (id) => {
      const links = await stub(env, id).linksFor(email);
      return links ? { id, ...links } : null;
    }),
  );
  return json({ events: found.filter((x) => x !== null) });
}

// --- Routes --------------------------------------------------------------------------------

async function route(req: Request, env: Env & Vars, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(req.url);
  const method = req.method;

  if (pathname === '/api/lookup' || pathname === '/api/lookup/code') {
    if (method !== 'POST') throw new HttpError(405, 'method');
    return pathname === '/api/lookup' ? askCode(req, env, ctx) : useCode(req, env);
  }

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
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (await limited(req, env)) return json({ error: 'rate' }, 429);
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'server' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
