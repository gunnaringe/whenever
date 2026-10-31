// One event: its settings and every participant's answers, in SQLite.
//
//   meta(k, v)   'created', 'event' (JSON), 'adminId', 'adminSecret', 'adminEmail'
//   people(...)  one row per entry; secret is their link's (see link.js)
//
// The Worker passes the caller's link as `cred`: null (no link), { bad: true }
// (not shaped like a link) or { sel, secret }. Everything about who may do
// what is decided here, and links are made here.
// Methods return data, or { error, status } for the Worker to send.
// Storage is wiped by an alarm 30 days after the event's last date.

import { DurableObject } from 'cloudflare:workers';
import { LIMITS, sanitizeEntry, cleanAnswers, canAdd, canEdit, expiresAt } from '../public/model.js';
import { newPid, newSecret, token, same } from './link.js';

const NOT_FOUND = { error: 'notFound', status: 404 };
// An event whose dates are already past still lives a week.
const MIN_LIFE = 7 * 24 * 60 * 60 * 1000;
const deleteAt = (ev) => Math.max(expiresAt(ev), Date.now() + MIN_LIFE);
const FORBIDDEN = { error: 'forbidden', status: 403 };
const ADMIN = { role: 'admin', me: null, link: 'ok' };

export class Poll extends DurableObject {
  constructor(ctx, env) {
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
  exists() {
    const t = this.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).toArray();
    return t.length > 0 && this.getMeta('created') !== null;
  }

  getMeta(k) {
    const rows = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray();
    return rows.length ? rows[0].v : null;
  }

