// Pure functions shared by the browser and the Worker (which bundles this file
// for validation). No DOM, no I/O.
//
// Dates are 'YYYY-MM-DD' strings and all date math is done in UTC, so the
// browser's time zone never shifts a day. An event's options are keys:
//   dates mode: '2026-11-06'
//   times mode: '2026-11-06T18:30' (wall-clock time in the event's time zone)
// Answers map a key to 1 (yes) or 2 (if need be). A missing key means no.

// --- Types ---------------------------------------------------------------------

export type Mode = 'dates' | 'times';
export type Answer = typeof YES | typeof MAYBE;
export type Answers = Record<string, Answer>;
export interface Settings {
  maybe: boolean;
  // Rank by yes + maybe. Off (the default): rank by yes, maybe breaks ties.
  maybeCounts: boolean;
  openEdit: boolean;
  hidden: boolean;
  closed: boolean;
}
// The times of day an event offers: slots of `slot` minutes from dayStart
// to dayEnd (minutes after midnight).
export interface DayWindow {
  slot: number;
  dayStart: number;
  dayEnd: number;
}
interface EventBase {
  v: 1;
  name: string;
  description: string;
  location: string;
  start: string;
  end: string;
  settings: Settings;
  options: string[];
  // The organiser's pick: an option, or in times mode the start of a
  // window of `duration` (see decisionKeys).
  decided?: string;
}
export interface DatesEvent extends EventBase {
  mode: 'dates';
}
export interface TimesEvent extends EventBase, DayWindow {
  mode: 'times';
  duration: number; // meeting length in minutes, a multiple of slot
  tz: string;
}
export type PollEvent = DatesEvent | TimesEvent;
// What allKeys() needs: an event, or the event form's draft.
export type Range = { start: string; end: string } & ({ mode: 'dates' } | ({ mode: 'times' } & DayWindow));

export type Role = 'admin' | 'participant' | 'visitor';
export type LinkState = 'none' | 'invalid' | 'ok';
// Who is asking: the role their link gives them, their own entry's id, and
// whether the link they sent worked.
export interface Who {
  role: Role;
  me: string | null;
  link: LinkState;
}
export interface Entry {
  name: string;
  comment: string;
  answers: Answers;
  email?: string;
}
// A participant as the API returns them (email only to its owner).
export interface Person {
  id: string;
  name: string;
  comment: string;
  answers: Answers;
  updated: number;
  email?: string;
}
// GET /api/events/:id and friends: the event as the caller may see it.
export interface View {
  event: PollEvent;
  role: Role;
  me: string | null;
  link: LinkState;
  people: Person[];
  count: number;
  hidden: boolean;
  adminEmail?: string;
}
// POST /api/events and POST /api/events/:id/people.
export interface Created {
  id: string;
  token: string;
  view: View;
}
export interface Added {
  pid: string;
  token: string;
  view: View;
}
export interface Tally {
  key: string;
  yes: string[];
  maybe: string[];
  no: string[];
}
export interface TimeWindow extends Tally {
  keys: string[];
  date: string;
  start: number;
  end: number;
}
type Failed = { ok: false; error: string };

export const LIMITS = {
  name: 100,
  description: 2000,
  location: 200,
  person: 60,
  comment: 300,
  email: 254,
  people: 200,
  options: 2000,
  daysDates: 366,
  daysTimes: 62,
};
export const MODES: readonly Mode[] = ['dates', 'times'];
export const SLOTS: readonly number[] = [15, 30, 60];
export const YES = 1;
export const MAYBE = 2;
export const DEFAULT_SETTINGS: Readonly<Settings> = { maybe: true, maybeCounts: false, openEdit: false, hidden: false, closed: false };

// Participant ids and link tokens (a 16-hex selector, then a 22-character
// random secret; see src/worker/link.ts).
export const PID = '[0-9a-f]{16}';
export const TOKEN = `${PID}[A-Za-z0-9_-]{22}`;
export const PID_RE = new RegExp(`^${PID}$`);
export const TOKEN_RE = new RegExp(`^${TOKEN}$`);

const DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const pad = (n: number): string => String(n).padStart(2, '0');

