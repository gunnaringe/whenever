// One event: its settings and every participant's answers, in SQLite.
//
//   meta(k, v)   'created', 'event' (JSON), 'adminId', 'adminSecret',
//                'adminEmails' (JSON list; events made before it have one
//                'adminEmail'), 'indexed'
//   people(...)  one row per entry; secret is their link's (see link.ts);
//                replied 0 for a name the organisers listed (invite()) that
//                hasn't answered yet (rows from before it existed are 1)
//
// Listed names: the organisers can list who they expect, so the page shows
// "6 of 15 have answered" and who is missing. Each name is an entry with no
// answers and replied 0, and its own personal link from the start. Any save
// of the entry answers (even with nothing marked: that is "can't make any",
// not "hasn't answered"). The view's `people` are only those who answered,
// so the results never count a name that is waiting; `waiting` lists the
// others, but with hidden answers only to the admin (who hasn't answered
// tells who has). Someone answering with the event link can say which listed
// name they are (`claim` in add()): that entry gets their answers and a new
// secret, so a link sent to that person before stops working, and nobody
// gets another's link from the event link alone. Not when the answers are
// hidden.
//
// Drafts: saving with `draft: true` keeps the answers but leaves (or puts)
// the entry among those who haven't answered, so nothing counts them. There
// is no third state: a draft is only what the form shows when it is opened
// again, so the view sends a waiting entry's answers only to those who may
// change it (canEdit: its person, the admin, everyone with openEdit).
// Only the admin, or its own person, removes a waiting entry: the list is the
// organisers'.
//
// The admin link is no person: whoever has it can do everything, and several
// organisers may share it. It adds and changes anyone's entry, an
// organiser's own too, but never with an email: only its person may set that
// (with the entry's personal link). Every one of the organisers' addresses
// gets the admin link back by email.
// (Events from before kept the organiser's own entry in 'adminPid'; it is
// ignored now.)
//
// The Worker passes the caller's link as `cred`: null (no link), { bad: true }
// (not shaped like a link) or { sel, secret }. Everything about who may do
// what is decided here, and links are made here.
// Methods return data, or { error, status } for the Worker to send.
// Storage is wiped by an alarm 30 days after the event's last date.
//
// Live updates: GET /api/events/:id/live is a WebSocket to this object
// (fetch()), held with the hibernation API, so an idle one costs nothing and
// stays open across deploys. The page sends its link as the first message,
// {"token": "<token>" | null}, never in the URL, and again whenever it wants
// a fresh view (at most every 2 s). After every change each socket gets its
// own view (who(), checked again each time, so a replaced link gets no more
// than a visitor), and the app's version, so an open page knows when a new
// one is live. "ping" gets "pong" without waking the object.
//
// The email index (lookup.ts) learns which addresses this event has after
// every change to them, and that they are gone when the event is. That call
// comes last, after the event's own writes, and a failure never fails the
// change: meta 'indexed' stays unset and the next get() tries again (which is
// also how events made before the index got into it).

import { DurableObject } from 'cloudflare:workers';
import { LIMITS, sanitizeEntry, cleanAnswers, cleanNames, canAdd, canEdit, expiresAt, nameKey } from '../shared/model.ts';
import type { Added, Created, Entry, LinkState, LiveMessage, Person, PollEvent, View, Waiting, Who } from '../shared/model.ts';
import { newPid, newSecret, token, same, parse } from './link.ts';
import type { Credential } from './link.ts';
import type { EventPreview } from './preview.ts';

// What the Worker makes of the Authorization header.
export type Cred = Credential | { bad: true } | null;
export interface Failure {
  error: string;
  status: number;
}

