import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STRINGS, LANGS, t, setLang, holidayNames, fmtDate, fmtRange, monthName, monthTitle, weekdayLong, shortDate, durationLabel } from '../src/app/i18n.ts';
import { HOLIDAY_CALENDARS, holidays } from '../src/shared/model.ts';

test('every language has the same keys as nb', () => {
  const nb = Object.keys(STRINGS.nb).sort();
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LANGS].sort());
  for (const l of LANGS) {
    const keys = Object.keys(STRINGS[l]);
    assert.deepEqual(nb.filter((k) => !keys.includes(k)), [], `${l} lacks`);
    assert.deepEqual(keys.filter((k) => !nb.includes(k)), [], `${l} has extra`);
  }
});

test('translations keep the placeholders', () => {
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  const bad = [];
  for (const l of LANGS) {
    for (const [k, src] of Object.entries(STRINGS.nb)) {
      const v = STRINGS[l][k as keyof typeof STRINGS.nb];
      const want = vars(typeof src === 'string' ? src : src.other);
      if (typeof v === 'string') {
        if (vars(v) !== want) bad.push(`${l} ${k}`);
      } else if (vars(v.other) !== want || !vars(v.one).split(',').every((x) => !x || want.includes(x))) bad.push(`${l} ${k}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('every literal t() key in the code exists', () => {
  const dir = new URL('../src/app/', import.meta.url);
  const files = readdirSync(dir).filter((x) => x.endsWith('.ts'));
  assert.ok(files.length >= 7, `only found ${files.join(', ')}`);
  const missing = [];
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\bt\('([A-Za-z0-9_.-]+)'/g)) {
      seen += 1;
      if (!(m[1] in STRINGS.nb)) missing.push(`${f}: ${m[1]}`);
    }
  }
  assert.ok(seen > 100, `only ${seen} t() calls found`);
  assert.deepEqual(missing, []);
});

test('every error code the server can send has a message', () => {
  const codes = new Set(['notFound', 'forbidden', 'closed', 'full', 'person', 'personName', 'email', 'name', 'range', 'rangeLong', 'hours', 'options', 'tooMany', 'rate', 'server']);
  for (const c of codes) assert.ok(`err.${c}` in STRINGS.nb, c);
});

test('plurals and placeholders', () => {
  setLang('nb');
  assert.equal(t('nDays', { n: 1 }), '1 dag valgt');
  assert.equal(t('nDays', { n: 3 }), '3 dager valgt');
  assert.equal(t('hiName', { name: 'Kari' }), 'Hei, Kari!');
  setLang('en');
  assert.equal(t('nOfM', { n: 2, m: 5 }), '2 of 5 can');
});

test('every holiday and holiday calendar has a name', () => {
  const keys = new Set<string>();
  for (const cal of HOLIDAY_CALENDARS) {
    assert.ok(`holidayCal.${cal}` in STRINGS.nb, cal);
    for (let y = 2020; y <= 2045; y++) for (const ks of holidays(y, cal).values()) for (const k of ks) keys.add(k);
  }
  assert.ok(keys.size >= 20, `only ${keys.size} holidays`);
  for (const k of keys) assert.ok(`holiday.${k}` in STRINGS.nb, k);
});

test('holidays on the same date are named together', () => {
  setLang('nb');
  assert.equal(holidayNames(['constitutionDay', 'whitMonday']), 'Grunnlovsdagen og 2. pinsedag');
  assert.equal(holidayNames(['christmasEve']), 'Julaften');
  setLang('en');
  assert.equal(holidayNames(['constitutionDay', 'whitMonday']), 'Constitution Day and Whit Monday');
});

test('Icelandic uses the singular for 21 but not for 11', () => {
  setLang('is');
  assert.equal(t('nDays', { n: 1 }), '1 dagur valinn');
  assert.equal(t('nDays', { n: 21 }), '21 dagur valinn');
  assert.equal(t('nDays', { n: 11 }), '11 dagar valdir');
  setLang('sv');
  assert.equal(t('nDays', { n: 21 }), '21 dagar valda');
});

// Chromium has no Intl data for nn and is, so the app formats those itself.
// Node has full ICU: its names must agree with ours.
test('nynorsk and Icelandic dates match the Intl names', () => {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  for (const [l, loc] of [['nn', 'nn-NO'], ['is', 'is-IS']] as const) {
    setLang(l);
    const intl = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { timeZone: 'UTC', ...o });
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 864e5) {
      const d = iso(t);
      assert.equal(fmtDate(d, 'full'), intl({ day: 'numeric', month: 'long', year: 'numeric' }).format(t), `${l} full ${d}`);
      assert.equal(fmtDate(d, 'medium'), intl({ weekday: 'short', day: 'numeric', month: 'short' }).format(t), `${l} medium ${d}`);
      // Newer CLDR drops the dot after the day in Norwegian; browsers keep it.
      assert.equal(fmtDate(d, 'long'), intl({ weekday: 'long', day: 'numeric', month: 'long' }).format(t).replace(/ (\d+) /, ' $1. '), `${l} long ${d}`);
      assert.equal(monthName(d), intl({ month: 'long' }).format(t), `${l} month ${d}`);
    }
    const wd = intl({ weekday: 'long' });
    assert.deepEqual(weekdayLong(), Array.from({ length: 7 }, (_, i) => wd.format(Date.UTC(2024, 0, 1 + i))));
    const range = intl({ day: 'numeric', month: 'long', year: 'numeric' });
    for (const [a, b] of [['2026-11-02', '2026-11-09'], ['2026-11-30', '2026-12-02'], ['2026-12-30', '2027-01-02'], ['2026-11-02', '2026-11-02']]) {
      assert.equal(fmtRange(a, b), a === b ? range.format(Date.parse(a)) : range.formatRange(Date.parse(a), Date.parse(b)), `${l} range ${a}..${b}`);
    }
  }
  setLang('nn');
  assert.equal(fmtDate('2026-11-02'), 'måndag 2. november');
  assert.equal(monthTitle(2026, 10), 'November 2026');
  setLang('is');
  assert.equal(fmtDate('2026-11-02'), 'mánudagur, 2. nóvember');
});

test('short dates, durations and "and" per language', () => {
  const at = (l: Parameters<typeof setLang>[0], f: () => string) => (setLang(l), f());
  assert.equal(at('nb', () => shortDate('2026-11-02')), '2.11.');
  assert.equal(at('da', () => shortDate('2026-11-02')), '2.11.');
  assert.equal(at('sv', () => shortDate('2026-11-02')), '2/11');
  assert.equal(at('en', () => shortDate('2026-11-02')), '2/11');
  assert.equal(at('nn', () => durationLabel(90)), '1 t 30 min');
  assert.equal(at('sv', () => durationLabel(90)), '1 tim 30 min');
  assert.equal(at('is', () => durationLabel(90)), '1 klst. 30 mín.');
  assert.equal(at('sv', () => holidayNames(['constitutionDay', 'whitMonday'])), 'Norges nationaldag och Annandag pingst');
});
