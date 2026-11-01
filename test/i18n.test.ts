import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STRINGS, t, setLang, holidayNames } from '../src/app/i18n.ts';
import { HOLIDAY_CALENDARS, holidays } from '../src/shared/model.ts';

test('nb and en have the same keys', () => {
  const nb = Object.keys(STRINGS.nb).sort();
  const en = Object.keys(STRINGS.en).sort();
  assert.deepEqual(nb.filter((k) => !en.includes(k)), []);
  assert.deepEqual(en.filter((k) => !nb.includes(k)), []);
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
