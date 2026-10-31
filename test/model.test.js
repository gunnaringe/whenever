import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/model.js';

test('dates: validation, weekday, ISO week', () => {
  assert.ok(M.isDate('2026-02-28'));
  assert.ok(!M.isDate('2026-02-30'));
  assert.ok(!M.isDate('2026-2-3'));
  assert.equal(M.weekday('2026-11-02'), 0); // Monday
  assert.equal(M.weekday('2026-11-08'), 6); // Sunday
  assert.equal(M.isoWeek('2026-11-02'), 45);
  assert.equal(M.isoWeek('2027-01-01'), 53); // Friday in week 53 of 2026
  assert.equal(M.isoWeek('2026-01-01'), 1);
  assert.equal(M.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(M.dateRange('2026-11-29', '2026-12-02').length, 4);
  assert.deepEqual(M.monthsBetween('2026-11-20', '2027-01-03'), [[2026, 10], [2026, 11], [2027, 0]]);
});

test('Norwegian holidays', () => {
  assert.equal(M.easter(2026), '2026-04-05');
  assert.equal(M.easter(2027), '2027-03-28');
  const h = M.holidays(2026);
  assert.equal(h.get('2026-04-02'), 'maundyThursday');
  assert.equal(h.get('2026-04-03'), 'goodFriday');
  assert.equal(h.get('2026-05-14'), 'ascension');
  assert.equal(h.get('2026-05-25'), 'whitMonday');
  assert.equal(h.get('2026-05-17'), 'constitutionDay');
  assert.equal(h.size, 12);
  const dec = M.holidaysIn('2026-12-20', '2027-01-05');
  assert.deepEqual([...dec.keys()], ['2026-12-25', '2026-12-26', '2027-01-01']);
});

test('weekday chips only change the selection', () => {
  const days = M.dateRange('2026-11-02', '2026-11-15'); // two full weeks
  let sel = new Set(days);
  assert.equal(M.weekdayState(sel, days, 5), 'all');
  // Remove weekends, then put one Saturday back: single days stay selectable.
  sel = M.setDays(sel, days.filter(M.isWeekend), false);
  assert.equal(M.weekdayState(sel, days, 5), 'none');
  sel.add('2026-11-07');
  assert.equal(M.weekdayState(sel, days, 5), 'some');
  assert.equal(M.groupState(sel, days.filter(M.isWeekend)), 'some');
  assert.equal(M.weekdayState(sel, M.dateRange('2026-11-02', '2026-11-03'), 5), 'empty');
  assert.equal(M.groupState(sel, []), 'empty');
});

const datesEvent = {
  name: 'Julebord',
  mode: 'dates',
  start: '2026-11-02',
  end: '2026-11-30',
  options: ['2026-11-13', '2026-11-06', '2026-11-06', '2026-12-01', 'junk'],
};

test('sanitizeEvent: dates mode', () => {
  const r = M.sanitizeEvent(datesEvent);
  assert.ok(r.ok);
  assert.deepEqual(r.event.options, ['2026-11-06', '2026-11-13']); // sorted, deduplicated, in range
  assert.deepEqual(r.event.settings, M.DEFAULT_SETTINGS);
  assert.equal(M.sanitizeEvent({ ...datesEvent, name: '  ' }).error, 'name');
  assert.equal(M.sanitizeEvent({ ...datesEvent, end: '2026-11-01' }).error, 'range');
  assert.equal(M.sanitizeEvent({ ...datesEvent, end: '2028-01-01' }).error, 'rangeLong');
  assert.equal(M.sanitizeEvent({ ...datesEvent, options: [] }).error, 'options');
  assert.equal(M.sanitizeEvent({ ...datesEvent, name: 'a\u0000b\nc' }).event.name, 'a b c');
  assert.equal(M.sanitizeEvent({ ...datesEvent, settings: { openEdit: 'yes', hidden: true } }).event.settings.hidden, true);
  assert.equal(M.sanitizeEvent({ ...datesEvent, settings: { openEdit: 'yes' } }).event.settings.openEdit, false);
});

const timesEvent = {
  name: 'Møte',
  mode: 'times',
  start: '2026-11-02',
  end: '2026-11-04',
  slot: 30,
  dayStart: 540,
  dayEnd: 720,
  duration: 60,
  tz: 'Europe/Oslo',
  options: ['2026-11-02T09:00', '2026-11-02T09:30', '2026-11-02T10:00', '2026-11-02T08:30', '2026-11-02T09:15', '2026-11-03T11:30', '2026-11-03T12:00'],
};

test('sanitizeEvent: times mode', () => {
  const r = M.sanitizeEvent(timesEvent);
  assert.ok(r.ok);
  // 08:30 is before the window, 09:15 is off the slot grid, 12:00 is the end.
  assert.deepEqual(r.event.options, ['2026-11-02T09:00', '2026-11-02T09:30', '2026-11-02T10:00', '2026-11-03T11:30']);
  assert.equal(M.sanitizeEvent({ ...timesEvent, dayStart: 545 }).error, 'hours');
  assert.equal(M.sanitizeEvent({ ...timesEvent, end: '2027-01-30' }).error, 'rangeLong');
  assert.equal(M.sanitizeEvent({ ...timesEvent, tz: 'Mars/Olympus' }).event.tz, 'Europe/Oslo');
  assert.equal(M.sanitizeEvent({ ...timesEvent, duration: 50 }).event.duration, 60);
  assert.equal(M.sanitizeEvent({ ...timesEvent, duration: 9999 }).event.duration, 180);
});

test('sanitizeEntry and cleanAnswers', () => {
  const ev = M.sanitizeEvent(datesEvent).event;
  const r = M.sanitizeEntry({ name: ' Kari ', answers: { '2026-11-06': 1, '2026-11-13': 2, '2026-11-07': 1, x: 3 } }, ev);
  assert.ok(r.ok);
  assert.deepEqual(r.entry.answers, { '2026-11-06': 1, '2026-11-13': 2 });
  assert.equal(r.entry.name, 'Kari');
  assert.equal(r.entry.email, undefined); // not given: unchanged
  assert.equal(M.sanitizeEntry({ name: '' }, ev).error, 'personName');
  assert.equal(M.sanitizeEntry({ name: 'A', email: 'nope' }, ev).error, 'email');
  assert.equal(M.sanitizeEntry({ name: 'A', email: ' Kari@Example.no ' }, ev).entry.email, 'kari@example.no');
  assert.equal(M.sanitizeEntry({ name: 'A', email: '' }, ev).entry.email, '');
});

test('permissions', () => {
  const s = { ...M.DEFAULT_SETTINGS };
  const admin = { role: 'admin', me: null };
  const kari = { role: 'participant', me: 'k' };
  const guest = { role: 'visitor', me: null };
  assert.ok(M.canEdit(admin, { ...s, closed: true }, 'k'));
  assert.ok(M.canEdit(kari, s, 'k'));
  assert.ok(!M.canEdit(kari, s, 'o'));
  assert.ok(!M.canEdit(guest, s, 'k'));
  assert.ok(M.canEdit(guest, { ...s, openEdit: true }, 'k'));
  assert.ok(!M.canEdit(guest, { ...s, openEdit: true, hidden: true }, 'k'));
  assert.ok(!M.canEdit(kari, { ...s, closed: true }, 'k'));
  assert.ok(!M.canAdd(guest, { ...s, closed: true }));
  assert.ok(M.canAdd(admin, { ...s, closed: true }));
});

test('ranking: most people able to come, then most yes, then earliest', () => {
  const ev = M.sanitizeEvent({ ...datesEvent, options: ['2026-11-06', '2026-11-07', '2026-11-13', '2026-11-14'] }).event;
  const people = [
    { id: 'a', answers: { '2026-11-06': 1, '2026-11-07': 1, '2026-11-13': 2 } },
    { id: 'b', answers: { '2026-11-06': 2, '2026-11-07': 1, '2026-11-13': 1 } },
    { id: 'c', answers: { '2026-11-13': 1 } },
  ];
  const best = M.bestOptions(ev, people, 4);
  assert.deepEqual(best.map((b) => b.key), ['2026-11-13', '2026-11-07', '2026-11-06']);
  assert.deepEqual(best[0].no, []);
  assert.deepEqual(best[2].maybe, ['b']);
});

test('windows: consecutive slots, everyone available for the whole window', () => {
  const ev = M.sanitizeEvent({ ...timesEvent, options: ['2026-11-02T09:00', '2026-11-02T09:30', '2026-11-02T10:00', '2026-11-02T11:00', '2026-11-02T11:30'] }).event;
  const people = [
    { id: 'a', answers: { '2026-11-02T09:00': 1, '2026-11-02T09:30': 1, '2026-11-02T10:00': 1, '2026-11-02T11:00': 1, '2026-11-02T11:30': 1 } },
    { id: 'b', answers: { '2026-11-02T09:30': 1, '2026-11-02T10:00': 2, '2026-11-02T11:00': 1, '2026-11-02T11:30': 1 } },
  ];
  const ws = M.windows(ev, people);
  // 09:00-10:00, 09:30-10:30, 11:00-12:00 (10:00 + 11:00 aren't consecutive)
  assert.deepEqual(ws.map((w) => w.key), ['2026-11-02T09:00', '2026-11-02T09:30', '2026-11-02T11:00']);
  const best = M.bestWindows(ev, people, 3);
  assert.equal(best[0].key, '2026-11-02T11:00'); // both yes
  assert.deepEqual(best[0].yes, ['a', 'b']);
  assert.equal(best[1].key, '2026-11-02T09:30'); // b only if need be
  assert.deepEqual(best[1].maybe, ['b']);
  // 09:00 overlaps 09:30, so it's left out of the best list.
  assert.equal(best.length, 2);
});

test('expiry is 30 days after the last date', () => {
  const ev = M.sanitizeEvent(datesEvent).event;
  assert.equal(M.fromTime(M.expiresAt(ev)), M.addDays(ev.end, 31));
});
