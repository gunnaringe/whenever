// End-to-end check against `npm run dev` (wrangler dev).
// Screenshots go to $SHOTS (default /tmp/whenever-shots).
//   BASE=http://127.0.0.1:8787 npm run smoke
// Uses playwright-core, which brings no browser: set PWCHROME to a Chromium
// or chrome-headless-shell binary (e.g. under ~/.cache/ms-playwright/).
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { holidaysIn } from '../src/shared/model.ts';

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
// refused: the page gets 4xx answers on purpose, so the browser's
// "Failed to load resource" lines aren't errors there.
async function page({ mobile = true, lang = 'nb-NO', refused = false } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1180, height: 900 },
    deviceScaleFactor: 2,
    locale: lang,
    timezoneId: 'Europe/Oslo',
    hasTouch: mobile,
  });
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && !(refused && m.text().startsWith('Failed to load resource')) && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
}
// Dates relative to today, so every picked day is in the future: D(0) is a
// Monday 7 to 13 days ahead, D(25) at most 38 days ahead (the form shows at
// least six weeks).
const DAY = 864e5;
const now = new Date();
const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const dow = (t) => (new Date(t).getUTCDay() + 6) % 7; // 0 = Monday
const base = today + (7 + ((7 - dow(today)) % 7)) * DAY;
const D = (n, time) => iso(base + n * DAY) + (time ? `T${time}` : '');
const firstSaturday = iso(today + ((5 - dow(today) + 7) % 7) * DAY);

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

