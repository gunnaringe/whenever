// The email index, one object for the whole app (name "lookup"): which events
// an address was entered on, the codes sent for it, and the asks counted
// against the limits (codes.ts). Addresses, IPs and codes are only stored as
// HMACs, under a key this object makes once and keeps in its own storage.
//
//   meta(k, v)                          'key'
//   entries(email, event, expires)      kept up to date by each Poll (index())
//   codes(email, hash, expires, tries)  one live code per address
//   asks(who, at)                       'e:<email>', 'i:<ip>', 'sent'
//
// Methods hash first and then do all their SQL without awaiting anything, so
// requests can't interleave between reading the counts and writing.

import { DurableObject } from 'cloudflare:workers';
import { same } from './link.ts';
import { ADDRESS_RULES, IP_RULES, CODE_TTL, CODE_TRIES, DAY, allowedAt, waitWord, newCode } from './codes.ts';
import type { Wait } from './codes.ts';

// Events one address can bring back at most.
const MAX_EVENTS = 100;

const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export class Lookup extends DurableObject<Env> {
  sql: SqlStorage;
  key!: CryptoKey;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (email TEXT NOT NULL, event TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (email, event))`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS entries_event ON entries (event)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS asks (who TEXT NOT NULL, at INTEGER NOT NULL)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS asks_who ON asks (who, at)`);
      let raw = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'key'`).toArray()[0]?.v;
      if (!raw) {
        raw = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
        this.sql.exec(`INSERT INTO meta (k, v) VALUES ('key', ?)`, raw);
      }
      const bytes = new Uint8Array(raw.match(/../g)!.map((h) => parseInt(h, 16)));
      this.key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    });
  }

  async mac(s: string): Promise<string> {
    return hex(await crypto.subtle.sign('HMAC', this.key, new TextEncoder().encode(s)));
  }

  prune(now: number): void {
    this.sql.exec(`DELETE FROM asks WHERE at <= ?`, now - DAY);
    this.sql.exec(`DELETE FROM codes WHERE expires <= ?`, now);
    this.sql.exec(`DELETE FROM entries WHERE expires <= ?`, now);
  }

  times(who: string): number[] {
    return this.sql.exec<{ at: number }>(`SELECT at FROM asks WHERE who = ?`, who).toArray().map((r) => r.at);
  }

  // --- RPC -----------------------------------------------------------------------------

  // Event `event` now has these addresses (none: it is gone), until `expires`.
  async index(event: string, emails: string[], expires: number): Promise<void> {
    const keys = await Promise.all([...new Set(emails)].map((e) => this.mac(`e\n${e}`)));
    this.sql.exec(`DELETE FROM entries WHERE event = ?`, event);
    for (const k of keys) this.sql.exec(`INSERT OR REPLACE INTO entries (email, event, expires) VALUES (?, ?, ?)`, k, event, expires);
  }

  // Someone asks for a code. { wait } when a limit is reached; else { code },
  // which is null when the address isn't on any event (nothing to send).
  async ask(email: string, ip: string, max: number): Promise<{ wait: Wait } | { code: string | null }> {
    const e = await this.mac(`e\n${email}`);
    const i = await this.mac(`i\n${ip}`);
    const code = newCode();
    const hash = await this.mac(`c\n${e}\n${code}`);
    const now = Date.now();
    this.prune(now);
    const sent = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM asks WHERE who = 'sent'`).one().n;
    if (sent >= max) return { wait: 'day' };
    const at = Math.max(allowedAt(this.times(`i:${i}`), IP_RULES, now), allowedAt(this.times(`e:${e}`), ADDRESS_RULES, now));
    if (at) return { wait: waitWord(at - now) };
    this.sql.exec(`INSERT INTO asks (who, at) VALUES (?, ?), (?, ?)`, `i:${i}`, now, `e:${e}`, now);
    if (!this.sql.exec(`SELECT 1 FROM entries WHERE email = ? LIMIT 1`, e).toArray().length) return { code: null };
    this.sql.exec(`INSERT OR REPLACE INTO codes (email, hash, expires, tries) VALUES (?, ?, ?, ?)`, e, hash, now + CODE_TTL, CODE_TRIES);
    this.sql.exec(`INSERT INTO asks (who, at) VALUES ('sent', ?)`, now);
    return { code };
  }

  // A code typed in: the address's events, or null (wrong, used up or expired;
  // the same answer for an address that never got one).
  async check(email: string, code: string): Promise<{ events: string[] } | null> {
    const e = await this.mac(`e\n${email}`);
    const hash = await this.mac(`c\n${e}\n${code}`);
    const now = Date.now();
    this.prune(now);
    const row = this.sql.exec<{ hash: string; tries: number }>(`SELECT hash, tries FROM codes WHERE email = ?`, e).toArray()[0];
    if (!row) return null;
    if (!same(hash, row.hash)) {
      if (row.tries <= 1) this.sql.exec(`DELETE FROM codes WHERE email = ?`, e);
      else this.sql.exec(`UPDATE codes SET tries = tries - 1 WHERE email = ?`, e);
      return null;
    }
    this.sql.exec(`DELETE FROM codes WHERE email = ?`, e);
    const events = this.sql
      .exec<{ event: string }>(`SELECT event FROM entries WHERE email = ? ORDER BY expires DESC LIMIT ?`, e, MAX_EVENTS)
      .toArray()
      .map((r) => r.event);
    return { events };
  }
}