const NOT_FOUND: Failure = { error: 'notFound', status: 404 };
const FORBIDDEN: Failure = { error: 'forbidden', status: 403 };
const NO_PERSON: Failure = { error: 'person', status: 404 };
// An event whose dates are already past still lives a week.
const MIN_LIFE = 7 * 24 * 60 * 60 * 1000;
const deleteAt = (ev: PollEvent) => Math.max(expiresAt(ev), Date.now() + MIN_LIFE);
const lookup = (env: Env) => env.LOOKUP.getByName('lookup');
const visitor = (link: LinkState): Who => ({ role: 'visitor', me: null, link });
const TAKEN: Failure = { error: 'taken', status: 409 };
const ANSWERED: Failure = { error: 'answered', status: 409 };

// A live socket's state (serializeAttachment): the link it sent, if it has
// sent one yet, and when, for the 2 s limit.
interface Live {
  hello: boolean;
  cred: Cred;
  at: number;
}
const HELLO_EVERY = 2000;

// The version of the app that is live: the hash in index.html's script name
// (scripts/build.mjs). Read once per isolate; a deploy brings a new one.
let appVersion: Promise<string> | null = null;
function liveApp(env: Env): Promise<string> {
  appVersion ??= env.ASSETS.fetch('https://assets.local/')
    .then((r) => r.text())
    .then((html) => /\/app-([A-Za-z0-9]+)\.js/.exec(html)?.[1] ?? '')
    .catch(() => {
      appVersion = null;
      return '';
    });
  return appVersion;
}

type PersonRow = {
  id: string;
  name: string;
  comment: string;
  email: string;
  answers: string;
  updated: number;
  replied: number;
};

