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

// --- G) The organiser picks the date ---------------------------------------------------------
await admin.reload();
await admin.waitForSelector('.best-item');
await admin.locator('.best-item').first().click();
await admin.click('.detail [data-act="decide"]');
await admin.click('#dlg button[value="yes"]');
await admin.waitForSelector('.decided');
check(await admin.locator('.best-item .tag').first().isVisible(), 'the best list marks the pick');
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
