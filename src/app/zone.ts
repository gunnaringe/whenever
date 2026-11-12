// Time zones for times mode. Option keys are wall-clock times in the event's
// zone (`ev.tz`); a viewer elsewhere can see, and answer in, their own zone
// instead. The keys never change: this only moves where a slot is drawn and
// what it is called. Pure (no DOM), so the tests run it in Node.

import * as M from '../shared/model.ts';

const MINUTE = 60_000;
const DAY = 1440;
const GAP = 4 * 60;

// Making a formatter is slow (most of the time here): one per zone.
const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(tz, f);
  }
  return f;
}

// The zone's offset from UTC (ms) at instant t. It only changes when the
// clocks do, so a UTC day with the same offset at both ends has it all day
// (no zone changes twice in a day): one look per day, not one per slot.
const daily = new Map<string, number | null>();
function offset(t: number, tz: string): number {
  const d = Math.floor(t / (DAY * MINUTE));
  const key = `${tz} ${d}`;
  let o = daily.get(key);
  if (o === undefined) {
    const a = exact(d * DAY * MINUTE, tz);
    o = a === exact((d + 1) * DAY * MINUTE - MINUTE, tz) ? a : null;
    daily.set(key, o);
  }
  return o ?? exact(t, tz);
}

function exact(t: number, tz: string): number {
  const parts = format(tz).formatToParts(t);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - t;
}

// The instant of wall-clock `min` minutes into `date` in zone tz.
export function zonedUtc(date: string, min: number, tz: string): number {
  const wall = M.toTime(date) + min * MINUTE;
  const guess = wall - offset(wall, tz);
  // Again from the guess, in case the offset changes in between (DST).
  return wall - offset(guess, tz);
}

// The wall clock in zone tz at instant t.
export function wallIn(t: number, tz: string): { date: string; min: number } {
  const local = t + offset(t, tz);
  const date = M.fromTime(local);
  return { date, min: Math.round((local - M.toTime(date)) / MINUTE) };
}

// Wall-clock `min` into `date` in zone `from`, as a wall clock in zone `to`.
// Minutes past midnight (a window's end) carry into the next day.
export function moveClock(date: string, min: number, from: string, to: string): { date: string; min: number } {
  if (from === to) return min < DAY ? { date, min } : { date: M.addDays(date, Math.floor(min / DAY)), min: min % DAY };
  return wallIn(zonedUtc(date, min, from), to);
}

// Whether every option reads the same in zone tz as in the event's.
// Both are worked out once per event object and zone: the page asks for
// every label, and on every hover. A new view brings a new event object.
const memo = new WeakMap<M.TimesEvent, Map<string, unknown>>();
function once<T>(ev: M.TimesEvent, key: string, make: () => T): T {
  let m = memo.get(ev);
  if (!m) memo.set(ev, (m = new Map()));
  if (!m.has(key)) m.set(key, make());
  return m.get(key) as T;
}

export function sameClock(ev: M.TimesEvent, tz: string): boolean {
  if (tz === ev.tz) return true;
  return once(ev, `same ${tz}`, () => sameClockNow(ev, tz));
}

function sameClockNow(ev: M.TimesEvent, tz: string): boolean {
  return ev.options.every((k) => {
    const p = M.parseKey(k);
    if (!p || p.min === null) return true;
    const w = moveClock(p.date, p.min, ev.tz, tz);
    return w.date === p.date && w.min === p.min;
  });
}

// How to draw the grid in zone tz: the columns, the rows (start minutes) and
// the option key under each cell (null: no option there).
export interface Layout {
  dates: string[];
  mins: number[];
  key: (date: string, min: number) => string | null;
}

// The rows: in the event's zone, from the earliest slot (on the hour, and not
// before the hours shown) to the latest, a slot apart. In another zone the
// slots can wrap past midnight (evening in Oslo is early morning in Tokyo):
// gaps up to GAP are filled, longer ones left out, so the grid doesn't grow
// to the whole day. The grid marks where rows are left out.
function rows(ev: M.TimesEvent, mins: number[], own: boolean): number[] {
  if (!mins.length) return [];
  if (own) {
    let lo = Math.min(...mins);
    const hi = Math.max(...mins);
    lo = Math.max(ev.dayStart, Math.floor(lo / 60) * 60);
    return M.daySlots(ev).filter((m) => m >= lo && m <= hi);
  }
  const have = [...new Set(mins)].sort((a, b) => a - b);
  const out: number[] = [];
  have.forEach((m, i) => {
    out.push(m);
    const next = have[i + 1];
    if (next !== undefined && next - m <= GAP) for (let x = m + ev.slot; x < next; x += ev.slot) out.push(x);
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

export function layout(ev: M.TimesEvent, tz: string): Layout {
  return once(ev, `layout ${tz}`, () => layoutNow(ev, tz));
}

function layoutNow(ev: M.TimesEvent, tz: string): Layout {
  if (sameClock(ev, tz)) {
    const mins = ev.options.map((k) => M.parseKey(k)?.min).filter((m): m is number => typeof m === 'number');
    return { dates: M.optionDates(ev), mins: rows(ev, mins, true), key: M.slotKey };
  }
  // Where each option lands; two on one slot (the hour that repeats when the
  // clocks go back) keep the first.
  const at = new Map<string, string>();
  const dates = new Set<string>();
  const mins = new Set<number>();
  for (const k of ev.options) {
    const p = M.parseKey(k);
    if (!p || p.min === null) continue;
    const w = moveClock(p.date, p.min, ev.tz, tz);
    const here = M.slotKey(w.date, w.min);
    if (at.has(here)) continue;
    at.set(here, k);
    dates.add(w.date);
    mins.add(w.min);
  }
  return { dates: [...dates].sort(), mins: rows(ev, [...mins], false), key: (d, m) => at.get(M.slotKey(d, m)) ?? null };
}
