import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/shared/model.ts';
import { icsFor, icsName, zonedUtc } from '../src/app/ics.ts';

const iso = (t: number) => new Date(t).toISOString();

test('wall-clock time in a time zone to UTC, across daylight saving', () => {
  assert.equal(iso(zonedUtc('2026-11-18', 600, 'Europe/Oslo')), '2026-11-18T09:00:00.000Z'); // CET
  assert.equal(iso(zonedUtc('2026-07-01', 600, 'Europe/Oslo')), '2026-07-01T08:00:00.000Z'); // CEST
  assert.equal(iso(zonedUtc('2026-03-29', 180, 'Europe/Oslo')), '2026-03-29T01:00:00.000Z'); // just after the switch
  assert.equal(iso(zonedUtc('2026-11-18', 600, 'America/New_York')), '2026-11-18T15:00:00.000Z');
  assert.equal(iso(zonedUtc('2026-11-18', 600, 'UTC')), '2026-11-18T10:00:00.000Z');
});

function event(input: unknown): M.PollEvent {
  const r = M.sanitizeEvent(input);
  assert.ok(r.ok);
  return r.event;
}

test('an all-day event for a picked date', () => {
  const ev = event({ name: 'Julebord, 2026', location: 'Kantina', description: 'Middag; quiz', mode: 'dates', start: '2026-11-27', end: '2026-11-28', options: ['2026-11-27', '2026-11-28'], decided: '2026-11-27' });
  const ics = icsFor(ev, 'abc', 'https://finn-tid.apphub.casa/e/abc', Date.UTC(2026, 9, 31, 12));
  assert.ok(ics);
  assert.ok(ics.includes('\r\nDTSTART;VALUE=DATE:20261127\r\nDTEND;VALUE=DATE:20261128\r\n'));
  assert.ok(ics.includes('\r\nSUMMARY:Julebord\\, 2026\r\n'));
  assert.ok(ics.includes('\r\nLOCATION:Kantina\r\n'));
  assert.ok(ics.includes('DESCRIPTION:Middag\; quiz\\n\\nhttps://finn-tid.apphub.casa/e/abc'));
  assert.ok(ics.includes('\r\nDTSTAMP:20261031T120000Z\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(icsFor({ ...ev, decided: undefined }, 'abc', 'x'), null);
});

test('a timed event for a picked window', () => {
  const options = ['2026-11-18T10:00', '2026-11-18T10:30', '2026-11-18T11:00'];
  const ev = event({ name: 'Møte', mode: 'times', start: '2026-11-18', end: '2026-11-18', slot: 30, dayStart: 540, dayEnd: 720, duration: 60, tz: 'Europe/Oslo', options, decided: '2026-11-18T10:00' });
  const ics = icsFor(ev, 'abc', 'https://x/e/abc');
  assert.ok(ics?.includes('\r\nDTSTART:20261118T090000Z\r\nDTEND:20261118T100000Z\r\n'));
});

test('long lines are folded at 75 octets', () => {
  const ev = event({ name: 'Ø'.repeat(60), mode: 'dates', start: '2026-11-27', end: '2026-11-27', options: ['2026-11-27'], decided: '2026-11-27' });
  const lines = (icsFor(ev, 'abc', 'https://x') ?? '').split('\r\n');
  for (const l of lines) assert.ok(new TextEncoder().encode(l).length <= 75, l);
  assert.ok(lines.some((l) => l.startsWith(' Ø')));
  assert.equal(icsName('Julebord 2026!'), 'julebord-2026.ics');
  assert.equal(icsName('???'), 'event.ics');
});
