// One event: its settings and every participant's answers, in SQLite.
//
//   meta(k, v)   'created', 'event' (JSON), 'adminId', 'adminSecret', 'adminEmail',
//                'adminPid' (the admin's own entry, if they marked one), 'indexed'
//   people(...)  one row per entry; secret is their link's (see link.ts)
//
// With the admin link the admin is also the participant 'adminPid': `me` in
// their view, so they see and set that entry's email. An email they set there
// becomes the admin email too while that is empty (only through the admin
// link: the entry's own personal link must never lead to the admin link).
//
// The Worker passes the caller's link as `cred`: null (no link), { bad: true }
// (not shaped like a link) or { sel, secret }. Everything about who may do
// what is decided here, and links are made here.
// Methods return data, or { error, status } for the Worker to send.
// Storage is wiped by an alarm 30 days after the event's last date.
//
// The email index (lookup.ts) learns which addresses this event has after
// every change to them, and that they are gone when the event is. That call
// comes last, after the event's own writes, and a failure never fails the
// change: meta 'indexed' stays unset and the next get() tries again (which is
// also how events made before the index got into it).

import { DurableObject } from 'cloudflare:workers';
import { LIMITS, sanitizeEntry, cleanAnswers, canAdd, canEdit, expiresAt } from '../shared/model.ts';
import type { Added, Created, LinkState, Person, PollEvent, View, Who } from '../shared/model.ts';
import { newPid, newSecret, token, same } from './link.ts';
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

type PersonRow = {
  id: string;
  name: string;
  comment: string;
  email: string;
  answers: string;
  updated: number;
};

