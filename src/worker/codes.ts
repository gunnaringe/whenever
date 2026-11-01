// Email codes: how many may be asked for, and the codes themselves. Pure, so
// the tests can check every rule (the Lookup object applies them).
//
// Every ask counts, whether or not a mail goes out (only addresses entered on
// an event get one), so the replies never tell which addresses are known.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// [window, how many asks it allows]
export type Rule = readonly [number, number];
export const ADDRESS_RULES: readonly Rule[] = [
  [MINUTE, 1],
  [HOUR, 3],
  [DAY, 6],
];
// Per IP; the per-minute limit is the MAIL_LIMIT rate-limit binding.
export const IP_RULES: readonly Rule[] = [[DAY, 20]];
// Mails a day for the whole app, unless MAIL_DAILY_MAX says otherwise.
export const DAILY_MAX = 200;

export const CODE_TTL = 10 * MINUTE;
export const CODE_TRIES = 5;
export const CODE_RE = /^\d{6}$/;

export type Wait = 'minute' | 'hour' | 'day';

// When the next ask is allowed, given the earlier ones (0: now).
export function allowedAt(times: readonly number[], rules: readonly Rule[], now: number): number {
  let at = 0;
  for (const [win, max] of rules) {
    const recent = times.filter((t) => t > now - win).sort((a, b) => a - b);
    // Allowed again once the oldest asks that fill the window have left it.
    if (recent.length >= max) at = Math.max(at, recent[recent.length - max] + win);
  }
  return at > now ? at : 0;
}

// What the page says: wait a minute, an hour, or until tomorrow.
export const waitWord = (ms: number): Wait => (ms <= MINUTE ? 'minute' : ms <= HOUR ? 'hour' : 'day');

export function dailyMax(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : DAILY_MAX;
}

// Six digits, uniform (rejection sampling).
export function newCode(): string {
  const lim = 4_294_000_000; // a multiple of 1e6 below 2^32
  for (;;) {
    const [x] = crypto.getRandomValues(new Uint32Array(1));
    if (x < lim) return String(x % 1_000_000).padStart(6, '0');
  }
}

// What a person may type: spaces and dashes are ignored ("123 456").
export const cleanCode = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.replace(/[\s-]/g, '') : '';
  return CODE_RE.test(s) ? s : null;
};

// The one-tap link in the mail (/find#t=<token>): 24 random bytes as 32
// base64url characters. Lives as long as the code, and either one used
// ends both.
export const LINK_RE = /^[A-Za-z0-9_-]{32}$/;

export function newLinkToken(): string {
  let bin = '';
  for (const b of crypto.getRandomValues(new Uint8Array(24))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

export const cleanLinkToken = (v: unknown): string | null => (typeof v === 'string' && LINK_RE.test(v) ? v : null);