export class Poll extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // Events from before listed names: their people have all answered. Only
    // reads where there is no event, so a wrong id still leaves no storage.
    const t = this.sql.exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'people'`).toArray()[0];
    if (t && !/\breplied\b/.test(t.sql)) this.sql.exec(`ALTER TABLE people ADD COLUMN replied INTEGER NOT NULL DEFAULT 1`);
  }

  tables() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      name TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      secret TEXT NOT NULL,
      answers TEXT NOT NULL,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      replied INTEGER NOT NULL DEFAULT 1
    )`);
  }

  // Never creates tables, so probing a wrong id leaves no storage behind.
  exists(): boolean {
    const t = this.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).toArray();
    return t.length > 0 && this.getMeta('created') !== null;
  }

  getMeta(k: string): string | null {
    const rows = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k).toArray();
    return rows.length ? rows[0].v : null;
  }

  setMeta(k: string, v: string | number): void {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v));
  }

  event(): PollEvent {
    return JSON.parse(this.getMeta('event') ?? 'null') as PollEvent;
  }

  who(cred: Cred): Who {
    if (!cred) return visitor('none');
    if ('bad' in cred) return visitor('invalid');
    if (cred.sel === this.getMeta('adminId')) {
      return same(cred.secret, this.getMeta('adminSecret')) ? this.admin() : visitor('invalid');
    }
    const row = this.sql.exec<{ secret: string }>(`SELECT secret FROM people WHERE id = ?`, cred.sel).toArray()[0];
    return row && same(cred.secret, row.secret) ? { role: 'participant', me: cred.sel, link: 'ok' } : visitor('invalid');
  }

  admin(): Who {
    return { role: 'admin', me: null, link: 'ok' };
  }

  adminEmails(): string[] {
    const list = this.getMeta('adminEmails');
    if (list !== null) return JSON.parse(list) as string[];
    const one = this.getMeta('adminEmail');
    return one ? [one] : [];
  }

  setAdminEmails(emails: string[]): void {
    this.setMeta('adminEmails', JSON.stringify(emails));
    this.sql.exec(`DELETE FROM meta WHERE k = 'adminEmail'`);
  }

  // What the caller gets to see. Emails are only ever returned to their owner
  // (and the organisers' to the admin).
  view(who: Who): View {
    const ev = this.event();
    const rows = this.sql.exec<PersonRow>(`SELECT id, name, comment, email, answers, updated, replied FROM people ORDER BY seq`).toArray();
    const hidden = ev.settings.hidden && who.role !== 'admin';
    const people: Person[] = [];
    const waiting: Waiting[] = [];
    let count = 0;
    for (const r of rows) {
      if (r.replied) count += 1;
      if (hidden && r.id !== who.me) continue;
      if (!r.replied) {
        const w: Waiting = { id: r.id, name: r.name };
        // The draft, for those who may change it (see the top).
        if (canEdit(who, ev.settings, r.id)) {
          const answers = JSON.parse(r.answers) as Person['answers'];
          if (Object.keys(answers).length || r.comment) Object.assign(w, { answers, comment: r.comment });
        }
        if (r.id === who.me) w.email = r.email;
        waiting.push(w);
        continue;
      }
      const p: Person = { id: r.id, name: r.name, comment: r.comment, answers: JSON.parse(r.answers), updated: r.updated };
      if (r.id === who.me) p.email = r.email;
      people.push(p);
    }
    const out: View = {
      event: ev,
      role: who.role,
      me: who.me,
      link: who.link,
      people,
      count,
      waiting,
      waitingCount: rows.length - count,
      hidden,
      rev: Number(this.getMeta('rev') ?? 0),
    };
    if (who.role === 'admin') out.adminEmails = this.adminEmails();
    return out;
  }

  // --- RPC from the Worker ------------------------------------------------------

  async create(event: PollEvent, emails: string[]): Promise<Omit<Created, 'id'> | null> {
    if (this.exists()) return null;
    this.tables();
    const adminId = newPid();
    const secret = newSecret();
    this.setMeta('event', JSON.stringify(event));
    this.setMeta('adminId', adminId);
    this.setMeta('adminSecret', secret);
    this.setAdminEmails(emails);
    this.setMeta('created', Date.now());
    await this.ctx.storage.setAlarm(deleteAt(event));
    const out = { token: token(adminId, secret), view: this.view(this.admin()) };
    await this.reindex();
    return out;
  }

  async get(cred: Cred): Promise<Failure | { view: View }> {
    if (!this.exists()) return NOT_FOUND;
    if (this.getMeta('indexed') !== '1') await this.reindex();
    return { view: this.view(this.who(cred)) };
  }

  // What a link preview of /e/<id> shows (preview.ts): only what any visitor
  // sees. Reads and changes nothing else, so a wrong id leaves no storage.
  preview(): EventPreview | null {
    if (!this.exists()) return null;
    const ev = this.event();
    return { name: ev.name, description: ev.description, mode: ev.mode, closed: ev.settings.closed };
  }

  // The links an address has here (admin and/or personal), for the email
  // code; null when the event is gone. Compares the stored addresses, so an
  // index entry that is out of date brings nothing.
  linksFor(email: string): { name: string; admin?: string; me?: string; pid?: string } | null {
    if (!this.exists() || !email) return null;
    const out: { name: string; admin?: string; me?: string; pid?: string } = { name: this.event().name };
    if (this.adminEmails().includes(email)) out.admin = token(this.getMeta('adminId') ?? '', this.getMeta('adminSecret') ?? '');
    const p = this.sql.exec<{ id: string; secret: string }>(`SELECT id, secret FROM people WHERE email = ? ORDER BY updated DESC LIMIT 1`, email).toArray()[0];
    if (p) {
      out.me = token(p.id, p.secret);
      out.pid = p.id;
    }
    return out.admin || out.me ? out : null;
  }

  // Tell the index which addresses this event has now, and until when.
  async reindex(): Promise<void> {
    const id = this.ctx.id.name;
    if (!id || !this.exists()) return;
    this.setMeta('indexed', '0');
    const emails = new Set<string>(this.adminEmails());
    for (const r of this.sql.exec<{ email: string }>(`SELECT DISTINCT email FROM people WHERE email != ''`).toArray()) emails.add(r.email);
    const until = (await this.ctx.storage.getAlarm()) ?? deleteAt(this.event());
    try {
      await lookup(this.env).index(id, [...emails], until);
      if (this.exists()) this.setMeta('indexed', '1');
    } catch (e) {
      console.error('index:', e instanceof Error ? e.message : String(e));
    }
  }

  // The event is gone: so are its index entries (they also expire on their own).
  async unindex(): Promise<void> {
    const id = this.ctx.id.name;
    if (!id) return;
    try {
      await lookup(this.env).index(id, [], 0);
    } catch (e) {
      console.error('unindex:', e instanceof Error ? e.message : String(e));
    }
  }

  // emails: the organisers' new list, or undefined to keep it.
  async update(cred: Cred, event: PollEvent, emails: string[] | undefined): Promise<Failure | { view: View }> {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    if (who.role !== 'admin') return FORBIDDEN;
    this.setMeta('event', JSON.stringify(event));
    if (emails !== undefined) this.setAdminEmails(emails);
    // Answers to dates or times that are no longer offered are dropped.
    for (const r of this.sql.exec<{ id: string; answers: string }>(`SELECT id, answers FROM people`).toArray()) {
      const a = JSON.stringify(cleanAnswers(JSON.parse(r.answers), event));
      if (a !== r.answers) this.sql.exec(`UPDATE people SET answers = ? WHERE id = ?`, a, r.id);
    }
    await this.ctx.storage.setAlarm(deleteAt(event));
    this.bump();
    const out = { view: this.view(who) };
    await this.reindex();
    await this.push();
    return out;
  }

  async destroy(cred: Cred): Promise<Failure | { ok: true }> {
    if (!this.exists()) return NOT_FOUND;
    if (this.who(cred).role !== 'admin') return FORBIDDEN;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.gone();
    await this.unindex();
    return { ok: true };
  }

  async add(cred: Cred, input: unknown): Promise<Failure | Added> {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    const ev = this.event();
    if (!canAdd(who, ev.settings)) return { error: 'closed', status: 403 };
    const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    // An entry added with the admin link gets no email (see the top).
    const own = who.role !== 'admin';
    const r = sanitizeEntry({ ...o, email: own ? o.email ?? '' : '' }, ev);
    if (!r.ok) return { error: r.error, status: 400 };
    const replied = o.draft === true ? 0 : 1;
    if (o.claim !== undefined && o.claim !== null) return this.claim(who, ev, String(o.claim), r.entry, replied);
    const { n, seq } = this.sql.exec<{ n: number; seq: number }>(`SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS seq FROM people`).one();
    if (n >= LIMITS.people) return { error: 'full', status: 409 };
    let pid = newPid();
    while (pid === this.getMeta('adminId') || this.sql.exec(`SELECT 1 FROM people WHERE id = ?`, pid).toArray().length) pid = newPid();
    const secret = newSecret();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO people (id, seq, name, comment, email, secret, answers, created, updated, replied) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pid, seq + 1, r.entry.name, r.entry.comment, r.entry.email ?? '', secret, JSON.stringify(r.entry.answers), now, now, replied,
    );
    // An admin adding an entry stays admin; anyone else is now that participant.
    const viewer: Who = who.role === 'admin' ? who : { role: 'participant', me: pid, link: 'ok' };
    this.bump();
    const out = { pid, token: token(pid, secret), view: this.view(viewer) };
    if (r.entry.email) await this.reindex();
    await this.push();
    return out;
  }

  // Someone with the event link answers as a name the organisers listed
  // (see the top): only a name still waiting, never with hidden answers, and
  // only someone who isn't anyone here yet (the admin edits the entry).
  async claim(who: Who, ev: PollEvent, pid: string, entry: Entry, replied: number): Promise<Failure | Added> {
    if (who.role !== 'visitor' || ev.settings.hidden) return FORBIDDEN;
    const row = this.sql.exec<{ replied: number }>(`SELECT replied FROM people WHERE id = ?`, pid).toArray()[0];
    if (!row) return NO_PERSON;
    if (row.replied) return TAKEN;
    const secret = newSecret();
    this.sql.exec(
      `UPDATE people SET name = ?, comment = ?, email = ?, answers = ?, secret = ?, replied = ?, updated = ? WHERE id = ?`,
      entry.name, entry.comment, entry.email ?? '', JSON.stringify(entry.answers), secret, replied, Date.now(), pid,
    );
    this.bump();
    const out = { pid, token: token(pid, secret), view: this.view({ role: 'participant', me: pid, link: 'ok' }) };
    if (entry.email) await this.reindex();
    await this.push();
    return out;
  }

  // The organisers list who they expect (see the top). Names already here,
  // answered or not, are skipped; all or nothing within LIMITS.people.
  async invite(cred: Cred, input: unknown): Promise<Failure | { view: View; added: number; skipped: number }> {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    if (who.role !== 'admin') return FORBIDDEN;
    const names = cleanNames(input);
    if (!names.length) return { error: 'names', status: 400 };
    const have = new Set(this.sql.exec<{ name: string }>(`SELECT name FROM people`).toArray().map((r) => nameKey(r.name)));
    const fresh = names.filter((x) => !have.has(nameKey(x)));
    let { n, seq } = this.sql.exec<{ n: number; seq: number }>(`SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS seq FROM people`).one();
    if (n + fresh.length > LIMITS.people) return { error: 'tooManyNames', status: 409 };
    const now = Date.now();
    for (const name of fresh) {
      let pid = newPid();
      while (pid === this.getMeta('adminId') || this.sql.exec(`SELECT 1 FROM people WHERE id = ?`, pid).toArray().length) pid = newPid();
      seq += 1;
      n += 1;
      this.sql.exec(
        `INSERT INTO people (id, seq, name, comment, email, secret, answers, created, updated, replied) VALUES (?, ?, ?, '', '', ?, '{}', ?, ?, 0)`,
        pid, seq, name, newSecret(), now, now,
      );
    }
    if (fresh.length) this.bump();
    const out = { view: this.view(who), added: fresh.length, skipped: names.length - fresh.length };
    if (fresh.length) await this.push();
    return out;
  }

  async edit(cred: Cred, pid: string, input: unknown): Promise<Failure | { view: View }> {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    const ev = this.event();
    const row = this.sql.exec<{ email: string; replied: number }>(`SELECT email, replied FROM people WHERE id = ?`, pid).toArray()[0];
    if (!row) return NO_PERSON;
    if (!canEdit(who, ev.settings, pid)) return FORBIDDEN;
    // Only the person themself sees or changes their email.
    const own = who.me === pid;
    const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    // Someone answering for a listed name (waiting: true) never overwrites
    // what that person has answered themself meanwhile.
    if (o.waiting === true && row.replied && !own) return ANSWERED;
    const r = sanitizeEntry({ ...o, email: own ? o.email ?? '' : undefined }, ev);
    if (!r.ok) return { error: r.error, status: 400 };
    // Saving answers counts them, even with nothing marked; a draft keeps
    // them without (see the top).
    this.sql.exec(
      `UPDATE people SET name = ?, comment = ?, answers = ?, replied = ?, updated = ? WHERE id = ?`,
      r.entry.name, r.entry.comment, JSON.stringify(r.entry.answers), o.draft === true ? 0 : 1, Date.now(), pid,
    );
    if (own) this.sql.exec(`UPDATE people SET email = ? WHERE id = ?`, r.entry.email ?? '', pid);
    this.bump();
    const out = { view: this.view(who) };
    if (own) await this.reindex();
    await this.push();
    return out;
  }

  async drop(cred: Cred, pid: string): Promise<Failure | { view: View }> {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    const ev = this.event();
    const row = this.sql.exec<{ email: string; replied: number }>(`SELECT email, replied FROM people WHERE id = ?`, pid).toArray()[0];
    if (!row) return NO_PERSON;
    if (!canEdit(who, ev.settings, pid)) return FORBIDDEN;
    // Waiting names are the organisers' list (see the top).
    if (!row.replied && who.role !== 'admin' && who.me !== pid) return FORBIDDEN;
    this.sql.exec(`DELETE FROM people WHERE id = ?`, pid);
    // A participant who deleted their own entry has no link left; the admin stays admin.
    const viewer = who.role === 'admin' ? this.admin() : who.me === pid ? visitor('none') : who;
    this.bump();
    const out = { view: this.view(viewer) };
    if (row.email) await this.reindex();
    await this.push();
    return out;
  }

  // A participant's link: for themself or the admin. reset = invalidate the old one.
  link(cred: Cred, pid: string, reset: boolean): Failure | { token: string } {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    if (!(who.role === 'admin' || who.me === pid)) return FORBIDDEN;
    const row = this.sql.exec<{ secret: string }>(`SELECT secret FROM people WHERE id = ?`, pid).toArray()[0];
    if (!row) return NO_PERSON;
    let secret = row.secret;
    if (reset) {
      secret = newSecret();
      this.sql.exec(`UPDATE people SET secret = ? WHERE id = ?`, secret, pid);
    }
    return { token: token(pid, secret) };
  }

  resetAdmin(cred: Cred): Failure | { token: string } {
    if (!this.exists()) return NOT_FOUND;
    if (this.who(cred).role !== 'admin') return FORBIDDEN;
    const secret = newSecret();
    this.setMeta('adminSecret', secret);
    return { token: token(this.getMeta('adminId') ?? '', secret) };
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.gone();
    await this.unindex();
  }

  // --- Live updates (see the top) ----------------------------------------------------

  bump(): void {
    this.setMeta('rev', Number(this.getMeta('rev') ?? 0) + 1);
  }

  override async fetch(req: Request): Promise<Response> {
    if ((req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return Response.json({ error: 'upgrade' }, { status: 426 });
    if (!this.exists()) return Response.json({ error: 'notFound' }, { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ hello: false, cred: null, at: 0 } satisfies Live);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const live = ws.deserializeAttachment() as Live | null;
    const now = Date.now();
    if (typeof message !== 'string' || message.length > 200 || !live || now - live.at < HELLO_EVERY) return;
    let tok: unknown;
    try {
      tok = (JSON.parse(message) as { token?: unknown }).token;
    } catch {
      return;
    }
    const cred: Cred = tok === null || tok === undefined ? null : (parse(tok) ?? { bad: true });
    ws.serializeAttachment({ hello: true, cred, at: now } satisfies Live);
    if (!this.exists()) return this.gone();
    ws.send(JSON.stringify({ type: 'view', view: this.view(this.who(cred)), app: await liveApp(this.env) } satisfies LiveMessage));
  }

  // After a change: every socket that has said hello gets its own view.
  // Sockets with the same role, entry and link state get the same text.
  async push(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const app = await liveApp(this.env);
    const sent = new Map<string, string>();
    for (const ws of sockets) {
      const live = ws.deserializeAttachment() as Live | null;
      if (!live?.hello) continue;
      const who = this.who(live.cred);
      const key = `${who.role} ${who.me} ${who.link}`;
      let text = sent.get(key);
      if (text === undefined) {
        text = JSON.stringify({ type: 'view', view: this.view(who), app } satisfies LiveMessage);
        sent.set(key, text);
      }
      try {
        ws.send(text);
      } catch {
        // Closing already; the page reconnects or falls back.
      }
    }
  }

  // The event is deleted: tell every socket, and close it.
  gone(): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: 'gone' } satisfies LiveMessage));
        ws.close(1000, 'gone');
      } catch {
        // Already closed.
      }
    }
  }
}
