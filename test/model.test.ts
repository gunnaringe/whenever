import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/shared/model.ts';

// A valid result's value, or a failed one's error code.
function event(input: unknown): M.PollEvent {
  const r = M.sanitizeEvent(input);
  assert.ok(r.ok);
  return r.event;
}
function times(input: unknown): M.TimesEvent {
  const ev = event(input);
  assert.ok(ev.mode === 'times');
  return ev;
}
const eventError = (input: unknown) => {
  const r = M.sanitizeEvent(input);
  return r.ok ? null : r.error;
};
function entry(input: unknown, ev: M.PollEvent): M.Entry {
  const r = M.sanitizeEntry(input, ev);
  assert.ok(r.ok);
  return r.entry;
}
const entryError = (input: unknown, ev: M.PollEvent) => {
  const r = M.sanitizeEntry(input, ev);
  return r.ok ? null : r.error;
};
type Answered = Pick<M.Person, 'id' | 'answers'>;

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
  assert.equal(M.monthStart('2026-10-31', 1), '2026-11-01');
  assert.equal(M.monthEnd('2026-10-31'), '2026-10-31');
  assert.equal(M.monthEnd('2026-10-31', 1), '2026-11-30');
  assert.equal(M.monthEnd('2026-12-15', 2), '2027-02-28');
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
  assert.equal(eventError({ ...datesEvent, name: '  ' }), 'name');
  assert.equal(eventError({ ...datesEvent, end: '2026-11-01' }), 'range');
  assert.equal(eventError({ ...datesEvent, end: '2028-01-01' }), 'rangeLong');
  assert.equal(eventError({ ...datesEvent, options: [] }), 'options');
  assert.equal(event({ ...datesEvent, name: 'a\u0000b\nc' }).name, 'a b c');
  assert.equal(event({ ...datesEvent, settings: { openEdit: 'yes', hidden: true } }).settings.hidden, true);
  assert.equal(event({ ...datesEvent, settings: { openEdit: 'yes' } }).settings.openEdit, false);
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
  assert.equal(eventError({ ...timesEvent, dayStart: 545 }), 'hours');
  assert.equal(eventError({ ...timesEvent, end: '2027-01-30' }), 'rangeLong');
  assert.equal(times({ ...timesEvent, tz: 'Mars/Olympus' }).tz, 'Europe/Oslo');
  assert.equal(times({ ...timesEvent, duration: 50 }).duration, 60);
  assert.equal(times({ ...timesEvent, duration: 9999 }).duration, 180);
});

test('sanitizeEntry and cleanAnswers', () => {
  const ev = event(datesEvent);
  const r = M.sanitizeEntry({ name: ' Kari ', answers: { '2026-11-06': 1, '2026-11-13': 2, '2026-11-07': 1, x: 3 } }, ev);
  assert.ok(r.ok);
  assert.deepEqual(r.entry.answers, { '2026-11-06': 1, '2026-11-13': 2 });
  assert.equal(r.entry.name, 'Kari');
  assert.equal(r.entry.email, undefined); // not given: unchanged
  assert.equal(entryError({ name: '' }, ev), 'personName');
  assert.equal(entryError({ name: 'A', email: 'nope' }, ev), 'email');
  assert.equal(entry({ name: 'A', email: ' Kari@Example.no ' }, ev).email, 'kari@example.no');
  assert.equal(entry({ name: 'A', email: '' }, ev).email, '');
});