// --- Dates --------------------------------------------------------------------

// 'YYYY-MM-DD' -> ms since epoch (UTC midnight), or NaN for anything invalid.
export function toTime(s: unknown): number {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return NaN;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? t : NaN;
}
export const isDate = (s: unknown): s is string => !Number.isNaN(toTime(s));
export const fromTime = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const addDays = (s: string, n: number): string => fromTime(toTime(s) + n * DAY);
export const diffDays = (a: string, b: string): number => Math.round((toTime(b) - toTime(a)) / DAY);
// 0 = Monday … 6 = Sunday.
export const weekday = (s: string): number => (new Date(toTime(s)).getUTCDay() + 6) % 7;
export const isWeekend = (s: string): boolean => weekday(s) >= 5;

export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const last = toTime(end);
  for (let t = toTime(start); t <= last; t += DAY) out.push(fromTime(t));
  return out;
}

export function isoWeek(s: string): number {
  const t = toTime(s);
  const thursday = t + (3 - weekday(s)) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  return Math.floor((thursday - week1) / (7 * DAY)) + 1;
}

// Monday of the week containing s.
export const weekStart = (s: string): string => addDays(s, -weekday(s));

// The first day of the month `add` months after the month of s, and the last.
export function monthStart(s: string, add = 0): string {
  const [y, m] = s.split('-').map(Number);
  return fromTime(Date.UTC(y, m - 1 + add, 1));
}
export const monthEnd = (s: string, add = 0): string => addDays(monthStart(s, add + 1), -1);