// The same as a finger: synthetic touch pointer events. A finger has to hold
// still for a moment before it paints (hold = false: a swipe, which the
// grid leaves to the browser for scrolling). These events never scroll the
// page; real touch scrolling is checked by hand (see CLAUDE.md).
async function touchDrag(p, from, to, hold = true) {
  await p.evaluate(
    async ([f, t, hold]) => {
      const el = (k) => document.querySelector(`.tg-cell[data-k="${k}"]`);
      const at = (e) => {
        const r = e.getBoundingClientRect();
        return { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      };
      const opts = { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0 };
      el(f).dispatchEvent(new PointerEvent('pointerdown', { ...opts, ...at(el(f)) }));
      if (hold) await new Promise((r) => setTimeout(r, 450));
      el(t).dispatchEvent(new PointerEvent('pointermove', { ...opts, ...at(el(t)) }));
      el(t).dispatchEvent(new PointerEvent(hold ? 'pointerup' : 'pointercancel', { ...opts, ...at(el(t)) }));
    },
    [from, to, hold],
  );
}

// The same for calendar days: hold a day, then drag to another (hold = false:
// a swipe, which has to leave the days alone).
async function touchRange(p, from, to, hold = true) {
  await p.locator(`.cal-day[data-d="${from}"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await p.evaluate(
    async ([f, t, hold]) => {
      const el = (d) => document.querySelector(`.cal-day[data-d="${d}"]`);
      const at = (e) => {
        const r = e.getBoundingClientRect();
        return { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      };
      const opts = { bubbles: true, pointerId: 9, pointerType: 'touch', isPrimary: true, button: 0 };
      el(f).dispatchEvent(new PointerEvent('pointerdown', { ...opts, ...at(el(f)) }));
      if (hold) await new Promise((r) => setTimeout(r, 450));
      el(f).dispatchEvent(new PointerEvent('pointermove', { ...opts, ...at(el(t)) }));
      el(f).dispatchEvent(new PointerEvent(hold ? 'pointerup' : 'pointercancel', { ...opts, ...at(el(t)) }));
    },
    [from, to, hold],
  );
}

// Press on one day and drag the mouse to others, then let go.
async function mouseRange(p, from, ...to) {
  await day(p, from).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = async (d) => {
    const b = await day(p, d).boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  await p.mouse.move(...(await box(from)));
  await p.mouse.down();
  for (const d of to) await p.mouse.move(...(await box(d)), { steps: 2 });
  await p.mouse.up();
}

// --- A) Organiser makes a dates event --------------------------------------------------
const admin = await page();
await admin.goto(`${BASE}/`);
await shot(admin, '01-home');
await admin.click('a[href="/new"]');
await admin.fill('form [name=name]', 'Julebord 2026');
await admin.click('#ev-form .fold summary'); // description and place are folded away
await admin.fill('#ev-form [name=description]', 'Middag og quiz. Svar innen fredag!');
await admin.fill('[name=location]', 'Kantina');
const picked = (p) => p.locator('#f-cal .cal-day.pick.on').count();
check((await picked(admin)) === 0, 'nothing is picked to begin with');
await admin.click('[data-act="period"][data-p="4w"]');
check((await picked(admin)) === 28, '"Next 4 weeks" picks 28 days');
await admin.click('[data-act="sel-group"][data-g="weekends"]');
check((await admin.locator('.cal-day.pick.we.on').count()) === 0 && (await picked(admin)) === 20, 'weekend button drops the weekends');
check(await admin.locator('[data-g="weekends"]').evaluate((b) => b.classList.contains('st-none')), 'weekend chip shows none');
await day(admin, firstSaturday).click();
check(await day(admin, firstSaturday).evaluate((b) => b.classList.contains('on')), 'one Saturday can be picked afterwards');
check(await admin.locator('[data-g="weekends"]').evaluate((b) => b.classList.contains('st-some')), 'weekend chip shows partly picked');
await admin.click('[data-act="sel-none"]');
check((await picked(admin)) === 0, '"None" clears the selection');

// Ranges: drag, drag back, Shift-click, Shift+Enter.
await mouseRange(admin, D(0), D(9));
check((await picked(admin)) === 10, `dragging from one day to another picks every day between (${await picked(admin)})`);
await admin.click('[data-act="sel-none"]');
await mouseRange(admin, D(0), D(9), D(4));
check((await picked(admin)) === 5 && !(await day(admin, D(5)).evaluate((b) => b.classList.contains('on'))), 'dragging back gives the days left behind their old state');
await mouseRange(admin, D(2), D(3));
check((await picked(admin)) === 3, 'a drag starting on a picked day unpicks the range');
await day(admin, D(14)).click();
await day(admin, D(16)).click({ modifiers: ['Shift'] });
check((await picked(admin)) === 6, 'Shift-click picks from the last day clicked');
await day(admin, D(20)).focus();
await admin.keyboard.press('Enter');
await day(admin, D(22)).focus();
await admin.keyboard.press('Shift+Enter');
check((await picked(admin)) === 9, 'Shift+Enter does the same from the keyboard');
check((await admin.locator('#f-count').textContent()).includes('9'), 'the count line follows ranges');
await admin.click('[data-act="sel-none"]');

// The event: weekdays D(0)..D(25) and the Saturday D(12).
await admin.click('[data-act="more-months"]');
for (let n = 0; n <= 25; n++) if (n % 7 < 5 || n === 12) await day(admin, D(n)).click();
check((await picked(admin)) === 21, 'days picked by hand (21)');
await admin.click('[data-act="sel-wd"][data-wd="2"]'); // Wednesdays are picked: drop them
check((await picked(admin)) === 17, 'Wednesday chip drops the four Wednesdays');
for (const n of [2, 9, 16, 23]) await day(admin, D(n)).click();
check((await admin.locator('#f-count').textContent()).includes('21'), 'the count line says 21 days');
const maybeCounts = admin.locator('[name=s-maybeCounts]');
check((await maybeCounts.isEnabled()) && !(await maybeCounts.isChecked()), '"maybe counts" is off by default');
await admin.locator('[name=s-maybe]').uncheck();
check(await maybeCounts.isDisabled(), '"maybe counts" is disabled without maybe answers');
await admin.locator('#ev-form .card:has([name=s-maybe])').screenshot({ path: `${SHOTS}/02b-settings-no-maybe.png` });
await admin.locator('[name=s-maybe]').check();
check(await maybeCounts.isEnabled(), '"maybe counts" is enabled again with maybe answers');
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
check(
  await kari.evaluate(() => document.querySelector('#pick-area').getBoundingClientRect().top < document.querySelector('#answer-form').getBoundingClientRect().top),
  'the days come before the name fields',
);
await kari.click('#answer-form .fold summary'); // email is folded away
await kari.fill('form [name=email]', 'kari@example.no');
await kari.fill('form [name=comment]', 'Helst fredag');
// A finger: hold a day and drag; the range gets the first day's next answer.
const ans = (p, cls) => p.locator(`#pick-area .cal-day.${cls}`).count();
await touchRange(kari, D(0), D(3), false);
check((await ans(kari, 'a1')) + (await ans(kari, 'a2')) === 0, 'a swipe over the days changes nothing');
await touchRange(kari, D(0), D(3));
check((await ans(kari, 'a1')) === 4, `hold and drag answers "yes" for the whole range (${await ans(kari, 'a1')})`);
await touchRange(kari, D(0), D(3));
check((await ans(kari, 'a2')) === 4 && (await ans(kari, 'a1')) === 0, 'again: "maybe" for the whole range');
await touchRange(kari, D(0), D(3));
check((await ans(kari, 'a1')) + (await ans(kari, 'a2')) === 0, 'and again clears it');
for (const n of [4, 11, 12, 18]) await day(kari, D(n)).click();
await day(kari, D(25)).click();
await day(kari, D(25)).click(); // twice = maybe
check(await day(kari, D(25)).evaluate((b) => b.classList.contains('a2')), 'second tap is "maybe"');
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
for (const n of [11, 12]) await ola.click(`[data-act="ans-set"][data-k="${D(n)}"][data-val="1"]`);
await ola.click(`[data-act="ans-set"][data-k="${D(18)}"][data-val="2"]`);
await ola.click('[data-act="save-answer"]');
await ola.waitForURL(/\/e\/[A-Za-z0-9]{12}\/[0-9a-f]{16}[A-Za-z0-9_-]{22}$/);

// --- C) Results --------------------------------------------------------------------------
await admin.reload();
await admin.waitForSelector('.best-item');
const first = await admin.locator('.best-item').first().getAttribute('data-k');
check(first === D(11), `best date is the second Friday, ${D(11)} (got ${first})`);
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
await day(kari2, D(4)).click(); // yes -> maybe
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
check((await picked(boss)) === 0, 'times mode starts with nothing picked too');
await boss.click('[data-act="period"][data-p="2w"]');
check((await picked(boss)) === 14, '"Next 2 weeks" picks 14 days');
await boss.click('[data-act="sel-none"]');
// Drag across Monday to Friday with the mouse.
{
  const a = await day(boss, D(0)).boundingBox();
  const b = await day(boss, D(4)).boundingBox();
  await boss.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await boss.mouse.down();
  await boss.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await boss.mouse.up();
}
check((await picked(boss)) === 5, 'dragging across the calendar picks five days');
check((await boss.locator('#f-grid .tg-cell.v1').count()) === 5 * 16, 'picked days start with 9-17');
await boss.selectOption('[name=dayStart]', '480');
await boss.selectOption('[name=dayEnd]', '1080');
await boss.click('[data-act="preset"][data-p="work"]');
check((await boss.locator('#f-grid .tg-cell.v1').count()) === 5 * 16, 'working hours preset: 5 days x 16 slots');
await dragCells(boss, D(0, '08:00'), D(1, '08:30')); // add 08:00-09:00 on Mon+Tue
check((await boss.locator('#f-grid .tg-cell.v1').count()) === 5 * 16 + 4, 'drag paints a rectangle');
await dragCells(boss, D(4, '15:00'), D(4, '16:30')); // Friday afternoon off
const afterErase = await boss.locator('#f-grid .tg-cell.v1').count();
check(afterErase === 5 * 16 + 4 - 4, `drag from a marked cell erases (${afterErase})`);
await shot(boss, '09-new-times');
await boss.click('button[type=submit]');
await boss.waitForURL(/\/e\/[A-Za-z0-9]{12}\/[0-9a-f]{16}[A-Za-z0-9_-]{22}$/);
const timesUrl = boss.url().replace(/\/[0-9a-f]{16}[A-Za-z0-9_-]{22}$/, '');

for (const [name, from, to, maybeFrom, maybeTo] of [
  ['Anne', D(1, '09:00'), D(3, '11:30'), null, null],
  ['Per', D(2, '10:00'), D(4, '12:30'), D(1, '10:00'), D(1, '11:30')],
  ['Lise', D(2, '09:00'), D(2, '12:00'), null, null],
]) {
  const pp = await page();
  await pp.goto(timesUrl);
  await pp.click('[data-act="answer"]');
  await pp.fill('form [name=name]', name);
  // Phones show a week per page; all five days fit.
  if (name === 'Anne') {
    await touchDrag(pp, from, to, false);
    check((await pp.locator('#pick-area .tg-cell.v1').count()) === 0, 'a swipe without holding paints nothing');
  }
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
check(bestTime === D(2, '10:00'), `best one-hour slot is Wednesday 10:00 (got ${bestTime})`);
await boss.locator(`.tg-cell[data-k="${D(2, '10:30')}"]`).click();
check((await boss.locator('.detail .dg.yes .pn').count()) === 3, 'tapping a slot shows who can come');
await shot(boss, '11-results-times');

// The organiser picks the best time; it shows as a whole window.
await boss.locator('.best-item').first().click();
await boss.click('.detail [data-act="decide"]');
await boss.click('#dlg button[value="yes"]');
await boss.waitForSelector('.decided');
check((await boss.locator('.decided .when').textContent()).includes('10:00–11:00'), 'picked time shows as the whole window');
const framed = await boss.locator('#res-grid .tg-cell.decided').count();
check(framed >= 1 && (await boss.locator('#res-grid .tg-cell.dstart').count()) === 1 && (await boss.locator('#res-grid .tg-cell.dend').count()) === 1, `the time grid frames the picked window (${framed} cells)`);
check((await boss.locator('.legend').textContent()).includes('Valgt'), 'and the legend explains the frame');
await boss.locator('.results').screenshot({ path: `${SHOTS}/27-decided-grid.png` });

// --- G) The organiser picks the date ---------------------------------------------------------
await admin.reload();
await admin.waitForSelector('.best-item');
await admin.locator('.best-item').first().click();
await admin.click('.detail [data-act="decide"]');
await admin.click('#dlg button[value="yes"]');
await admin.waitForSelector('.decided');
check(await admin.locator('.best-item .tag').first().isVisible(), 'the best list marks the pick');
check((await admin.locator('.cal-day.decided .dk').count()) === 1, 'the calendar marks the picked date with a badge');
check((await admin.locator('.legend').textContent()).includes('Valgt'), 'and the legend says what the badge means');
await admin.locator('.results').screenshot({ path: `${SHOTS}/26-decided-calendar.png` });
await admin.click('[data-act="tab"][data-tab="list"]');
check((await admin.locator('.res-row.decided .tag').count()) === 1, 'the list marks it too');
await admin.click('[data-act="tab"][data-tab="table"]');
check((await admin.locator('.ptable th.decided .dk').count()) === 1, 'and the table');
await admin.click('[data-act="tab"][data-tab="cal"]');
await guest.reload();
await guest.waitForSelector('.decided');
check((await guest.locator('.decided [data-act="undecide"]').count()) === 0, 'everyone sees the pick; only the admin can undo it');
check((await guest.locator('[data-act="answer"]').count()) === 0, 'picking closes the event for new answers');
const [dl] = await Promise.all([guest.waitForEvent('download'), guest.click('.decided [data-act="ics"]')]);
const ics = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
check(dl.suggestedFilename() === 'julebord-2026.ics' && ics.includes(`DTSTART;VALUE=DATE:${D(11).replace(/-/g, '')}`), `calendar file for the picked date (${dl.suggestedFilename()})`);
check(!/[0-9a-f]{16}[A-Za-z0-9_-]{22}/.test(ics), 'the calendar file has no link secret in it');
await admin.click('.decided [data-act="undecide"]');
await admin.click('#dlg button[value="yes"]');
await admin.waitForSelector('.decided', { state: 'detached' });
check(true, 'the admin can undo the pick');

// --- H) Ranking: yes first, maybe only orders a draw, unless maybe counts -----------------
// D(0), D(1), D(4), D(5): Kari and Ola yes, D(1) also Per maybe. D(2): everyone
// maybe. D(3): Kari yes, Per maybe.
const rk = await page();
await rk.goto(`${BASE}/`);
async function rankedEvent(maybeCounts) {
  return rk.evaluate(
    async ([days, maybeCounts]) => {
      const api = async (path, body) => (await fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      const [d0, d1, d2, d3, d4, d5] = days;
      const r = await api('/events', { event: { name: 'Rangering', mode: 'dates', start: d0, end: d5, options: days, settings: { maybeCounts } }, email: '' });
      const people = [
        ['Kari', { [d0]: 1, [d1]: 1, [d2]: 2, [d3]: 1, [d4]: 1, [d5]: 1 }],
        ['Ola', { [d0]: 1, [d1]: 1, [d2]: 2, [d4]: 1, [d5]: 1 }],
        ['Per', { [d1]: 2, [d2]: 2, [d3]: 2 }],
      ];
      for (const [name, answers] of people) await api(`/events/${r.id}/people`, { name, answers });
      return `/e/${r.id}/${r.token}`;
    },
    [[0, 1, 2, 3, 4, 5].map((n) => D(n)), maybeCounts],
  );
}
const rankOf = (p) => p.locator('.best-item .rank').allTextContents();
await rk.goto(BASE + (await rankedEvent(false)));
await rk.waitForSelector('.best-item');
check((await rankOf(rk)).join() === '1,1,1', `days with as many yes share first place (${(await rankOf(rk)).join()})`);
check((await rk.locator('.best-item.first').count()) === 3, 'all of them are marked as best');
check((await rk.locator('.best-item').first().getAttribute('data-k')) === D(1), 'the one with a maybe more is listed first, still a draw');
check((await rk.locator('.best-more').textContent()).includes('1'), 'the fourth equally good day is mentioned');
check((await rk.locator('.cal-day.res.top').count()) === 4, 'the calendar rings all four');
check((await rk.locator(`.cal-day[data-k="${D(2)}"] .dc`).textContent()) === '', 'a day with only maybes shows no count');
check((await rk.locator('.best-item .bn').first().textContent()) === '2 av 3 kan · 1 kanskje', 'yes is the count');
check((await rk.locator('.best-how').textContent()).includes('flest ja'), 'the ranking is explained');
await rk.locator('.results').screenshot({ path: `${SHOTS}/13-ranking-yes-first.png` });
await rk.goto(BASE + (await rankedEvent(true)));
await rk.waitForSelector('.best-item');
check((await rankOf(rk)).join() === '1,1,3', `with "maybe counts", the two days all three may come share first place (${(await rankOf(rk)).join()})`);
check((await rk.locator('.best-item').nth(1).getAttribute('data-k')) === D(2), 'the one with fewer yes is listed second');
check((await rk.locator('.best-item .bn').first().textContent()) === '3 av 3 kan · inkl. 1 kanskje', 'the count includes the maybes');
check((await rk.locator('.best-more').count()) === 0, 'no "more" line without first-place ties');
await rk.locator('.results').screenshot({ path: `${SHOTS}/14-ranking-maybe-counts.png` });

// --- K) Holiday calendars: Norway with a clock in Oslo, a choice per event -----------------
const hc = await page({ mobile: false });
await hc.goto(`${BASE}/new`);
const holSel = hc.locator('#ev-form [name=holidays]');
const holDays = () => hc.locator('#f-cal .cal-day.hol').evaluateAll((els) => els.map((e) => e.dataset.d).sort().join());
check((await holSel.inputValue()) === 'no', 'a clock in Oslo gets the Norwegian holidays');
// The whole year ahead, so every calendar has something to mark.
while (await hc.locator('#more-months').isVisible()) await hc.click('[data-act="more-months"]');
const shownDays = await hc.locator('#f-cal .cal-day.pick').evaluateAll((els) => els.map((e) => e.dataset.d));
const expectHol = (cal) => [...holidaysIn(shownDays[0], shownDays[shownDays.length - 1], cal).keys()].sort().join();
check((await holDays()) === expectHol('no'), 'the dots are the Norwegian holidays');
check((await hc.locator('#f-cal .cal-day.hol[title="Julaften"]').count()) >= 1, 'julaften has a dot');
// Two holidays on one day (17 May is Whitsun or Whit Monday in some years) show both names.
const shared = [...holidaysIn(shownDays[0], shownDays[shownDays.length - 1], 'no')].find(([, ks]) => ks.length > 1);
if (shared) check((await day(hc, shared[0]).getAttribute('title')).includes(' og '), `holidays on the same day are both named (${await day(hc, shared[0]).getAttribute('title')})`);
await holSel.selectOption('se');
check((await holDays()) === expectHol('se'), 'Sverige: the dots are the Swedish holidays');
check((await hc.locator('#f-cal .cal-day.hol[title="Midtsommeraften"]').count()) >= 1, 'midsommarafton has a dot in Sweden');
await hc.click('[data-act="sel-group"][data-g="holidays"]');
check((await picked(hc)) === expectHol('se').split(',').length, `the holiday button picks the Swedish holidays (${await picked(hc)})`);
await hc.locator('#ev-form .card:has([name=holidays])').screenshot({ path: `${SHOTS}/15-holiday-setting.png` });
await hc.locator('#f-cal .cal-month:has(.cal-day[title="Midtsommeraften"])').first().screenshot({ path: `${SHOTS}/16-holidays-sweden.png` });
await holSel.selectOption('none');
check((await holDays()) === '', 'Ingen: no dots');
check((await hc.locator('[data-g="holidays"]').count()) === 0, 'Ingen: no holiday button');
check((await picked(hc)) === expectHol('se').split(',').length, 'changing the calendar leaves the picked days alone');
await holSel.selectOption('se');
await hc.fill('form [name=name]', 'Midtsommer');
await hc.click('button[type=submit]');
await hc.waitForSelector('.role');
await hc.click('[data-act="edit-event"]');
check((await holSel.inputValue()) === 'se', 'the event keeps its calendar (Sverige)');
check((await hc.locator('#f-cal .cal-day.hol[title="Midtsommeraften"]').count()) >= 1, 'and the edit form marks the Swedish holidays');
await holSel.selectOption('dk');
await hc.click('button[type=submit]');
await hc.waitForSelector('.role');
await hc.click('[data-act="edit-event"]');
check((await holSel.inputValue()) === 'dk', 'changing it to Danmark is saved');
await hc.close();

// --- U) Undo and redo in the event form's picker ------------------------------------------
{
  const un = await page({ mobile: false });
  await un.goto(`${BASE}/new`);
  await un.waitForSelector('#f-cal .cal-day');
  const undoBtn = un.locator('.count-row [data-act="undo"]');
  const redoBtn = un.locator('.count-row [data-act="redo"]');
  const toastEl = un.locator('#toast');
  check((await undoBtn.isDisabled()) && (await redoBtn.isDisabled()), 'undo and redo start disabled');
  await mouseRange(un, D(0), D(2));
  check((await picked(un)) === 3, 'a drag picks three days');
  await undoBtn.click();
  check((await picked(un)) === 0 && (await redoBtn.isEnabled()), 'one undo takes back the whole drag');
  check((await un.evaluate(() => document.activeElement?.dataset.act)) === 'redo', 'with Undo used up, the focus moves to Redo');
  await redoBtn.click();
  check((await picked(un)) === 3, 'redo brings it back');
  await un.click('[data-act="period"][data-p="2w"]');
  check((await picked(un)) === 14, '"Next 2 weeks" replaces them');
  await un.click('[data-act="sel-none"]');
  check((await toastEl.isVisible()) && (await toastEl.textContent()).includes('Fjernet 14 dager'), '"None" says how many days went, with an Undo');
  await un.locator('.count-row').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(un, '30-undo', false);
  await un.click('#toast [data-act="undo"]');
  check((await picked(un)) === 14 && (await toastEl.isHidden()), "the toast's Undo brings all 14 back and closes it");
  await un.keyboard.press('Control+z');
  check((await picked(un)) === 3, 'Ctrl+Z goes one more step back');
  await un.keyboard.press('Control+Shift+z');
  check((await picked(un)) === 14, 'Ctrl+Shift+Z redoes');
  await un.keyboard.press('Control+y');
  check((await picked(un)) === 0, 'Ctrl+Y redoes too');
  await un.keyboard.press('Control+z');
  await day(un, D(20)).click();
  check((await picked(un)) === 15 && (await redoBtn.isDisabled()), 'a new change clears redo');
  await un.fill('form [name=name]', 'Angreprøve');
  await un.locator('form [name=name]').press('Control+z');
  check((await picked(un)) === 15, 'Ctrl+Z in the name field leaves the days alone');
  await un.check('[name=mode][value=times]');
  check(await undoBtn.isDisabled(), 'switching to times starts the history afresh');
  const cells = () => un.locator('#f-grid .tg-cell.v1').count();
  const full = await cells();
  await un.click('[data-act="preset"][data-p="clear"]');
  check((await cells()) === 0 && (await toastEl.textContent()).includes('Tidene er fjernet'), 'clearing the times says so');
  await un.locator('#times-card .undo-btns [data-act="undo"]').click();
  check(full > 0 && (await cells()) === full, `undo next to the presets brings the times back (${full})`);
  const k0 = await un.locator('#f-grid .tg-cell.v1').first().getAttribute('data-k'); // 09:00 on the first day shown
  await dragCells(un, k0, `${k0.slice(0, 10)}T10:30`);
  check((await cells()) === full - 4, 'a grid stroke is a step');
  await un.keyboard.press('Control+z');
  check((await cells()) === full, 'and Ctrl+Z takes the whole stroke back');
  await un.close();
}

// --- V) The admin's own answer, and answers for others ----------------------------------------
{
  const ad = await page({ refused: true });
  await ad.context().setExtraHTTPHeaders({ 'x-dev-ip': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  await ad.goto(`${BASE}/`);
  const days = [D(0), D(1), D(2)];
  const made = await ad.evaluate(async (days) => {
    const r = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: { name: 'Teammøte', mode: 'dates', start: days[0], end: days[2], options: days }, email: '' }) });
    return r.json();
  }, days);
  await ad.goto(`${BASE}/e/${made.id}/${made.token}`);
  await ad.waitForSelector('.role');
  check((await ad.locator('.role [data-act="answer"]').textContent()).includes('Legg til dine svar'), 'the admin has "Add your answers"');
  check((await ad.locator('.role [data-act="mark-own"]').count()) === 0, 'and no "pick your answer" before anyone answered');
  // For someone else: no email, a link afterwards.
  await ad.click('.role [data-act="answer-other"]');
  check((await ad.locator('h1').textContent()) === 'Legg til svar for en annen' && (await ad.locator('#answer-form [name=email]').count()) === 0, '"for someone else" has no email field');
  check((await ad.locator('#answer-form [data-field="name"] .label').textContent()) === 'Navn *', 'and asks for "Navn", not "Navnet ditt"');
  await ad.fill('#answer-form [name=name]', 'Kari');
  await day(ad, D(0)).click();
  await ad.click('[data-act="save-answer"]');
  await ad.waitForSelector('#dlg[open]');
  check((await ad.locator('#dlg h3').textContent()).includes('Lenken til Kari'), 'saving shows the link for that person');
  await ad.click('#dlg button[value=""]');
  check((await ad.locator('.plist li', { hasText: 'Kari' }).locator('.tag').count()) === 0, 'and Kari is not marked as you');
  check((await ad.locator('.role [data-act="mark-own"]').count()) === 1, 'now "pick your answer" is offered');
  // Their own: email field (prefilled from the event's admin email, empty here), no link dialog.
  await ad.click('.role [data-act="answer"]');
  check((await ad.locator('h1').textContent()) === 'Legg til dine svar', 'the own form says "your answers"');
  const ownMail = `admin-${Date.now()}@example.com`;
  await ad.fill('#answer-form [name=name]', 'Ola Admin');
  await ad.click('#answer-form .fold summary');
  await ad.fill('#answer-form [name=email]', ownMail);
  await day(ad, D(1)).click();
  await ad.click('[data-act="save-answer"]');
  await ad.waitForSelector('.role');
  check(!(await ad.locator('#dlg[open]').count()), 'saving your own answers shows no link');
  check((await ad.locator('.plist li', { hasText: 'Ola Admin' }).locator('.tag').textContent()) === 'deg', 'your row is marked "deg"');
  check((await ad.locator('.role [data-act="answer"]').textContent()).includes('Endre svarene dine'), 'the button becomes "Change your answers"');
  await ad.locator('.people').screenshot({ path: `${SHOTS}/31-admin-own-people.png` });
  const views = await ad.evaluate(async ([id, admin]) => {
    const get = (tok) => fetch(`/api/events/${id}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} }).then((r) => r.json());
    const a = await get(admin);
    const kari = a.view.people.find((p) => p.name === 'Kari');
    const { token } = await fetch(`/api/events/${id}/people/${kari.id}/link`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` }, body: '{}' }).then((r) => r.json());
    return { a: a.view, visitor: (await get(null)).view, kari: (await get(token)).view };
  }, [made.id, made.token]);
  const olaIn = (v) => v.people.find((p) => p.name === 'Ola Admin');
  check(olaIn(views.a).email === ownMail && views.a.me === olaIn(views.a).id, 'the admin view has their own email and them as "me"');
  check(views.a.adminEmail === ownMail, 'with no admin email, theirs becomes it');
  check(!('email' in olaIn(views.visitor)) && !('email' in olaIn(views.kari)), 'nobody else sees that email');
  // An email code for that address brings back both links.
  const asked = await ad.evaluate(async (email) => (await fetch('/api/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, lang: 'nb' }) })).json(), ownMail);
  const found = await ad.evaluate(async ([email, code]) => (await fetch('/api/lookup/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) })).json(), [ownMail, asked.echo]);
  const hit = (found.events ?? []).find((e) => e.id === made.id);
  check(Boolean(hit?.admin && hit?.me && hit.pid === olaIn(views.a).id), 'an email code for it gives both the admin link and the personal one');
  // Unmark, then mark again from the role card.
  await ad.click('[data-act="admin-more"]');
  await ad.click('#dlg .menu-item[value="own"]');
  await ad.click('#dlg .menu-item[value="none"]');
  await ad.waitForSelector('.role [data-act="mark-own"]');
  check((await ad.locator('.plist .tag').count()) === 0 && (await ad.locator('.role [data-act="answer"]').textContent()).includes('Legg til dine svar'), '"None of them" unmarks it');
  await ad.locator('.role').screenshot({ path: `${SHOTS}/32-admin-mark-own.png` });
  await ad.click('.role [data-act="mark-own"]');
  await ad.locator('#dlg .menu-item', { hasText: 'Ola Admin' }).click();
  await ad.waitForSelector('.role [data-act="mark-own"]', { state: 'detached' });
  check((await ad.locator('.plist li', { hasText: 'Ola Admin' }).locator('.tag').count()) === 1, 'picking it marks it again');
  // Deleting their own answers keeps the admin link.
  const adminPath = new URL(ad.url()).pathname;
  await ad.locator('.plist li', { hasText: 'Ola Admin' }).locator('[data-act="delete-entry"]').click();
  await ad.click('#dlg button[value="yes"]');
  await ad.waitForSelector('.role [data-act="answer"]:has-text("Legg til dine svar")');
  check(new URL(ad.url()).pathname === adminPath, 'deleting your own answers keeps you on the admin link');
  await ad.close();
}

// --- R) Ties beyond the first three, and the footer -----------------------------------------
const tie = await page();
await tie.goto(`${BASE}/`);
const tieLink = await tie.evaluate(async (days) => {
  const j = (method, url, body, token) => fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
  const ev = await j('POST', '/api/events', { event: { name: 'Seks like dager', mode: 'dates', start: days[0], end: days[5], options: days }, email: '' });
  await j('POST', `/api/events/${ev.id}/people`, { name: 'Ola', answers: Object.fromEntries(days.map((d) => [d, 1])) });
  return `/e/${ev.id}/${ev.token}`;
}, [D(0), D(1), D(2), D(3), D(4), D(7)]);
await tie.goto(BASE + tieLink);
await tie.waitForSelector('.best-item');
check((await tie.locator('.best-item').count()) === 3, 'three of six equally good days show at first');
const moreBtn = tie.locator('[data-act="best-more"]');
check((await moreBtn.textContent()).includes('Vis 3 til') && (await moreBtn.getAttribute('aria-expanded')) === 'false', 'with a button for the other three');
check((await tie.locator('.best-item').first().textContent()).replace(/\s+/g, ' ').includes('1. '), 'the rank reads as "1." (hidden separator)');
await moreBtn.click();
check((await tie.locator('.best-item').count()) === 6 && (await tie.locator('[data-act="best-more"]').getAttribute('aria-expanded')) === 'true', 'the button shows all six');
await tie.locator('.results').screenshot({ path: `${SHOTS}/28-best-all.png` });
check((await tie.evaluate(() => document.activeElement?.dataset.act)) === 'best-more', 'and keeps the focus');
await tie.click('[data-act="best-more"]');
check((await tie.locator('.best-item').count()) === 3, '"Show fewer" folds them again');
const foot = await tie.locator('.foot a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
check(foot.join() === '/privacy,https://github.com/gunnaringe/whenever,https://apphub.casa', `the footer links to privacy, the source and apphub.casa (${foot.join()})`);
await tie.locator('.foot').screenshot({ path: `${SHOTS}/29-footer.png` });
await tie.close();

// --- S) Switching between your events from the header ---------------------------------------
const sw = await page();
await sw.goto(`${BASE}/`);
check((await sw.locator('.events-btn').count()) === 0, 'no events button before you have any events');
const makeEvent = (p, name) =>
  p.evaluate(
    async ([name, d]) => {
      // The rate limit (per minute) can be reached by now: wait it out.
      for (let i = 0; i < 30; i++) {
        const res = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: { name, mode: 'dates', start: d, end: d, options: [d] }, email: '' }) });
        if (res.status !== 429) {
          const r = await res.json();
          return `/e/${r.id}/${r.token}`;
        }
        await new Promise((ok) => setTimeout(ok, 3000));
      }
      return 'rate-limited';
    },
    [name, D(0)],
  );
const evA = await makeEvent(sw, 'Sommerfest');
const evB = await makeEvent(sw, 'Styremøte');
check(evA.startsWith('/e/') && evB.startsWith('/e/'), `made two events (${evA.slice(0, 15)}, ${evB.slice(0, 15)})`);
// (The button is already there while an event loads: wait for the event itself.)
await sw.goto(BASE + evA);
await sw.waitForSelector('h1:has-text("Sommerfest")');
await sw.goto(BASE + evB);
await sw.waitForSelector('h1:has-text("Styremøte")');
await sw.click('.events-btn');
const evMenu = sw.locator('#events-menu');
check(await evMenu.isVisible(), 'the events button opens a menu of your events');
check((await evMenu.locator('.menu-item').allTextContents()).map((x) => x.split('Admin')[0]).join() === 'Styremøte,Sommerfest', `the latest first (${(await evMenu.locator('.menu-item').allTextContents()).join(' | ')})`);
check((await evMenu.locator('.menu-item.on').textContent()).startsWith('Styremøte'), 'the event you are on is ticked');
check((await sw.evaluate(() => document.activeElement?.textContent ?? '')).startsWith('Styremøte'), 'and has the focus');
await sw.screenshot({ path: `${SHOTS}/22-events-menu.png`, clip: { x: 0, y: 0, width: 390, height: 300 } });
await sw.keyboard.press('Escape');
check(!(await evMenu.isVisible()), 'Esc closes it');
await sw.click('.events-btn');
await evMenu.locator('.menu-item', { hasText: 'Sommerfest' }).click();
await sw.waitForURL(BASE + evA);
check((await sw.locator('h1').first().textContent()).includes('Sommerfest'), 'picking another event opens it with your admin link');
// Leaving a half-edited form asks first.
await sw.click('[data-act="edit-event"]');
await sw.fill('form [name=name]', 'Sommerfest 2027');
await sw.click('.events-btn');
await sw.locator('#events-menu .menu-item', { hasText: 'Styremøte' }).click();
check(await sw.locator('#dlg[open]').isVisible(), 'with unsaved changes, it asks before leaving');
await sw.click('#dlg button[value="no"]');
check((await sw.inputValue('form [name=name]')) === 'Sommerfest 2027' && !(await evMenu.isVisible()), 'staying keeps the form, and the menu is closed');
await sw.close();
// Nine remembered events on a narrow phone in English: eight, then "Show all".
const many = await page({ lang: 'en-US' });
await many.setViewportSize({ width: 320, height: 640 });
await many.context().addInitScript(() => {
  const events = {};
  for (let i = 1; i <= 9; i++) events[`abcdefghijk${i}`] = { name: `Event ${i}`, admin: 'a'.repeat(38), seen: i };
  localStorage.setItem('whenever-v1', JSON.stringify({ events }));
});
await many.goto(`${BASE}/`);
await many.click('.events-btn');
const manyItems = await many.locator('#events-menu .menu-item').allTextContents();
check(manyItems.length === 9 && manyItems[0].startsWith('Event 9') && manyItems[8] === 'Show all (9)', `the latest eight, then "Show all" (${manyItems.join(' | ')})`);
check((await many.locator('#events-menu .menu-item').last().getAttribute('href')) === '/', 'which goes to the home page');
const headerFits = await many.evaluate(() => {
  const r = document.querySelector('.lang-btn').getBoundingClientRect();
  const b = document.querySelector('.brand').getBoundingClientRect();
  return document.documentElement.scrollWidth <= innerWidth && r.right <= innerWidth && Math.abs(r.top - b.top) < 20;
});
check(headerFits, 'three header buttons fit on one line at 320 px in English');
await many.screenshot({ path: `${SHOTS}/23-events-menu-many.png` });
await many.close();

// --- M) Find your events by email ------------------------------------------------------------
// Needs `wrangler dev --var MAIL_ECHO:1` (npm run dev): the code comes back in
// the reply instead of by mail. Each page gets its own x-dev-ip, and the
// address is new each run, so the limits don't carry over between runs.
const devIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const mailAddr = `smoke-${Date.now()}@example.com`;
const fm = await page({ refused: true });
await fm.context().setExtraHTTPHeaders({ 'x-dev-ip': devIp() });
await fm.goto(`${BASE}/`);
// The event was made on "another device": only its address is known here.
await fm.evaluate(
  async ([name, d, email]) => {
    await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: { name, mode: 'dates', start: d, end: d, options: [d] }, email }) });
  },
  ['Juletrefest', D(0), mailAddr],
);
check((await fm.locator('.events-btn').count()) === 0, 'a new device has no events');
await fm.click('.find-link a');
await fm.waitForSelector('#find-form [name=email]');
await fm.fill('#find-form [name=email]', mailAddr);
await shot(fm, '25-find-email', false);
// Typed differently from when it was entered: still the same address.
await fm.fill('#find-form [name=email]', ` ${mailAddr.toUpperCase()} `);
const askedResp = fm.waitForResponse((r) => r.url().endsWith('/api/lookup'));
await fm.click('#find-form [type=submit]');
const asked = await (await askedResp).json();
check(/^\d{6}$/.test(asked.echo ?? ''), 'asking for a code makes one for an address on an event');
await fm.waitForSelector('#find-form [name=code]');
check((await fm.locator('#find-form .sent').textContent()).includes('10 minutter'), 'the page says a code is on its way');
await shot(fm, '24-find-code', false);
const toastText = async () => {
  await fm.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
  const x = await fm.locator('#toast').textContent();
  await fm.evaluate(() => (document.querySelector('#toast').hidden = true));
  return x;
};
await fm.fill('#find-form [name=code]', asked.echo === '000000' ? '111111' : '000000');
await fm.click('#find-form [type=submit]');
check((await toastText()).includes('feil eller utløpt'), 'a wrong code is refused');
await fm.click('[data-act="find-again"]');
check((await toastText()).includes('Vent et minutt'), 'a new code for the same address has to wait a minute');
await fm.fill('#find-form [name=code]', `${asked.echo.slice(0, 3)} ${asked.echo.slice(3)}`);
await fm.click('#find-form [type=submit]');
await fm.waitForURL(`${BASE}/`);
check((await toastText()).includes('Fant 1 avtale'), 'the right code finds the event');
check((await fm.locator('.mine').textContent()).includes('Juletrefest'), 'and adds it to this device');
check(await fm.evaluate(() => Object.values(JSON.parse(localStorage.getItem('whenever-v1')).events).some((e) => e.name === 'Juletrefest' && e.admin)), 'with its admin link');
const postJson = (p, url, body) => p.evaluate(async ([url, body]) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(), [url, body]);
check((await postJson(fm, '/api/lookup/link', { token: asked.echoLink })).error === 'link', "the code used, the same mail's link is dead");
await fm.close();