  setMeta(k, v) {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v));
  }

  event() {
    return JSON.parse(this.getMeta('event'));
  }

  who(cred) {
    const visitor = (link) => ({ role: 'visitor', me: null, link });
    if (!cred) return visitor('none');
    if (cred.bad) return visitor('invalid');
    if (cred.sel === this.getMeta('adminId')) {
      return same(cred.secret, this.getMeta('adminSecret')) ? ADMIN : visitor('invalid');
    }
    const row = this.sql.exec(`SELECT secret FROM people WHERE id = ?`, cred.sel).toArray()[0];
    return row && same(cred.secret, row.secret) ? { role: 'participant', me: cred.sel, link: 'ok' } : visitor('invalid');
  }

  // What the caller gets to see. Emails are only ever returned to their owner
  // (and the admin's own email to the admin).
  view(who) {
    const ev = this.event();
    const rows = this.sql.exec(`SELECT id, name, comment, email, answers, updated FROM people ORDER BY seq`).toArray();
    const hidden = ev.settings.hidden && who.role !== 'admin';
    const people = [];
    for (const r of rows) {
      if (hidden && r.id !== who.me) continue;
      const p = { id: r.id, name: r.name, comment: r.comment, answers: JSON.parse(r.answers), updated: r.updated };
      if (r.id === who.me) p.email = r.email;
      people.push(p);
    }
    const out = { event: ev, role: who.role, me: who.me, link: who.link, people, count: rows.length, hidden };
    if (who.role === 'admin') out.adminEmail = this.getMeta('adminEmail') ?? '';
    return out;
  }

  // --- RPC from the Worker ------------------------------------------------------

  async create(event, email) {
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
    return { token: token(adminId, secret), view: this.view(ADMIN) };
  }

  get(cred) {
    if (!this.exists()) return NOT_FOUND;
    return { view: this.view(this.who(cred)) };
  }

  async update(cred, event, adminEmail) {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    if (who.role !== 'admin') return FORBIDDEN;
    this.setMeta('event', JSON.stringify(event));
    if (adminEmail !== undefined) this.setMeta('adminEmail', adminEmail);
    // Answers to dates or times that are no longer offered are dropped.
    for (const r of this.sql.exec(`SELECT id, answers FROM people`).toArray()) {
      const a = JSON.stringify(cleanAnswers(JSON.parse(r.answers), event));
      if (a !== r.answers) this.sql.exec(`UPDATE people SET answers = ? WHERE id = ?`, a, r.id);
    }
    await this.ctx.storage.setAlarm(deleteAt(event));
    return { view: this.view(who) };
  }

  async destroy(cred) {
    if (!this.exists()) return NOT_FOUND;
    if (this.who(cred).role !== 'admin') return FORBIDDEN;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }

  add(cred, input) {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    const ev = this.event();
    if (!canAdd(who, ev.settings)) return { error: 'closed', status: 403 };
    const { n, seq } = this.sql.exec(`SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS seq FROM people`).one();
    if (n >= LIMITS.people) return { error: 'full', status: 409 };
    const r = sanitizeEntry({ ...input, email: input?.email ?? '' }, ev);
    if (!r.ok) return { error: r.error, status: 400 };
    let pid = newPid();
    while (pid === this.getMeta('adminId') || this.sql.exec(`SELECT 1 FROM people WHERE id = ?`, pid).toArray().length) pid = newPid();
    const secret = newSecret();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO people (id, seq, name, comment, email, secret, answers, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pid, seq + 1, r.entry.name, r.entry.comment, r.entry.email, secret, JSON.stringify(r.entry.answers), now, now,
    );
    // An admin adding an entry stays admin; anyone else is now that participant.
    const viewer = who.role === 'admin' ? who : { role: 'participant', me: pid, link: 'ok' };
    return { pid, token: token(pid, secret), view: this.view(viewer) };
  }

  edit(cred, pid, input) {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    const ev = this.event();
    const row = this.sql.exec(`SELECT id FROM people WHERE id = ?`, pid).toArray()[0];
    if (!row) return { error: 'person', status: 404 };
    if (!canEdit(who, ev.settings, pid)) return FORBIDDEN;
    // Only the person themself sees or changes their email.
    const own = who.me === pid;
    const r = sanitizeEntry({ ...input, email: own ? input?.email ?? '' : undefined }, ev);
    if (!r.ok) return { error: r.error, status: 400 };
    this.sql.exec(`UPDATE people SET name = ?, comment = ?, answers = ?, updated = ? WHERE id = ?`, r.entry.name, r.entry.comment, JSON.stringify(r.entry.answers), Date.now(), pid);
    if (own) this.sql.exec(`UPDATE people SET email = ? WHERE id = ?`, r.entry.email, pid);
    return { view: this.view(who) };
  }

  drop(cred, pid) {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    const ev = this.event();
    if (!this.sql.exec(`SELECT id FROM people WHERE id = ?`, pid).toArray().length) return { error: 'person', status: 404 };
    if (!canEdit(who, ev.settings, pid)) return FORBIDDEN;
    this.sql.exec(`DELETE FROM people WHERE id = ?`, pid);
    const viewer = who.me === pid ? { role: 'visitor', me: null, link: 'none' } : who;
    return { view: this.view(viewer) };
  }

  // A participant's link: for themself or the admin. reset = invalidate the old one.
  link(cred, pid, reset) {
    if (!this.exists()) return NOT_FOUND;
    const who = this.who(cred);
    if (!(who.role === 'admin' || who.me === pid)) return FORBIDDEN;
    const row = this.sql.exec(`SELECT secret FROM people WHERE id = ?`, pid).toArray()[0];
    if (!row) return { error: 'person', status: 404 };
    let secret = row.secret;
    if (reset) {
      secret = newSecret();
      this.sql.exec(`UPDATE people SET secret = ? WHERE id = ?`, secret, pid);
    }
    return { token: token(pid, secret) };
  }

  resetAdmin(cred) {
    if (!this.exists()) return NOT_FOUND;
    if (this.who(cred).role !== 'admin') return FORBIDDEN;
    const secret = newSecret();
    this.setMeta('adminSecret', secret);
    return { token: token(this.getMeta('adminId'), secret) };
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