// The browser's local date.
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Months touched by [start, end] as [year, monthIndex] pairs.
export function monthsBetween(start: string, end: string): [number, number][] {
  const out: [number, number][] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  m -= 1;
  while (y < ey || (y === ey && m <= em - 1)) {
    out.push([y, m]);
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return out;
}

// --- Norwegian public holidays --------------------------------------------------

// Easter Sunday (anonymous Gregorian algorithm).
export function easter(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${pad(month)}-${pad(day)}`;
}

// Map date -> i18n key (holiday.<key>).
export function holidays(year: number): Map<string, string> {
  const e = easter(year);
  return new Map([
    [`${year}-01-01`, 'newYear'],
    [addDays(e, -3), 'maundyThursday'],
    [addDays(e, -2), 'goodFriday'],
    [e, 'easter'],
    [addDays(e, 1), 'easterMonday'],
    [`${year}-05-01`, 'mayDay'],
    [`${year}-05-17`, 'constitutionDay'],
    [addDays(e, 39), 'ascension'],
    [addDays(e, 49), 'whitsun'],
    [addDays(e, 50), 'whitMonday'],
    [`${year}-12-25`, 'christmas'],
    [`${year}-12-26`, 'boxingDay'],
  ]);
}

export function holidaysIn(start: string, end: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!isDate(start) || !isDate(end)) return out;
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) {
    for (const [d, k] of holidays(y)) if (d >= start && d <= end) out.set(d, k);
  }
  return out;
}

// --- Selecting candidate days ----------------------------------------------------
// These only ever change a Set of dates; single days stay toggleable afterwards.

// 'all' | 'some' | 'none' for one weekday (0 = Monday) within the range, or
// 'empty' if the range has no such weekday.
export type ChipState = 'all' | 'some' | 'none' | 'empty';

export function weekdayState(selected: ReadonlySet<string>, days: readonly string[], wd: number): ChipState {
  let total = 0;
  let on = 0;
  for (const d of days) {
    if (weekday(d) !== wd) continue;
    total += 1;
    if (selected.has(d)) on += 1;
  }
  if (!total) return 'empty';
  return on === 0 ? 'none' : on === total ? 'all' : 'some';
}

// The same for any list of dates (weekdays, weekends, holidays, one week).
export function groupState(selected: ReadonlySet<string>, dates: readonly string[]): ChipState {
  if (!dates.length) return 'empty';
  let on = 0;
  for (const d of dates) if (selected.has(d)) on += 1;
  return on === 0 ? 'none' : on === dates.length ? 'all' : 'some';
}

export function setDays(selected: ReadonlySet<string>, dates: Iterable<string>, on: boolean): Set<string> {
  const next = new Set(selected);
  for (const d of dates) {
    if (on) next.add(d);
    else next.delete(d);
  }
  return next;
}

// --- Times -------------------------------------------------------------------------

export const hhmm = (min: number): string => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
export const slotKey = (date: string, min: number): string => `${date}T${hhmm(min)}`;

// A key -> its date, and its start minute (null in dates mode); null if invalid.
export function parseKey(k: unknown): { date: string; min: number | null } | null {
  const m = typeof k === 'string' ? KEY_RE.exec(k) : null;
  if (!m || !isDate(m[1])) return null;
  if (m[2] === undefined) return { date: m[1], min: null };
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 23 || mi > 59) return null;
  return { date: m[1], min: h * 60 + mi };
}

// Slot start minutes of one day: [dayStart, dayStart + slot, …] < dayEnd.
export function daySlots(ev: DayWindow): number[] {
  const out: number[] = [];
  for (let m = ev.dayStart; m + ev.slot <= ev.dayEnd; m += ev.slot) out.push(m);
  return out;
}

// Every possible key of an event's range, ignoring which ones are chosen.
export function allKeys(ev: Range, dates = dateRange(ev.start, ev.end)): string[] {
  if (ev.mode === 'dates') return dates.slice();
  const mins = daySlots(ev);
  const out: string[] = [];
  for (const d of dates) for (const m of mins) out.push(slotKey(d, m));
  return out;
}

// Dates that have at least one option, in order.
export function optionDates(ev: Pick<PollEvent, 'options'>): string[] {
  const seen = new Set<string>();
  for (const k of ev.options) seen.add(k.slice(0, 10));
  return [...seen].sort();
}

// --- Validation ----------------------------------------------------------------------

// Strip control characters (keeping newlines only where allowed) and trim.
function clean(v: unknown, max: number, multiline = false): string {
  if (typeof v !== 'string') return '';
  const re = multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  let s = v.replace(/\r\n?/g, '\n').replace(re, multiline ? '' : ' ').trim();
  if (multiline) s = s.replace(/\n{3,}/g, '\n\n');
  return s.slice(0, max).trim();
}
export const cleanLine = (v: unknown, max: number): string => clean(v, max, false);
export const cleanText = (v: unknown, max: number): string => clean(v, max, true);

export function cleanEmail(v: unknown): { ok: true; email: string } | { ok: false } {
  if (v === undefined || v === null || v === '') return { ok: true, email: '' };
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!s) return { ok: true, email: '' };
  if (s.length > LIMITS.email || !EMAIL_RE.test(s)) return { ok: false };
  return { ok: true, email: s };
}

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) ? v : NaN);
const fail = (error: string): Failed => ({ ok: false, error });
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

// Validates an event from a client. Returns { ok: true, event } or
// { ok: false, error } where error is an i18n key suffix (err.<error>).
export function sanitizeEvent(input: unknown): { ok: true; event: PollEvent } | Failed {
  const o = record(input);
  const name = cleanLine(o.name, LIMITS.name);
  if (!name) return fail('name');
  const mode: Mode = o.mode === 'times' ? 'times' : 'dates';
  const { start, end } = o;
  if (!isDate(start) || !isDate(end) || end < start) return fail('range');
  const days = diffDays(start, end) + 1;
  if (days > (mode === 'times' ? LIMITS.daysTimes : LIMITS.daysDates)) return fail('rangeLong');

  const s = record(o.settings);
  const settings: Settings = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const v = s[k];
    if (typeof v === 'boolean') settings[k] = v;
  }

  const base = {
    v: 1 as const,
    name,
    description: cleanText(o.description, LIMITS.description),
    location: cleanLine(o.location, LIMITS.location),
    start,
    end,
    settings,
    options: [] as string[],
  };

  let ev: PollEvent;
  if (mode === 'times') {
    const slot = SLOTS.find((x) => x === o.slot) ?? 30;
    const dayStart = int(o.dayStart);
    const dayEnd = int(o.dayEnd);
    if (!(dayStart >= 0 && dayEnd <= 1440 && dayStart < dayEnd) || dayStart % slot || dayEnd % slot) return fail('hours');
    let duration = int(o.duration);
    if (!(duration >= slot)) duration = Math.max(slot, Math.min(60, dayEnd - dayStart));
    duration = Math.min(Math.ceil(duration / slot) * slot, dayEnd - dayStart, 720);
    ev = { ...base, mode, slot, dayStart, dayEnd, duration, tz: validTimeZone(o.tz) ? o.tz : 'Europe/Oslo' };
  } else {
    ev = { ...base, mode };
  }

  const valid = new Set(allKeys(ev));
  const options = Array.isArray(o.options) ? [...new Set(o.options.filter((k): k is string => typeof k === 'string' && valid.has(k)))].sort() : [];
  if (!options.length) return fail('options');
  if (options.length > LIMITS.options) return fail('tooMany');
  ev.options = options;
  // A pick that no longer fits the options is dropped, not an error.
  if (typeof o.decided === 'string' && decisionKeys(ev).has(o.decided)) ev.decided = o.decided;
  return { ok: true, event: ev };
}

// What the organiser can pick as the final date or time: an option, or in
// times mode the start of a whole window.
export function decisionKeys(ev: PollEvent): Set<string> {
  return new Set(ev.mode === 'dates' ? ev.options : windows(ev, []).map((w) => w.key));
}

// The picked option or window with who can come, or null if nothing is picked.
export function decision(ev: PollEvent, people: readonly Answered[]): Tally | TimeWindow | null {
  if (!ev.decided) return null;
  if (ev.mode === 'times') return windows(ev, people).find((w) => w.key === ev.decided) ?? null;
  return tally(ev, people).get(ev.decided) ?? null;
}

// Keeps only answers to existing options, with valid values.
export function cleanAnswers(answers: unknown, ev: Pick<PollEvent, 'options'>): Answers {
  const out: Answers = {};
  if (!answers || typeof answers !== 'object') return out;
  const a = answers as Record<string, unknown>;
  for (const k of ev.options) {
    const v = a[k];
    if (v === YES || v === MAYBE) out[k] = v;
  }
  return out;
}

// Validates an entry (a participant's name, comment, email and answers).
// email: undefined means "leave unchanged" (only the person themself may set it).
export function sanitizeEntry(input: unknown, ev: Pick<PollEvent, 'options'>): { ok: true; entry: Entry } | Failed {
  const o = record(input);
  const name = cleanLine(o.name, LIMITS.person);
  if (!name) return fail('personName');
  const entry: Entry = { name, comment: cleanLine(o.comment, LIMITS.comment), answers: cleanAnswers(o.answers, ev) };
  if (o.email !== undefined) {
    const e = cleanEmail(o.email);
    if (!e.ok) return fail('email');
    entry.email = e.email;
  }
  return { ok: true, entry };
}

// --- Permissions (the Durable Object enforces the same rules) --------------------------

export function canAdd(who: Pick<Who, 'role'>, settings: Settings): boolean {
  return who.role === 'admin' || !settings.closed;
}
export function canEdit(who: Pick<Who, 'role' | 'me'>, settings: Settings, pid: string | null): boolean {
  if (who.role === 'admin') return true;
  if (settings.closed) return false;
  if (who.me && who.me === pid) return true;
  return settings.openEdit && !settings.hidden;
}

// --- Results -----------------------------------------------------------------------------

// Per option: ids of people who said yes / if need be / no.
type Answered = Pick<Person, 'id' | 'answers'>;

export function tally(ev: Pick<PollEvent, 'options'>, people: readonly Answered[]): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const k of ev.options) out.set(k, { key: k, yes: [], maybe: [], no: [] });
  for (const p of people) {
    for (const [k, t] of out) {
      const v = p.answers?.[k];
      (v === YES ? t.yes : v === MAYBE ? t.maybe : t.no).push(p.id);
    }
  }
  return out;
}

export const available = (t: Tally): number => t.yes.length + t.maybe.length;

type Ranking = Pick<Settings, 'maybeCounts'>;

// The number shown for an option: how many can come. "Maybe" only counts
// with maybeCounts.
export const score = (t: Tally, s: Ranking): number => (s.maybeCounts ? available(t) : t.yes.length);

// What breaks a tie in score: more maybes (by default), or with
// maybeCounts, more clear yeses.
const tiebreak = (t: Tally, s: Ranking): number => (s.maybeCounts ? t.yes.length : t.maybe.length);

// Equally good: neither the score nor the tiebreak tells them apart.
export const sameScore = (a: Tally, b: Tally, s: Ranking): boolean => score(a, s) === score(b, s) && tiebreak(a, s) === tiebreak(b, s);

// Highest score first, then the tiebreak, then earliest.
export function compareScore(a: Tally, b: Tally, s: Ranking): number {
  return score(b, s) - score(a, s) || tiebreak(b, s) - tiebreak(a, s) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// Rank numbers for a list sorted by compareScore; equally good ones share
// one (1, 1, 3).
export function ranks(sorted: readonly Tally[], s: Ranking): number[] {
  const out: number[] = [];
  sorted.forEach((t, i) => out.push(i && sameScore(t, sorted[i - 1], s) ? out[i - 1] : i + 1));
  return out;
}

// Shading from 0 to 1: the score, moved by the tiebreak by less than one
// person, so a darker option never ranks lower.
export function heat(t: Tally, n: number, s: Ranking): number {
  if (!n) return 0;
  const m = t.maybe.length / (n + 1);
  return s.maybeCounts ? (available(t) - m) / n : (t.yes.length + m) / n;
}

// Best dates (dates mode) or best single slots, at least one person available.
export function bestOptions(ev: Pick<PollEvent, 'options' | 'settings'>, people: readonly Answered[], n = 3): Tally[] {
  return [...tally(ev, people).values()]
    .filter((t) => available(t) > 0)
    .sort((a, b) => compareScore(a, b, ev.settings))
    .slice(0, n);
}

// Times mode: windows of ev.duration made of consecutive options on one day.
// A person counts as yes if yes for every slot, as maybe if available
// (yes or maybe) for every slot.
export function windows(ev: PollEvent, people: readonly Answered[]): TimeWindow[] {
  if (ev.mode !== 'times') return [];
  const k = Math.max(1, Math.round(ev.duration / ev.slot));
  const byDate = new Map<string, number[]>();
  for (const key of ev.options) {
    const p = parseKey(key);
    if (!p || p.min === null) continue;
    const mins = byDate.get(p.date) ?? [];
    mins.push(p.min);
    byDate.set(p.date, mins);
  }
  const out: TimeWindow[] = [];
  for (const [date, mins] of byDate) {
    mins.sort((a, b) => a - b);
    for (let i = 0; i + k <= mins.length; i++) {
      const first = mins[i];
      if (mins[i + k - 1] - first !== (k - 1) * ev.slot) continue;
      const keys = mins.slice(i, i + k).map((m) => slotKey(date, m));
      const yes: string[] = [];
      const maybe: string[] = [];
      const no: string[] = [];
      for (const p of people) {
        const vals = keys.map((key) => p.answers?.[key]);
        if (vals.every((v) => v === YES)) yes.push(p.id);
        else if (vals.every((v) => v === YES || v === MAYBE)) maybe.push(p.id);
        else no.push(p.id);
      }
      out.push({ key: keys[0], keys, date, start: first, end: first + k * ev.slot, yes, maybe, no });
    }
  }
  return out;
}

// The n best windows that don't overlap each other.
export function bestWindows(ev: PollEvent, people: readonly Answered[], n = 3): TimeWindow[] {
  const picked: TimeWindow[] = [];
  for (const w of windows(ev, people)
    .filter((x) => available(x) > 0)
    .sort((a, b) => compareScore(a, b, ev.settings))) {
    if (picked.some((p) => p.date === w.date && w.start < p.end && p.start < w.end)) continue;
    picked.push(w);
    if (picked.length === n) break;
  }
  return picked;
}

// When the event is deleted automatically: 30 days after its last date.
export const RETENTION_DAYS = 30;
export const expiresAt = (ev: Pick<PollEvent, 'end'>): number => toTime(ev.end) + (RETENTION_DAYS + 1) * DAY;
