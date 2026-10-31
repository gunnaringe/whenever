import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STRINGS, t, setLang } from '../public/i18n.js';

test('nb and en have the same keys', () => {
  const nb = Object.keys(STRINGS.nb).sort();
  const en = Object.keys(STRINGS.en).sort();
  assert.deepEqual(nb.filter((k) => !en.includes(k)), []);
  assert.deepEqual(en.filter((k) => !nb.includes(k)), []);
});

test('every literal t() key in the code exists', () => {
  const dir = new URL('../public/', import.meta.url);
  const missing = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\bt\('([A-Za-z0-9_.-]+)'/g)) if (!(m[1] in STRINGS.nb)) missing.push(`${f}: ${m[1]}`);
  }
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
