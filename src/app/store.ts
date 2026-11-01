// This device's memory, in localStorage (key whenever-v1): links to events you
// made or answered, so you find them again, plus the language and theme
// choices (theme.ts reads the theme from here too, before the app loads). Only a
// convenience: every link works on any device without it. All keys used by
// the app start with whenever-.

import { TOKEN_RE, PID_RE } from '../shared/model.ts';
import { isLang } from './i18n.ts';
import type { Lang } from './i18n.ts';
import { STORE_KEY as KEY, isTheme } from './theme.ts';
import type { ThemeChoice } from './theme.ts';

// One remembered event: its name, and the admin and/or personal link token.
export interface Stored {
  name: string;
  admin?: string;
  me?: string;
  pid?: string;
  seen: number;
}
type Raw = Record<string, unknown>;
interface State {
  events?: Record<string, Raw>;
  lang?: unknown;
  theme?: unknown;
}

function read(): State {
  try {
    const s: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return s && typeof s === 'object' ? (s as State) : {};
  } catch {
    return {};
  }
}

function write(s: State): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or full storage: links still work, they just aren't remembered.
  }
}

const match = (re: RegExp, v: unknown): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined);

const clean = (e: Raw): Stored => ({
  name: typeof e.name === 'string' ? e.name : '',
  admin: match(TOKEN_RE, e.admin),
  me: match(TOKEN_RE, e.me),
  pid: match(PID_RE, e.pid),
  seen: Number(e.seen) || 0,
});

export function events(): (Stored & { id: string })[] {
  return Object.entries(read().events ?? {})
    .filter(([id]) => /^[A-Za-z0-9]{12}$/.test(id))
    .map(([id, e]) => ({ id, ...clean(e ?? {}) }))
    .sort((a, b) => b.seen - a.seen);
}

export function get(id: string): Stored | null {
  const e = read().events?.[id];
  return e ? clean(e) : null;
}

export function put(id: string, patch: Partial<Stored>): void {
  const s = read();
  s.events ??= {};
  s.events[id] = { ...(s.events[id] ?? {}), ...patch, seen: Date.now() };
  write(s);
}

// A link that no longer works: forget it (and the event if nothing is left).
export function dropToken(id: string, token: string): void {
  const s = read();
  const e = s.events?.[id];
  if (!e) return;
  if (e.admin === token) delete e.admin;
  if (e.me === token) {
    delete e.me;
    delete e.pid;
  }
  if (!e.admin && !e.me) delete s.events?.[id];
  write(s);
}

export function forgetMe(id: string): void {
  const s = read();
  const e = s.events?.[id];
  if (!e) return;
  delete e.me;
  delete e.pid;
  if (!e.admin) delete s.events?.[id];
  write(s);
}

export function forget(id: string): void {
  const s = read();
  if (s.events) delete s.events[id];
  write(s);
}

export function getLang(): Lang | null {
  const l = read().lang;
  return isLang(l) ? l : null;
}

export function setLang(lang: Lang): void {
  const s = read();
  s.lang = lang;
  write(s);
}

export function getTheme(): ThemeChoice {
  const theme = read().theme;
  return isTheme(theme) ? theme : 'auto';
}

export function setTheme(theme: ThemeChoice): void {
  const s = read();
  s.theme = theme;
  write(s);
}
