// Pure functions shared by the browser and the Worker (which bundles this file
// for validation). No DOM, no I/O.
//
// Dates are 'YYYY-MM-DD' strings and all date math is done in UTC, so the
// browser's time zone never shifts a day. An event's options are keys:
//   dates mode: '2026-11-06'
//   times mode: '2026-11-06T18:30' (wall-clock time in the event's time zone)
// Answers map a key to 1 (yes) or 2 (if need be). A missing key means no.

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
export const MODES = ['dates', 'times'];
export const SLOTS = [15, 30, 60];
export const YES = 1;
export const MAYBE = 2;
export const DEFAULT_SETTINGS = { maybe: true, openEdit: false, hidden: false, closed: false };

const DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const pad = (n) => String(n).padStart(2, '0');

// --- Dates --------------------------------------------------------------------

// 'YYYY-MM-DD' -> ms since epoch (UTC midnight), or NaN for anything invalid.
export function toTime(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return NaN;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? t : NaN;
}
export const isDate = (s) => !Number.isNaN(toTime(s));
export const fromTime = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (s, n) => fromTime(toTime(s) + n * DAY);
export const diffDays = (a, b) => Math.round((toTime(b) - toTime(a)) / DAY);
// 0 = Monday … 6 = Sunday.
export const weekday = (s) => (new Date(toTime(s)).getUTCDay() + 6) % 7;
export const isWeekend = (s) => weekday(s) >= 5;

export function dateRange(start, end) {
  const out = [];
  const last = toTime(end);
  for (let t = toTime(start); t <= last; t += DAY) out.push(fromTime(t));
  return out;
}

export function isoWeek(s) {
  const t = toTime(s);
  const thursday = t + (3 - weekday(s)) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  return Math.floor((thursday - week1) / (7 * DAY)) + 1;
}

// Monday of the week containing s.
export const weekStart = (s) => addDays(s, -weekday(s));