// The mail's one-tap link (/find#t=…): out of the address bar at once, used
// only on a tap, and once.
{
  const ln = await page({ refused: true });
  await ln.context().setExtraHTTPHeaders({ 'x-dev-ip': devIp() });
  await ln.goto(`${BASE}/`);
  const linkAddr = `link-${Date.now()}@example.com`;
  await postJson(ln, '/api/events', { event: { name: 'Påskelunsj', mode: 'dates', start: D(1), end: D(1), options: [D(1)] }, email: linkAddr });
  const got = await postJson(ln, '/api/lookup', { email: linkAddr, lang: 'nb' });
  check(/^[A-Za-z0-9_-]{32}$/.test(got.echoLink ?? ''), 'a code comes with a one-tap link');
  await ln.goto(`${BASE}/find#t=${got.echoLink}`);
  await ln.waitForSelector('[data-act="find-link"]');
  check((await ln.evaluate(() => location.href)) === `${BASE}/find`, 'the token leaves the address bar at once');
  check(!(await ln.evaluate(() => localStorage.getItem('whenever-v1') ?? '')).includes('Påskelunsj'), 'and nothing happens before the tap');
  await shot(ln, '33-find-link', false);
  await ln.click('[data-act="find-link"]');
  await ln.waitForURL(`${BASE}/`);
  check((await ln.locator('.mine').textContent()).includes('Påskelunsj'), 'a tap adds the event');
  check((await postJson(ln, '/api/lookup/link', { token: got.echoLink })).error === 'link', 'the link works once');
  check((await postJson(ln, '/api/lookup/code', { email: linkAddr, code: got.echo })).error === 'code', "and the same mail's code is used up with it");
  await ln.goto(`${BASE}/find#t=${got.echoLink}`);
  await ln.click('[data-act="find-link"]');
  await ln.waitForSelector('#find-form [name=email]');
  check((await ln.locator('#toast').textContent()).includes('allerede brukt'), 'a used link says so and offers a code instead');
  await ln.close();
}

