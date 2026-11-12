import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, moveClock, sameClock, wallIn, zonedUtc } from '../src/app/zone.ts';
import type { TimesEvent } from '../src/shared/model.ts';

const ev = (options: string[], tz = 'Europe/Oslo', slot = 60): TimesEvent => ({
  v: 1,
  name: 'x',
  description: '',
  location: '',
  mode: 'times',
  start: options[0].slice(0, 10),
  end: options[options.length - 1].slice(0, 10),
  options,
  slot,
  dayStart: 480,
  dayEnd: 1320,
  duration: slot,
  tz,
  settings: {} as TimesEvent['settings'],
});

test('wallIn is the inverse of zonedUtc', () => {
  for (const [d, m, tz] of [['2026-11-18', 600, 'Europe/Oslo'], ['2026-07-01', 1425, 'Asia/Kolkata'], ['2026-03-29', 180, 'Europe/Oslo'], ['2026-11-18', 0, 'America/New_York']] as const) {
    assert.deepEqual(wallIn(zonedUtc(d, m, tz), tz), { date: d, min: m });
  }
});

test('moveClock: across a date, off the hour, and in the week the clocks differ', () => {
  assert.deepEqual(moveClock('2026-11-18', 22 * 60, 'Europe/Oslo', 'Asia/Tokyo'), { date: '2026-11-19', min: 6 * 60 });
  assert.deepEqual(moveClock('2026-11-18', 10 * 60, 'Europe/Oslo', 'Asia/Kolkata'), { date: '2026-11-18', min: 14 * 60 + 30 });
  // 27 October 2026: Oslo is on winter time, New York not yet (5 hours, not 6).
  assert.deepEqual(moveClock('2026-10-27', 15 * 60, 'Europe/Oslo', 'America/New_York'), { date: '2026-10-27', min: 10 * 60 });
  assert.deepEqual(moveClock('2026-11-18', 15 * 60, 'Europe/Oslo', 'America/New_York'), { date: '2026-11-18', min: 9 * 60 });
  // A window's end at midnight is the next day's 00:00.
  assert.deepEqual(moveClock('2026-11-18', 1440, 'Europe/Oslo', 'Europe/Oslo'), { date: '2026-11-19', min: 0 });
});

test('sameClock: Stockholm reads as Oslo, Tokyo does not', () => {
  const e = ev(['2026-11-18T10:00', '2026-11-18T11:00']);
  assert.equal(sameClock(e, 'Europe/Stockholm'), true);
  assert.equal(sameClock(e, 'Asia/Tokyo'), false);
});

test('layout in the event zone is the plain grid', () => {
  const e = ev(['2026-11-18T10:00', '2026-11-18T12:00', '2026-11-19T09:00']);
  const L = layout(e, 'Europe/Oslo');
  assert.deepEqual(L.dates, ['2026-11-18', '2026-11-19']);
  assert.deepEqual(L.mins, [540, 600, 660, 720]);
  assert.equal(L.key('2026-11-18', 600), '2026-11-18T10:00');
});

test('layout in Tokyo moves late slots to the next day, and maps back', () => {
  const e = ev(['2026-11-18T15:00', '2026-11-18T16:00', '2026-11-18T17:00']);
  const L = layout(e, 'Asia/Tokyo');
  assert.deepEqual(L.dates, ['2026-11-18', '2026-11-19']);
  assert.deepEqual(L.mins, [0, 60, 1380]); // 01:00 to 23:00 is too long a gap to fill
  assert.equal(L.key('2026-11-18', 1380), '2026-11-18T15:00');
  assert.equal(L.key('2026-11-19', 0), '2026-11-18T16:00');
  assert.equal(L.key('2026-11-19', 1380), null);
});

test('layout in Kolkata has rows on the half hour', () => {
  const e = ev(['2026-11-18T10:00', '2026-11-18T11:00', '2026-11-18T12:00']);
  const L = layout(e, 'Asia/Kolkata');
  assert.deepEqual(L.mins, [870, 930, 990]);
  assert.equal(L.key('2026-11-18', 930), '2026-11-18T11:00');
});

test('layout keeps the rows a slot apart across the week the clocks differ', () => {
  const e = ev(['2026-10-27T15:00', '2026-11-03T15:00']);
  const L = layout(e, 'America/New_York');
  assert.deepEqual(L.mins, [540, 600]);
  assert.equal(L.key('2026-10-27', 600), '2026-10-27T15:00');
  assert.equal(L.key('2026-11-03', 540), '2026-11-03T15:00');
});
