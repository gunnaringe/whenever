import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, DESCRIPTION_MAX, pageMeta, previewLang } from '../src/worker/preview.ts';
import type { EventPreview } from '../src/worker/preview.ts';

const NB = 'https://finn-tid.apphub.casa';
const EN = 'https://whenever.apphub.casa';
const ev = (o: Partial<EventPreview> = {}): EventPreview => ({ name: 'Julebord 2026', description: '', mode: 'dates', closed: false, ...o });

test('the host picks the language', () => {
  assert.equal(previewLang('finn-tid.apphub.casa'), 'nb');
  assert.equal(previewLang('whenever.apphub.casa'), 'en');
  assert.equal(previewLang('127.0.0.1:8787'), 'nb');
});

test('without an event: the app, in the host language, with its own image', () => {
  const nb = pageMeta('finn-tid.apphub.casa', NB, null);
  assert.equal(nb.lang, 'nb');
  assert.equal(nb.title, 'Finn tid');
  assert.equal(nb.tags['og:title'], 'Finn tid');
  assert.equal(nb.tags['og:image'], `${NB}/og-nb.png`);
  assert.match(nb.tags['og:description'], /^Finn dagen eller tiden/);
  const en = pageMeta('whenever.apphub.casa', EN, null);
  assert.equal(en.tags['og:title'], 'Whenever');
  assert.equal(en.tags['og:image'], `${EN}/og-en.png`);
  assert.equal(en.tags['og:locale'], 'en_US');
  assert.match(en.tags.description, /^Find the day or time/);
});

test('an event: its name, what to do, then its description', () => {
  const m = pageMeta('finn-tid.apphub.casa', NB, ev({ description: 'Middag og quiz.\n\nSvar innen fredag!' }));
  assert.equal(m.tags['og:title'], 'Julebord 2026');
  assert.equal(m.title, 'Julebord 2026 · Finn tid');
  assert.equal(m.tags['og:site_name'], 'Finn tid');
  assert.equal(m.tags['og:description'], 'Kryss av for dagene som passer for deg. Middag og quiz. Svar innen fredag!');
  assert.equal(m.tags.description, m.tags['og:description']);
  assert.equal(pageMeta('whenever.apphub.casa', EN, ev({ mode: 'times' })).tags['og:description'], 'Mark the times that suit you.');
  assert.match(pageMeta('finn-tid.apphub.casa', NB, ev({ closed: true })).tags['og:description'], /^Avstemningen er stengt/);
});

test('long text is cut at a word, on one line', () => {
  const long = `${'ord '.repeat(80)}slutt`;
  const d = pageMeta('finn-tid.apphub.casa', NB, ev({ description: long })).tags['og:description'];
  assert.ok(d.length <= DESCRIPTION_MAX, `${d.length}`);
  assert.ok(d.endsWith('ord…'), d);
  assert.equal(clip('  a\n b  ', 10), 'a b');
  assert.equal(clip('abcdefghijklmnop', 8), 'abcdefg…');
  assert.equal(clip('Hei, verden. Dette er lang tekst', 16), 'Hei, verden…');
});

test('the tags carry nothing but the origin from the URL', () => {
  const m = pageMeta('finn-tid.apphub.casa', NB, ev());
  assert.ok(!('og:url' in m.tags));
  for (const v of Object.values(m.tags)) assert.ok(!v.includes('/e/'), v);
});