// The mail itself (HTML part) on a phone: fits, big code, one button.
{
  const { codeMail } = await import('../src/worker/mail.ts');
  const m = codeMail('nb', '042137', 'https://finn-tid.apphub.casa/find#t=AbCdEfGhIjKlMnOpQrStUvWxYz012-_9', 'whenever@apphub.casa', 'kari@example.com');
  const mp = await page();
  await mp.setContent(m.html);
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the mail fits a phone screen');
  check((await mp.locator('a').count()) === 1 && (await mp.locator('a').textContent()) === 'Vis avtalene mine', 'with one button');
  await mp.screenshot({ path: `${SHOTS}/34-code-mail.png`, fullPage: true });
  await mp.close();
}

// An address on no event: the same reply and page, but no code.
const fu = await page({ refused: true });
await fu.context().setExtraHTTPHeaders({ 'x-dev-ip': devIp() });
await fu.goto(`${BASE}/find`);
await fu.fill('#find-form [name=email]', `nobody-${Date.now()}@example.com`);
const unkResp = fu.waitForResponse((r) => r.url().endsWith('/api/lookup'));
await fu.click('#find-form [type=submit]');
const unk = await unkResp;
check(unk.status() === 200 && JSON.stringify(await unk.json()) === '{"ok":true}', 'an unknown address gets the same reply, without a code');
await fu.waitForSelector('#find-form [name=code]');
await fu.fill('#find-form [name=code]', '123456');
await fu.click('#find-form [type=submit]');
await fu.waitForSelector('#toast:not([hidden])');
check((await fu.locator('#toast').textContent()).includes('feil eller utløpt'), 'and any code there is just "wrong or expired"');
await fu.close();

