// End-to-end check against `npm run dev` (wrangler dev).
// Screenshots go to $SHOTS (default /tmp/whenever-shots).
//   BASE=http://127.0.0.1:8787 npm run smoke
// Uses playwright-core, which brings no browser: set PWCHROME to a Chromium
// or chrome-headless-shell binary (e.g. under ~/.cache/ms-playwright/).
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS ?? '/tmp/whenever-shots';
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch({ executablePath: process.env.PWCHROME });
const errors = [];
async function page({ mobile = true, lang = 'nb-NO' } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1180, height: 900 },
    deviceScaleFactor: 2,
    locale: lang,
    timezoneId: 'Europe/Oslo',
    hasTouch: mobile,
  });
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
}
const shot = (p, name, full = true) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
const day = (p, d) => p.locator(`.cal-day[data-d="${d}"]`);

// Drag across time-grid cells with the mouse, from one key to another.
async function dragCells(p, from, to) {
  await p.locator(`.tg-cell[data-k="${from}"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const a = await p.locator(`.tg-cell[data-k="${from}"]`).boundingBox();
  const b = await p.locator(`.tg-cell[data-k="${to}"]`).boundingBox();
  await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await p.mouse.down();
  await p.mouse.move((a.x + b.x) / 2 + b.width / 2, (a.y + b.y) / 2 + b.height / 2, { steps: 4 });
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await p.mouse.up();
}

// The same as a finger: synthetic touch pointer events (the handlers don't
// care about the source, the CSS touch-action decides scrolling).
async function touchDrag(p, from, to) {
  await p.evaluate(
    ([f, t]) => {
      const el = (k) => document.querySelector(`.tg-cell[data-k="${k}"]`);
      const at = (e) => {
        const r = e.getBoundingClientRect();
        return { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      };
      const opts = { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0 };
      el(f).dispatchEvent(new PointerEvent('pointerdown', { ...opts, ...at(el(f)) }));
      el(t).dispatchEvent(new PointerEvent('pointermove', { ...opts, ...at(el(t)) }));
      el(t).dispatchEvent(new PointerEvent('pointerup', { ...opts, ...at(el(t)) }));
    },
    [from, to],
  );
}

// --- A) Organiser makes a dates event --------------------------------------------------
const admin = await page();
await admin.goto(`${BASE}/`);
await shot(admin, '01-home');
await admin.click('a[href="/new"]');
await admin.fill('form [name=name]', 'Julebord 2026');
await admin.fill('#ev-form [name=description]', 'Middag og quiz. Svar innen fredag!');
await admin.fill('[name=location]', 'Kantina');
await admin.fill('[name=start]', '2026-11-16');
await admin.fill('[name=end]', '2026-12-13');
await admin.locator('[name=end]').dispatchEvent('change');
check((await admin.locator('.cal-day.pick.on').count()) === 28, 'whole range picked by default (28 days)');

await admin.click('[data-act="sel-group"][data-g="weekends"]');
check((await admin.locator('.cal-day.pick.we.on').count()) === 0, 'weekend button drops every weekend day');
check(await admin.locator('[data-g="weekends"]').evaluate((b) => b.classList.contains('st-none')), 'weekend chip shows none');
await day(admin, '2026-11-28').click();
check(await day(admin, '2026-11-28').evaluate((b) => b.classList.contains('on')), 'one Saturday can be picked afterwards');
check(await admin.locator('[data-g="weekends"]').evaluate((b) => b.classList.contains('st-some')), 'weekend chip shows partly picked');
await admin.click('[data-act="sel-wd"][data-wd="0"]'); // drop Mondays
check((await admin.locator('.cal-day.pick.on').count()) === 21 - 4 + 0, 'Monday chip drops the four Mondays');
await admin.click('[data-act="sel-wd"][data-wd="0"]'); // and back
await shot(admin, '02-new-event');
await admin.click('button[type=submit]');
await admin.waitForURL(/\/e\/[A-Za-z0-9]{12}\/[0-9a-f]{16}[A-Za-z0-9_-]{22}$/);
const adminUrl = admin.url();
const eventUrl = adminUrl.replace(/\/[0-9a-f]{16}[A-Za-z0-9_-]{22}$/, '');
check(await admin.locator('.notice.ok').isVisible(), 'created notice shown');
check((await admin.locator('.share input').first().inputValue()) === eventUrl, 'share box has the event link');
await shot(admin, '03-created');

// --- B) Two participants answer --------------------------------------------------------
const kari = await page();
await kari.goto(eventUrl);
await kari.click('[data-act="answer"]');
await kari.fill('form [name=name]', 'Kari Nordmann');
await kari.fill('form [name=email]', 'kari@example.no');
await kari.fill('form [name=comment]', 'Helst fredag');
for (const d of ['2026-11-20', '2026-11-27', '2026-11-28', '2026-12-04']) await day(kari, d).click();
await day(kari, '2026-12-11').click();
await day(kari, '2026-12-11').click(); // twice = maybe
check(await day(kari, '2026-12-11').evaluate((b) => b.classList.contains('a2')), 'second tap is "maybe"');
await shot(kari, '04-answer-dates');
await kari.click('[data-act="save-answer"]');
await kari.waitForURL(/\/e\/[A-Za-z0-9]{12}\/[0-9a-f]{16}[A-Za-z0-9_-]{22}$/);
const kariUrl = kari.url();
check(kariUrl !== adminUrl && kariUrl.startsWith(eventUrl), 'Kari got her own link');
check(await kari.locator('.notice.ok .linkbox input').inputValue().then((v) => v === kariUrl), 'personal link shown after saving');
await shot(kari, '05-saved-personal-link');

const ola = await page({ lang: 'en-GB' });
await ola.goto(eventUrl);
check((await ola.locator('.brand span').textContent()) === 'Whenever', 'English browser gets English');
await ola.click('[data-act="answer"]');
await ola.fill('form [name=name]', 'Ola');
await ola.click('[data-act="ans-view"][data-v="list"]');
for (const d of ['2026-11-27', '2026-11-28']) await ola.click(`[data-act="ans-set"][data-k="${d}"][data-val="1"]`);
await ola.click('[data-act="ans-set"][data-k="2026-12-04"][data-val="2"]');
await ola.click('[data-act="save-answer"]');
await ola.waitForURL(/\/e\/[A-Za-z0-9]{12}\/[0-9a-f]{16}[A-Za-z0-9_-]{22}$/);

// --- C) Results --------------------------------------------------------------------------
await admin.reload();
await admin.waitForSelector('.best-item');
const first = await admin.locator('.best-item').first().getAttribute('data-k');
check(first === '2026-11-27', `best date is Friday 27 November (got ${first})`);
await admin.locator('.best-item').first().click();
check((await admin.locator('.detail .dg.yes .pn').count()) === 2, 'detail lists both people');
await shot(admin, '06-results-calendar');
await admin.click('[data-act="tab"][data-tab="table"]');
check((await admin.locator('.ptable tbody tr').count()) === 2, 'table has a row per person');
await shot(admin, '07-results-table');
await admin.click('[data-act="tab"][data-tab="list"]');
await shot(admin, '08-results-list');

// --- D) Permissions ------------------------------------------------------------------------
const guest = await page();
await guest.goto(eventUrl);
check((await guest.locator('[data-act="edit-entry"]').count()) === 0, 'a guest cannot edit anyone by default');
const kariPid = await admin.locator('[data-act="edit-entry"]').first().getAttribute('data-pid');
const res = await guest.evaluate(
  async ([u, pid]) => (await fetch(`/api/events/${u}/people/${pid}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', answers: {} }) })).status,
  [eventUrl.split('/').pop(), kariPid],
);
check(res === 403, 'API refuses a guest edit (403)');
errors.splice(0); // that 403 is logged by the browser on purpose

// Kari edits through her personal link, on another device.
const kari2 = await page();
await kari2.goto(kariUrl);
check((await kari2.locator('.role b').textContent()).includes('Kari'), 'personal link greets Kari on a new device');
await kari2.click('[data-act="answer"]');
check((await kari2.locator('form [name=email]').inputValue()) === 'kari@example.no', 'Kari sees her own email');
await day(kari2, '2026-11-20').click(); // yes -> maybe
await kari2.click('[data-act="save-answer"]');
await kari2.waitForSelector('.role');
check((await kari2.locator('.plist li.mine .psum').textContent()).includes('2 kanskje'), 'edit saved');
check((await admin.locator('.plist').textContent()).includes('Helst fredag'), 'comment visible to the admin');

// Admin turns on "everyone can edit"; now the guest can.
await admin.click('[data-act="edit-event"]');
await admin.check('[name="s-openEdit"]');
await admin.click('button[type=submit]');
await admin.waitForSelector('.role');
await guest.reload();
await guest.waitForSelector('.plist');
check((await guest.locator('[data-act="edit-entry"]').count()) === 2, 'with open editing, a guest can edit entries');

// Kari makes a new link: the old one stops working.
await kari2.click('[data-act="me-more"]');
await kari2.click('#dlg button[value="reset"]');
await kari2.click('#dlg button[value="yes"]');
await kari2.waitForSelector('#dlg .linkbox');
const kariNew = await kari2.locator('#dlg .linkbox input').inputValue();
check(kariNew !== kariUrl && kari2.url() === kariNew, 'new personal link replaces the old one');
await kari2.click('#dlg button[value=""]');
await kari.goto(kariUrl);
await kari.waitForSelector('.notice.warn');
check(await kari.locator('.notice.warn').isVisible(), 'old personal link says it no longer works');

// --- E) Times event on a desktop ---------------------------------------------------------
const boss = await page({ mobile: false });
await boss.goto(`${BASE}/new`);
await boss.fill('form [name=name]', 'Planleggingsmøte');
await boss.check('[name=mode][value=times]');
await boss.fill('[name=start]', '2026-11-16');
await boss.fill('[name=end]', '2026-11-22');
await boss.locator('[name=end]').dispatchEvent('change');
await boss.selectOption('[name=dayStart]', '480');
await boss.selectOption('[name=dayEnd]', '1080');
await boss.click('[data-act="sel-group"][data-g="weekends"]');
await boss.click('[data-act="preset"][data-p="work"]');
check((await boss.locator('#f-grid .tg-cell.v1').count()) === 5 * 16, 'working hours preset: 5 days x 16 slots');
await dragCells(boss, '2026-11-16T08:00', '2026-11-17T08:30'); // add 08:00-09:00 on Mon+Tue
check((await boss.locator('#f-grid .tg-cell.v1').count()) === 5 * 16 + 4, 'drag paints a rectangle');
await dragCells(boss, '2026-11-20T15:00', '2026-11-20T16:30'); // Friday afternoon off
const afterErase = await boss.locator('#f-grid .tg-cell.v1').count();
check(afterErase === 5 * 16 + 4 - 4, `drag from a marked cell erases (${afterErase})`);
await shot(boss, '09-new-times');
await boss.click('button[type=submit]');
await boss.waitForURL(/\/e\/[A-Za-z0-9]{12}\/[0-9a-f]{16}[A-Za-z0-9_-]{22}$/);
const timesUrl = boss.url().replace(/\/[0-9a-f]{16}[A-Za-z0-9_-]{22}$/, '');

for (const [name, from, to, maybeFrom, maybeTo] of [
  ['Anne', '2026-11-17T09:00', '2026-11-19T11:30', null, null],
  ['Per', '2026-11-18T10:00', '2026-11-20T12:30', '2026-11-17T10:00', '2026-11-17T11:30'],
  ['Lise', '2026-11-18T09:00', '2026-11-18T12:00', null, null],
]) {
  const pp = await page();
  await pp.goto(timesUrl);
  await pp.click('[data-act="answer"]');
  await pp.fill('form [name=name]', name);
  // Phones show 7 days per page; all five days fit.
  await touchDrag(pp, from, to);
  if (maybeFrom) {
    await pp.click('[data-act="ans-brush"][data-b="2"]');
    await touchDrag(pp, maybeFrom, maybeTo);
  }
  if (name === 'Per') await shot(pp, '10-answer-times');
  await pp.click('[data-act="save-answer"]');
  await pp.waitForURL(/\/e\/[A-Za-z0-9]{12}\/[0-9a-f]{16}[A-Za-z0-9_-]{22}$/);
}
await boss.reload();
await boss.waitForSelector('.best-item');
const bestTime = await boss.locator('.best-item').first().getAttribute('data-k');
check(bestTime === '2026-11-18T10:00', `best one-hour slot is Wednesday 10:00 (got ${bestTime})`);
await boss.locator('.tg-cell[data-k="2026-11-18T10:30"]').click();
check((await boss.locator('.detail .dg.yes .pn').count()) === 3, 'tapping a slot shows who can come');
await shot(boss, '11-results-times');

// --- F) Admin deletes an entry and the event --------------------------------------------
await admin.reload();
await admin.waitForSelector('.plist');
await admin.locator('[data-act="delete-entry"]').last().click();
await admin.click('#dlg button[value="yes"]');
await admin.waitForFunction(() => document.querySelectorAll('.plist li').length === 1);
check(true, 'admin deleted an entry');
await admin.goto(`${BASE}/`);
check((await admin.locator('.mine li').count()) >= 1, 'home lists your events on this device');
await shot(admin, '12-home-with-events');

check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