export class Poll extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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
      updated INTEGER NOT NULL
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
    return { role: 'admin', me: this.getMeta('adminPid'), link: 'ok' };
  }

  // What the caller gets to see. Emails are only ever returned to their owner
  // (and the admin's own email to the admin).
  view(who: Who): View {
    const ev = this.event();
    const rows = this.sql.exec<PersonRow>(`SELECT id, name, comment, email, answers, updated FROM people ORDER BY seq`).toArray();
    const hidden = ev.settings.hidden && who.role !== 'admin';
    const people: Person[] = [];
    for (const r of rows) {
      if (hidden && r.id !== who.me) continue;
      const p: Person = { id: r.id, name: r.name, comment: r.comment, answers: JSON.parse(r.answers), updated: r.updated };
      if (r.id === who.me) p.email = r.email;
      people.push(p);
    }
    const out: View = { event: ev, role: who.role, me: who.me, link: who.link, people, count: rows.length, hidden };
    if (who.role === 'admin') out.adminEmail = this.getMeta('adminEmail') ?? '';
    return out;
  }

  // --- RPC from the Worker ------------------------------------------------------

  async create(event: PollEvent, email: string): Promise<Omit<Created, 'id'> | null> {
    if (this.exists()) return null;
    this.tables();
    const adminId = newPid();
    const secret = newSecret();
    this.setMeta('event', JSON.stringify(event));
    this.setMeta('adminId', adminId);
    this.setMeta('adminSecret', secret);
    this.setMeta('adminEmail', email || '');
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
    if (this.getMeta('adminEmail') === email) out.admin = token(this.getMeta('adminId') ?? '', this.getMeta('adminSecret') ?? '');
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
    const emails = new Set<string>();
    const admin = this.getMeta('adminEmail');
    if (admin) emails.add(admin);
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

  async update(cred: Cred, event: PollEvent, adminEmail: string | undefined): Promise<Failure | { view: View }> {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    if (who.role !== 'admin') return FORBIDDEN;
    this.setMeta('event', JSON.stringify(event));
    if (adminEmail !== undefined) this.setMeta('adminEmail', adminEmail);
    // Answers to dates or times that are no longer offered are dropped.
    for (const r of this.sql.exec<{ id: string; answers: string }>(`SELECT id, answers FROM people`).toArray()) {
      const a = JSON.stringify(cleanAnswers(JSON.parse(r.answers), event));
      if (a !== r.answers) this.sql.exec(`UPDATE people SET answers = ? WHERE id = ?`, a, r.id);
    }
    await this.ctx.storage.setAlarm(deleteAt(event));
    const out = { view: this.view(who) };
    await this.reindex();
    return out;
  }

  async destroy(cred: Cred): Promise<Failure | { ok: true }> {
    if (!this.exists()) return NOT_FOUND;
    if (this.who(cred).role !== 'admin') return FORBIDDEN;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.unindex();
    return { ok: true };
  }

  async add(cred: Cred, input: unknown): Promise<Failure | Added> {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    const ev = this.event();
    if (!canAdd(who, ev.settings)) return { error: 'closed', status: 403 };
    const { n, seq } = this.sql.exec<{ n: number; seq: number }>(`SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS seq FROM people`).one();
    if (n >= LIMITS.people) return { error: 'full', status: 409 };
    const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    // The admin adds their own entry (own: true) or one for someone else,
    // which gets no email: only its person may set that.
    const own = who.role !== 'admin' || o.own === true;
    const r = sanitizeEntry({ ...o, email: own ? o.email ?? '' : '' }, ev);
    if (!r.ok) return { error: r.error, status: 400 };
    let pid = newPid();
    while (pid === this.getMeta('adminId') || this.sql.exec(`SELECT 1 FROM people WHERE id = ?`, pid).toArray().length) pid = newPid();
    const secret = newSecret();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO people (id, seq, name, comment, email, secret, answers, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pid, seq + 1, r.entry.name, r.entry.comment, r.entry.email ?? '', secret, JSON.stringify(r.entry.answers), now, now,
    );
    // An admin adding an entry stays admin; anyone else is now that participant.
    let viewer: Who = { role: 'participant', me: pid, link: 'ok' };
    if (who.role === 'admin') {
      if (own) {
        this.setMeta('adminPid', pid);
        this.adoptEmail(r.entry.email ?? '');
      }
      viewer = this.admin();
    }
    const out = { pid, token: token(pid, secret), view: this.view(viewer) };
    if (r.entry.email) await this.reindex();
    return out;
  }

  async edit(cred: Cred, pid: string, input: unknown): Promise<Failure | { view: View }> {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    const ev = this.event();
    const row = this.sql.exec<{ email: string }>(`SELECT email FROM people WHERE id = ?`, pid).toArray()[0];
    if (!row) return NO_PERSON;
    if (!canEdit(who, ev.settings, pid)) return FORBIDDEN;
    // Only the person themself sees or changes their email.
    const own = who.me === pid;
    const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const r = sanitizeEntry({ ...o, email: own ? o.email ?? '' : undefined }, ev);
    if (!r.ok) return { error: r.error, status: 400 };
    this.sql.exec(`UPDATE people SET name = ?, comment = ?, answers = ?, updated = ? WHERE id = ?`, r.entry.name, r.entry.comment, JSON.stringify(r.entry.answers), Date.now(), pid);
    if (own) this.sql.exec(`UPDATE people SET email = ? WHERE id = ?`, r.entry.email ?? '', pid);
    // Only an address the admin typed in now, not one already on the entry.
    if (own && who.role === 'admin' && r.entry.email !== row.email) this.adoptEmail(r.entry.email ?? '');
    const out = { view: this.view(who) };
    if (own) await this.reindex();
    return out;
  }

  async drop(cred: Cred, pid: string): Promise<Failure | { view: View }> {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    const ev = this.event();
    const row = this.sql.exec<{ email: string }>(`SELECT email FROM people WHERE id = ?`, pid).toArray()[0];
    if (!row) return NO_PERSON;
    if (!canEdit(who, ev.settings, pid)) return FORBIDDEN;
    this.sql.exec(`DELETE FROM people WHERE id = ?`, pid);
    if (this.getMeta('adminPid') === pid) this.sql.exec(`DELETE FROM meta WHERE k = 'adminPid'`);
    // A participant who deleted their own entry has no link left; the admin stays admin.
    const viewer = who.role === 'admin' ? this.admin() : who.me === pid ? visitor('none') : who;
    const out = { view: this.view(viewer) };
    if (row.email) await this.reindex();
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

  // The admin says which entry is theirs (null: none of them).
  setOwn(cred: Cred, pid: string | null): Failure | { view: View } {
    if (!this.exists()) return NOT_FOUND;
    if (this.who(cred).role !== 'admin') return FORBIDDEN;
    if (pid === null) this.sql.exec(`DELETE FROM meta WHERE k = 'adminPid'`);
    else {
      // Its email stays its own: it may have been set with the entry's link.
      if (!this.sql.exec(`SELECT 1 FROM people WHERE id = ?`, pid).toArray().length) return NO_PERSON;
      this.setMeta('adminPid', pid);
    }
    return { view: this.view(this.admin()) };
  }

  // The admin typed an email on their own entry and the event has no admin
  // email: the address gets the admin link back too (see the top). Only for
  // an address entered with the admin link in this very write.
  adoptEmail(email: string): void {
    if (email && !this.getMeta('adminEmail')) this.setMeta('adminEmail', email);
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
    await this.unindex();
  }
}