// --- L) Languages: a menu under the language code ----------------------------------------
const lg = await page();
await lg.goto(`${BASE}/`);
const langBtn = lg.locator('.lang-btn');
const langMenu = lg.locator('#lang-menu');
const langNow = () => lg.evaluate(() => document.documentElement.lang);
check((await langBtn.textContent()).trim().startsWith('NB') && (await langNow()) === 'nb', 'a Norwegian browser gets bokmål, and the button says NB');
await langBtn.click();
check(await langMenu.isVisible(), 'the button opens the language menu');
check((await langMenu.locator('[data-lang]').count()) === 6, 'six languages');
const focusedLang = () => lg.evaluate(() => document.activeElement?.dataset.lang ?? document.activeElement?.outerHTML.slice(0, 60));
check((await focusedLang()) === 'nb', `the current language has the focus (${await focusedLang()})`);
await lg.screenshot({ path: `${SHOTS}/17-language-menu.png`, clip: { x: 0, y: 0, width: 390, height: 400 } });
await lg.keyboard.press('ArrowDown');
check((await focusedLang()) === 'nn', `the arrow keys move through the menu (${await focusedLang()})`);
await lg.keyboard.press('Escape');
check(!(await langMenu.isVisible()), 'Esc closes the menu');
await langBtn.click();
await lg.mouse.click(20, 600);
check(!(await langMenu.isVisible()), 'a click outside closes it');
await langBtn.click();
await langMenu.locator('[data-lang="nn"]').click();
check((await langNow()) === 'nn' && (await langBtn.textContent()).trim().startsWith('NN'), 'picking nynorsk switches the page (NN)');
await lg.click('a[href="/new"]');
await lg.waitForSelector('#f-cal');
check((await day(lg, D(0)).getAttribute('aria-label')).startsWith('måndag'), `nynorsk dates without Intl data in Chromium (${await day(lg, D(0)).getAttribute('aria-label')})`);
await lg.locator('.lang-btn').click();
await lg.locator('#lang-menu [data-lang="is"]').click();
check((await day(lg, D(0)).getAttribute('aria-label')).startsWith('mánudagur'), `Icelandic dates too (${await day(lg, D(0)).getAttribute('aria-label')})`);
const isMonths = ['Janúar', 'Febrúar', 'Mars', 'Apríl', 'Maí', 'Júní', 'Júlí', 'Ágúst', 'September', 'Október', 'Nóvember', 'Desember'];
await lg.reload();
await lg.waitForSelector('#f-cal');
check((await langNow()) === 'is' && (await lg.locator('.lang-btn').textContent()).trim().startsWith('IS'), 'the choice is remembered after a reload');
const firstMonth = (await lg.locator('#f-cal .cal-month h4').first().textContent()).split(' ')[0];
check(isMonths.includes(firstMonth), `the calendar's month titles are Icelandic (${firstMonth})`);
await shot(lg, '18-icelandic-new-event', false);
await lg.close();
// A browser without popovers (before 2024) gets the dialog menu.
const old = await page();
await old.context().addInitScript(() => delete HTMLElement.prototype.popover);
await old.goto(`${BASE}/`);
await old.waitForSelector('.lang-btn');
check((await old.locator('.dropdown').count()) === 0, 'without popovers there is no dropdown in the page');
await old.locator('.theme-btn').click();
check((await old.locator('#dlg[open] .menu-item').count()) === 4, 'the theme button opens the dialog menu instead');
await old.locator('#dlg button[value="dark"]').click();
await old.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 3000 }).catch(() => {});
check((await old.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'and picking a theme there works');
await old.locator('.lang-btn').click();
check((await old.locator('#dlg[open] .menu-item').count()) === 6, 'the button opens the dialog menu instead');
await old.locator('#dlg button[value="sv"]').click();
// The dialog's close event comes a moment after the click.
await old.waitForFunction(() => document.documentElement.lang === 'sv', null, { timeout: 3000 }).catch(() => {});
check((await old.evaluate(() => document.documentElement.lang)) === 'sv', 'and picking a language there works');
const evC = await makeEvent(old, 'Juleball');
await old.goto(BASE + evC);
await old.waitForSelector('h1:has-text("Juleball")');
await old.locator('.events-btn').click();
check((await old.locator('#dlg[open] .menu-item').allTextContents()).join().startsWith('Juleball'), 'the events button opens the dialog menu instead');
await old.close();

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

// --- T) Themes: auto follows the device, a choice overrides it -------------------------------
const th = await page();
const themeNow = () => th.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()].join(' '));
const chosen = (x) => th.waitForFunction((x) => JSON.parse(localStorage.getItem('whenever-v1') ?? '{}').theme === x, x);
const pickTheme = async (x) => {
  await th.click('.theme-btn');
  await th.click(`#theme-menu [data-theme="${x}"]`);
  await chosen(x);
};
await th.emulateMedia({ colorScheme: 'dark' });
await th.goto(`${BASE}/new`);
check((await themeNow()) === 'dark #0e1417', `auto follows a dark device (${await themeNow()})`);
await th.fill('form [name=name]', 'Halvferdig');
await pickTheme('light');
check((await themeNow()) === 'light #f3f6f5', `light on a dark device (${await themeNow()})`);
check((await th.inputValue('form [name=name]')) === 'Halvferdig', 'changing the theme keeps a half-filled form');
await th.click('.theme-btn');
check(await th.locator('#theme-menu').isVisible(), 'the theme button opens a menu under it, like the language one');
check((await th.locator('#theme-menu .menu-item.on').getAttribute('data-theme')) === 'light', 'the menu marks the current theme');
check((await th.evaluate(() => document.activeElement?.dataset.theme)) === 'light', 'and has the focus on it');
await th.screenshot({ path: `${SHOTS}/20-theme-menu.png`, clip: { x: 0, y: 0, width: 390, height: 400 } });
await th.keyboard.press('Escape');
check(!(await th.locator('#theme-menu').isVisible()), 'Esc closes the theme menu');
await th.click('.theme-btn');
await th.click('#theme-menu [data-theme="hacker"]');
await chosen('hacker');
check((await themeNow()) === 'hacker #000', `hacker (${await themeNow()})`);
await th.goto(`${BASE}/privacy`);
check((await themeNow()) === 'hacker #000', 'the choice survives a reload and applies on the privacy page');
await th.goto(`${BASE}/`);
await th.emulateMedia({ colorScheme: 'light' });
await pickTheme('dark');
check((await themeNow()) === 'dark #0e1417', `dark on a light device (${await themeNow()})`);
await pickTheme('auto');
check((await themeNow()) === 'light #f3f6f5', 'auto on a light device');
await th.emulateMedia({ colorScheme: 'dark' });
await th.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
check(true, 'auto follows the device switching to dark');

check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