test('permissions', () => {
  const s = { ...M.DEFAULT_SETTINGS };
  const admin = { role: 'admin', me: null } as const;
  const kari = { role: 'participant', me: 'k' } as const;
  const guest = { role: 'visitor', me: null } as const;
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

test('ranking: most yes first and maybe breaks ties, unless maybe counts', () => {
  const options = ['2026-11-06', '2026-11-07', '2026-11-13', '2026-11-14'];
  const people: Answered[] = [
    { id: 'a', answers: { '2026-11-06': 1, '2026-11-07': 1, '2026-11-13': 2, '2026-11-14': 2 } },
    { id: 'b', answers: { '2026-11-06': 2, '2026-11-07': 1, '2026-11-13': 1, '2026-11-14': 2 } },
    { id: 'c', answers: { '2026-11-13': 1, '2026-11-14': 2 } },
  ];
  // 06: 1 yes + 1 maybe, 07: 2 yes, 13: 2 yes + 1 maybe, 14: 3 maybe.
  const yesFirst = event({ ...datesEvent, options });
  assert.equal(yesFirst.settings.maybeCounts, false);
  const best = M.bestOptions(yesFirst, people, 4);
  assert.deepEqual(best.map((b) => b.key), ['2026-11-13', '2026-11-07', '2026-11-06', '2026-11-14']);
  assert.deepEqual(best.map((b) => M.score(b, yesFirst.settings)), [2, 2, 1, 0]);
  assert.deepEqual(best[0].no, []);

  const counting = event({ ...datesEvent, options, settings: { maybeCounts: true } });
  const best2 = M.bestOptions(counting, people, 4);
  assert.deepEqual(best2.map((b) => b.key), ['2026-11-13', '2026-11-14', '2026-11-07', '2026-11-06']);
  assert.deepEqual(best2.map((b) => M.score(b, counting.settings)), [3, 3, 2, 2]);

  // Darker never ranks lower.
  for (const [ev, list] of [[yesFirst, best], [counting, best2]] as const) {
    const h = list.map((b) => M.heat(b, people.length, ev.settings));
    for (let i = 1; i < h.length; i++) assert.ok(h[i - 1] > h[i], `${list[i - 1].key} is darker than ${list[i].key}`);
    assert.ok(h.every((x) => x > 0 && x <= 1));
  }
  const all: M.Tally = { key: 'x', yes: ['a', 'b', 'c'], maybe: [], no: [] };
  assert.equal(M.heat(all, 3, yesFirst.settings), 1);
  assert.equal(M.heat(all, 3, counting.settings), 1);
  assert.equal(M.heat(all, 0, counting.settings), 0);
});

test('equally good options share a rank', () => {
  const options = ['2026-11-06', '2026-11-07', '2026-11-13', '2026-11-14'];
  const people: Answered[] = [
    { id: 'a', answers: { '2026-11-06': 1, '2026-11-07': 1, '2026-11-13': 1, '2026-11-14': 2 } },
    { id: 'b', answers: { '2026-11-06': 1, '2026-11-07': 1, '2026-11-13': 2, '2026-11-14': 1 } },
  ];
  const ev = event({ ...datesEvent, options });
  const best = M.bestOptions(ev, people, 4);
  // 06 and 07: both yes. 13 and 14: one yes, one maybe.
  assert.deepEqual(best.map((b) => b.key), options);
  assert.deepEqual(M.ranks(best, ev.settings), [1, 1, 3, 3]);
  // Counting maybe, two can come on all four days, and yes breaks the tie.
  const counting = { maybeCounts: true };
  assert.deepEqual(M.ranks(best, counting), [1, 1, 3, 3]);
  const allMaybe = M.bestOptions(event({ ...datesEvent, options, settings: { maybeCounts: true } }), [{ id: 'a', answers: { '2026-11-06': 2, '2026-11-07': 2 } }], 4);
  assert.deepEqual(M.ranks(allMaybe, counting), [1, 1]);
  assert.deepEqual(M.ranks([], counting), []);
});

test('windows: consecutive slots, everyone available for the whole window', () => {
  const ev = event({ ...timesEvent, options: ['2026-11-02T09:00', '2026-11-02T09:30', '2026-11-02T10:00', '2026-11-02T11:00', '2026-11-02T11:30'] });
  const people: Answered[] = [
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

test('the organiser\'s pick must fit the options', () => {
  const ev = event({ ...datesEvent, decided: '2026-11-13' });
  assert.equal(ev.decided, '2026-11-13');
  assert.equal(event({ ...datesEvent, decided: '2026-11-14' }).decided, undefined);
  const people: Answered[] = [{ id: 'a', answers: { '2026-11-13': 1 } }];
  assert.deepEqual(M.decision(ev, people)?.yes, ['a']);
  // Times: the start of a whole one-hour window, not just any slot.
  const tm = times({ ...timesEvent, decided: '2026-11-02T09:00' });
  assert.equal(tm.decided, '2026-11-02T09:00');
  assert.equal(times({ ...timesEvent, decided: '2026-11-02T10:00' }).decided, undefined); // 10:30 isn't offered
  assert.equal(times({ ...timesEvent, decided: '2026-11-03T11:30' }).decided, undefined); // 12:00 is the end of the day
  const w = M.decision(tm, []);
  assert.ok(w && 'date' in w && w.start === 540 && w.end === 600);
});

test('expiry is 30 days after the last date', () => {
  const ev = event(datesEvent);
  assert.equal(M.fromTime(M.expiresAt(ev)), M.addDays(ev.end, 31));
});
