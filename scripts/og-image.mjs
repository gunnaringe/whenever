// Draws the link-preview cards public/og-nb.png and public/og-en.png
// (1200×630, what Messenger, Signal, Slack and the like show for a link).
// Run again after changing the name, the tagline or the icon, and commit the
// PNGs. Needs a Chromium for playwright-core, like the smoke test:
//   PWCHROME=/path/to/chrome-headless-shell node scripts/og-image.mjs
import { readFileSync, statSync } from 'node:fs';
import { chromium } from 'playwright-core';

const root = new URL('..', import.meta.url);
const font = (f) => readFileSync(new URL(`public/fonts/${f}`, root)).toString('base64');
const icon = readFileSync(new URL('public/icons/icon.svg', root), 'utf8');

const CARDS = {
  nb: { name: 'Finn tid', tagline: 'Finn dagen eller tiden som passer for flest' },
  en: { name: 'Whenever', tagline: 'Find the day or time that suits most people' },
};

// A row of days shaded by how many can, the best one ringed, as in the app.
const DAYS = [2, 4, 1, 3, 6, 5, 2];

const html = ({ name, tagline }) => `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: Fredoka; font-weight: 300 700; src: url(data:font/woff2;base64,${font('fredoka-latin.woff2')}) format("woff2"); }
  @font-face { font-family: Fredoka; font-weight: 300 700; src: url(data:font/woff2;base64,${font('fredoka-latin-ext.woff2')}) format("woff2");
    unicode-range: U+0100-024F, U+1E00-1EFF; }
  html, body { margin: 0; }
  body {
    width: 1200px; height: 630px; box-sizing: border-box;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
    font-family: Fredoka, sans-serif; color: #134e4a;
    background: #effcf8;
  }
  .icon svg { width: 148px; height: 148px; display: block; filter: drop-shadow(0 8px 18px rgba(15, 118, 110, .28)); }
  h1 { margin: 4px 0 0; font-size: 124px; line-height: 1; font-weight: 600; letter-spacing: -1px; }
  p { margin: 0; font-size: 44px; font-weight: 400; color: #3b5f5b; }
  .days { display: flex; gap: 16px; margin-top: 18px; }
  .days span {
    width: 74px; height: 74px; border-radius: 18px; display: grid; place-items: center;
    font-size: 36px; font-weight: 600; color: #fff;
  }
  .days .best { box-shadow: 0 0 0 6px #effcf8, 0 0 0 12px #f59e0b; }
</style>
<div class="icon">${icon}</div>
<h1>${name}</h1>
<p>${tagline}</p>
<div class="days">${DAYS.map((n) => {
  const top = Math.max(...DAYS);
  // From the app's soft yes green to its full yes green.
  const mix = n / top;
  const c = (a, b) => Math.round(a + (b - a) * mix);
  const bg = `rgb(${c(134, 21)}, ${c(222, 146)}, ${c(170, 74)})`;
  return `<span class="${n === top ? 'best' : ''}" style="background:${bg}">${n}</span>`;
}).join('')}</div>`;

const exe = process.env.PWCHROME;
if (!exe) throw new Error('Set PWCHROME to a Chromium or chrome-headless-shell binary');
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const [lang, card] of Object.entries(CARDS)) {
  await page.setContent(html(card));
  await page.evaluate(() => document.fonts.ready);
  const out = new URL(`public/og-${lang}.png`, root);
  await page.screenshot({ path: out.pathname, type: 'png' });
  console.log(`og-${lang}.png ${Math.round(statSync(out).size / 1024)} KB`);
}
await browser.close();