// The browser's local date.
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Months touched by [start, end] as [year, monthIndex] pairs.
export function monthsBetween(start, end) {
  const out = [];
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
export function easter(y) {
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
export function holidays(year) {
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

export function holidaysIn(start, end) {
  const out = new Map();
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
export function weekdayState(selected, days, wd) {
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
export function groupState(selected, dates) {
  if (!dates.length) return 'empty';
  let on = 0;
  for (const d of dates) if (selected.has(d)) on += 1;
  return on === 0 ? 'none' : on === dates.length ? 'all' : 'some';
}

export function setDays(selected, dates, on) {
  const next = new Set(selected);
  for (const d of dates) {
    if (on) next.add(d);
    else next.delete(d);
  }
  return next;
}

// --- Times -------------------------------------------------------------------------

export const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
export const slotKey = (date, min) => `${date}T${hhmm(min)}`;

export function parseKey(k) {
  const m = typeof k === 'string' ? KEY_RE.exec(k) : null;
  if (!m || !isDate(m[1])) return null;
  if (m[2] === undefined) return { date: m[1], min: null };
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 23 || mi > 59) return null;
  return { date: m[1], min: h * 60 + mi };
}

// Slot start minutes of one day: [dayStart, dayStart + slot, …] < dayEnd.
export function daySlots(ev) {
  const out = [];
  for (let m = ev.dayStart; m + ev.slot <= ev.dayEnd; m += ev.slot) out.push(m);
  return out;
}

// Every possible key of an event's range, ignoring which ones are chosen.
export function allKeys(ev, dates = dateRange(ev.start, ev.end)) {
  if (ev.mode === 'dates') return dates.slice();
  const mins = daySlots(ev);
  const out = [];
  for (const d of dates) for (const m of mins) out.push(slotKey(d, m));
  return out;
}

// Dates that have at least one option, in order.
export function optionDates(ev) {
  const seen = new Set();
  for (const k of ev.options) seen.add(k.slice(0, 10));
  return [...seen].sort();
}

// --- Validation ----------------------------------------------------------------------

// Strip control characters (keeping newlines only where allowed) and trim.
function clean(v, max, multiline = false) {
  if (typeof v !== 'string') return '';
  const re = multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  let s = v.replace(/\r\n?/g, '\n').replace(re, multiline ? '' : ' ').trim();
  if (multiline) s = s.replace(/\n{3,}/g, '\n\n');
  return s.slice(0, max).trim();
}
export const cleanLine = (v, max) => clean(v, max, false);
export const cleanText = (v, max) => clean(v, max, true);

export function cleanEmail(v) {
  if (v === undefined || v === null || v === '') return { ok: true, email: '' };
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!s) return { ok: true, email: '' };
  if (s.length > LIMITS.email || !EMAIL_RE.test(s)) return { ok: false };
  return { ok: true, email: s };
}

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const int = (v) => (Number.isInteger(v) ? v : NaN);
const fail = (error) => ({ ok: false, error });

// Validates an event from a client. Returns { ok: true, event } or
// { ok: false, error } where error is an i18n key suffix (err.<error>).
export function sanitizeEvent(input) {
  const o = input && typeof input === 'object' ? input : {};
  const name = cleanLine(o.name, LIMITS.name);
  if (!name) return fail('name');
  const mode = MODES.includes(o.mode) ? o.mode : 'dates';
  if (!isDate(o.start) || !isDate(o.end) || o.end < o.start) return fail('range');
  const days = diffDays(o.start, o.end) + 1;
  if (days > (mode === 'times' ? LIMITS.daysTimes : LIMITS.daysDates)) return fail('rangeLong');

  const s = o.settings && typeof o.settings === 'object' ? o.settings : {};
  const settings = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) settings[k] = typeof s[k] === 'boolean' ? s[k] : def;

  const ev = {
    v: 1,
    name,
    description: cleanText(o.description, LIMITS.description),
    location: cleanLine(o.location, LIMITS.location),
    mode,
    start: o.start,
    end: o.end,
    settings,
  };

  if (mode === 'times') {
    const slot = SLOTS.includes(o.slot) ? o.slot : 30;
    const dayStart = int(o.dayStart);
    const dayEnd = int(o.dayEnd);
    if (!(dayStart >= 0 && dayEnd <= 1440 && dayStart < dayEnd) || dayStart % slot || dayEnd % slot) return fail('hours');
    let duration = int(o.duration);
    if (!(duration >= slot)) duration = Math.max(slot, Math.min(60, dayEnd - dayStart));
    duration = Math.min(Math.ceil(duration / slot) * slot, dayEnd - dayStart, 720);
    Object.assign(ev, {
      slot,
      dayStart,
      dayEnd,
      duration,
      tz: validTimeZone(o.tz) ? o.tz : 'Europe/Oslo',
    });
  }

  const valid = new Set(allKeys(ev));
  const options = Array.isArray(o.options) ? [...new Set(o.options.filter((k) => typeof k === 'string' && valid.has(k)))].sort() : [];
  if (!options.length) return fail('options');
  if (options.length > LIMITS.options) return fail('tooMany');
  ev.options = options;
  return { ok: true, event: ev };
}

// Keeps only answers to existing options, with valid values.
export function cleanAnswers(answers, ev) {
  const out = {};
  if (!answers || typeof answers !== 'object') return out;
  for (const k of ev.options) {
    const v = answers[k];
    if (v === YES || v === MAYBE) out[k] = v;
  }
  return out;
}

// Validates an entry (a participant's name, comment, email and answers).
// email: undefined means "leave unchanged" (only the person themself may set it).
export function sanitizeEntry(input, ev) {
  const o = input && typeof input === 'object' ? input : {};
  const name = cleanLine(o.name, LIMITS.person);
  if (!name) return fail('personName');
  const entry = { name, comment: cleanLine(o.comment, LIMITS.comment), answers: cleanAnswers(o.answers, ev) };
  if (o.email !== undefined) {
    const e = cleanEmail(o.email);
    if (!e.ok) return fail('email');
    entry.email = e.email;
  }
  return { ok: true, entry };
}

// --- Permissions (the Durable Object enforces the same rules) --------------------------

// who: { role: 'admin' | 'participant' | 'visitor', me }
export function canAdd(who, settings) {
  return who.role === 'admin' || !settings.closed;
}
export function canEdit(who, settings, pid) {
  if (who.role === 'admin') return true;
  if (settings.closed) return false;
  if (who.me && who.me === pid) return true;
  return settings.openEdit && !settings.hidden;
}

// --- Results -----------------------------------------------------------------------------

// Per option: ids of people who said yes / if need be / no.
export function tally(ev, people) {
  const out = new Map();
  for (const k of ev.options) out.set(k, { key: k, yes: [], maybe: [], no: [] });
  for (const p of people) {
    for (const [k, t] of out) {
      const v = p.answers?.[k];
      (v === YES ? t.yes : v === MAYBE ? t.maybe : t.no).push(p.id);
    }
  }
  return out;
}

// Most people able to come first, then most clear yeses, then earliest.
export function compareScore(a, b) {
  return b.yes.length + b.maybe.length - (a.yes.length + a.maybe.length) || b.yes.length - a.yes.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export const available = (t) => t.yes.length + t.maybe.length;

// Best dates (dates mode) or best single slots, at least one person available.
export function bestOptions(ev, people, n = 3) {
  return [...tally(ev, people).values()].filter((t) => available(t) > 0).sort(compareScore).slice(0, n);
}

// Times mode: windows of ev.duration made of consecutive options on one day.
// A person counts as yes if yes for every slot, as maybe if available
// (yes or maybe) for every slot.
export function windows(ev, people) {
  if (ev.mode !== 'times') return [];
  const k = Math.max(1, Math.round(ev.duration / ev.slot));
  const byDate = new Map();
  for (const key of ev.options) {
    const { date, min } = parseKey(key);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(min);
  }
  const out = [];
  for (const [date, mins] of byDate) {
    mins.sort((a, b) => a - b);
    for (let i = 0; i + k <= mins.length; i++) {
      if (mins[i + k - 1] - mins[i] !== (k - 1) * ev.slot) continue;
      const keys = mins.slice(i, i + k).map((m) => slotKey(date, m));
      const yes = [];
      const maybe = [];
      const no = [];
      for (const p of people) {
        const vals = keys.map((key) => p.answers?.[key]);
        if (vals.every((v) => v === YES)) yes.push(p.id);
        else if (vals.every((v) => v === YES || v === MAYBE)) maybe.push(p.id);
        else no.push(p.id);
      }
      out.push({ key: keys[0], keys, date, start: mins[i], end: mins[i] + k * ev.slot, yes, maybe, no });
    }
  }
  return out;
}

// The n best windows that don't overlap each other.
export function bestWindows(ev, people, n = 3) {
  const picked = [];
  for (const w of windows(ev, people).filter((x) => available(x) > 0).sort(compareScore)) {
    if (picked.some((p) => p.date === w.date && w.start < p.end && p.start < w.end)) continue;
    picked.push(w);
    if (picked.length === n) break;
  }
  return picked;
}

// When the event is deleted automatically: 30 days after its last date.
export const RETENTION_DAYS = 30;
export const expiresAt = (ev) => toTime(ev.end) + (RETENTION_DAYS + 1) * DAY;
