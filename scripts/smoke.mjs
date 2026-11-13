// End-to-end check against `npm run dev` (wrangler dev).
// Screenshots go to $SHOTS (default /tmp/whenever-shots).
//   BASE=http://127.0.0.1:8787 npm run smoke
// Uses playwright-core, which brings no browser: set PWCHROME to a Chromium
// or chrome-headless-shell binary (e.g. under ~/.cache/ms-playwright/).
// With PWFIREFOX (a Playwright Firefox build, e.g. ~/.cache/ms-playwright/
// firefox-*/firefox/firefox) a few layout checks also run in Firefox.
import { mkdirSync } from 'node:fs';
import { chromium, firefox } from 'playwright-core';
import { holidaysIn } from '../src/shared/model.ts';
import { moveClock } from '../src/app/zone.ts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
// An admin or personal link is /e/<id>#<token>: the token's pattern, a whole
// link, and the token in a page's address (before any &sub-view).
const TOK = '[0-9a-f]{16}[A-Za-z0-9_-]{22}';
const LINK_RE = new RegExp(`/e/[A-Za-z0-9]{12}#${TOK}$`);
const tokenOf = (url) => new URL(url).hash.slice(1).split('&')[0];
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
    // Its own bucket of the API's rate limit (sections set their own where
    // it matters), so the run never fills a shared one.
    extraHTTPHeaders: { 'x-dev-ip': `10.200.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
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
// Parts of the results legend that overlap each other ("a / b"), as Firefox
// once drew the colour bar's label over the next one.
const legendOverlaps = (p) =>
  p.evaluate(() => {
    const parts = [...document.querySelectorAll('.legend .lg > *')];
    const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const out = [];
    for (const [i, a] of parts.entries()) {
      for (const b of parts.slice(i + 1)) {
        if (hit(a.getBoundingClientRect(), b.getBoundingClientRect())) out.push(`${a.textContent || a.className} / ${b.textContent || b.className}`);
      }
    }
    return out;
  });

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
await admin.waitForURL(LINK_RE);
const adminUrl = admin.url();
const eventUrl = adminUrl.replace(/#.*$/, '');
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
await kari.waitForURL(LINK_RE);
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
await ola.waitForURL(LINK_RE);

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
// Opened afresh: Kari's tab is on that link already, and going to the same
// address only changes the hash, which loads nothing.
await kari.goto(`${BASE}/`);
await kari.goto(kariUrl);
await kari.waitForSelector('.notice.warn');
check(await kari.locator('.notice.warn').isVisible(), 'old personal link says it no longer works');

// --- E) Times event on a desktop ---------------------------------------------------------
const boss = await page({ mobile: false });
await boss.goto(`${BASE}/new`);
await boss.fill('form [name=name]', 'Planleggingsmøte');
await boss.check('[name=mode][value=times]');
// Times are marked straight in a week calendar: no days to pick first.
const marked = (p) => p.locator('#f-grid .tg-cell.v1').count();
const on = (p, d) => p.locator(`#f-grid .tg-cell.v1[data-k^="${d}"]`).count();
const countLine = (p) => p.locator('#f-count-t').textContent();
check((await boss.locator('#days-card').isHidden()) && (await boss.locator('#f-grid .tg-cell').count()) > 0, 'times mode shows a week calendar at once, and no month calendar');
check((await marked(boss)) === 0 && (await countLine(boss)).startsWith('0 dager'), 'with nothing marked');
check((await boss.locator('#f-grid .tg-day').count()) === 14, 'a wide screen shows two whole weeks');
check((await boss.locator('#f-grid .tg-day.off').count()) === dow(today) && (await boss.locator(`#f-grid .tg-cell.na[data-k^="${iso(today)}"]`).count()) === 0, 'the days gone by are hatched and have no menu, today is open');
check(await boss.locator('#f-grid [data-step="-1"]').isDisabled(), 'there is nothing earlier than this week');
await boss.click('#f-grid [data-step="1"]');
check((await boss.locator('.tg-nav-label').textContent()).includes('Uke') && (await boss.locator(`#f-grid .tg-cell[data-k="${iso(today + (14 - dow(today)) * DAY)}T09:00"]`).count()) === 1, 'the arrow shows the two weeks after');
// The page of the form's calendar with a day: from the first one, forwards.
const showWeek = async (p, d) => {
  while (!(await p.locator('#f-grid [data-step="-1"]').isDisabled())) await p.click('#f-grid [data-step="-1"]');
  while (!(await p.locator(`#f-grid .tg-cell[data-k="${d}T09:00"]`).count())) await p.click('#f-grid [data-step="1"]');
};
await showWeek(boss, D(0));
await dragCells(boss, D(0, '09:00'), D(4, '16:30')); // Monday to Friday, 9-17
check((await marked(boss)) === 5 * 16, 'dragging across the calendar marks five days, 9-17');
check((await countLine(boss)).startsWith('5 dager · 80 tidsruter'), 'and the count line follows');
// The presets fill the weeks shown from today on: working hours on weekdays.
await boss.click('[data-act="preset"][data-p="evening"]');
check((await on(boss, D(0))) === 10 && (await on(boss, D(5))) === 10, '"Evenings" fills every day shown, 17-22');
await boss.click('[data-act="preset"][data-p="work"]');
check((await on(boss, D(0))) === 16 && (await on(boss, D(5))) === 10, '"Working hours" fills the weekdays and leaves the weekend');
await boss.click('[data-act="preset"][data-p="clear"]');
check((await marked(boss)) === 0, '"No times" clears what is shown');
for (let i = 0; i < 3; i++) await boss.locator('#times-card .undo-btns [data-act="undo"]').click();
check((await marked(boss)) === 5 * 16, 'three undos take the presets back');
// A day's menu.
const dayMenu = async (d, id) => {
  await boss.click(`#f-grid [data-day="${d}"]`);
  await boss.click(`#dlg button[value="${id}"]`);
  await boss.waitForFunction(() => !document.querySelector('#dlg').open);
  await boss.waitForTimeout(50);
};
await dayMenu(D(5), 'all');
check((await on(boss, D(5))) === 28, 'a day\'s menu: the whole day (the hours shown, 8-22)');
await dayMenu(D(5), 'clear');
check((await on(boss, D(5))) === 0, 'and clearing it');
await dragCells(boss, D(2, '09:00'), D(2, '16:30')); // Wednesday off
await dragCells(boss, D(2, '10:00'), D(2, '11:30')); // but for 10-12
await dayMenu(D(2), 'week');
check((await on(boss, D(0))) === 4 && (await on(boss, D(4))) === 4 && (await on(boss, D(5))) === 0, '"these times Monday to Friday" copies a day to its week\'s weekdays');
await boss.locator('#times-card .undo-btns [data-act="undo"]').click();
await boss.locator('#times-card .undo-btns [data-act="undo"]').click();
await boss.locator('#times-card .undo-btns [data-act="undo"]').click();
check((await marked(boss)) === 5 * 16, 'and undo brings the week back');
// One more week with the same times: the last week, once more in the week after.
check(!(await boss.locator('#repeat-week').isDisabled()), 'with times marked, the week can be repeated');
await boss.click('#repeat-week');
check((await countLine(boss)).startsWith('10 dager · 160 tidsruter') && (await on(boss, D(7))) === 16 && (await on(boss, D(11))) === 16 && (await on(boss, D(12))) === 0, '"one more week" copies the last week to the week after, and shows it');
await boss.locator('#times-card .undo-btns [data-act="undo"]').click();
check((await countLine(boss)).startsWith('5 dager'), 'undone again');
// From another page, a chip leads back to the one with times.
await showWeek(boss, iso(today));
check((await boss.locator('#f-grid .tg-weeks .chip').count()) === 1, 'a page with times gets a chip while another page is shown');
await boss.click('#f-grid .tg-weeks .chip');
check((await marked(boss)) === 5 * 16, 'and the chip shows that page');
await dragCells(boss, D(0, '08:00'), D(1, '08:30')); // add 08:00-09:00 on Mon+Tue
check((await boss.locator('#f-grid .tg-cell.v1').count()) === 5 * 16 + 4, 'drag paints a rectangle');
await dragCells(boss, D(4, '15:00'), D(4, '16:30')); // Friday afternoon off
const afterErase = await boss.locator('#f-grid .tg-cell.v1').count();
check(afterErase === 5 * 16 + 4 - 4, `drag from a marked cell erases (${afterErase})`);
await shot(boss, '09-new-times');
{
  const ph = await page();
  await ph.goto(`${BASE}/new`);
  await ph.check('[name=mode][value=times]');
  check((await ph.locator('#f-grid .tg-day').count()) === 7, 'a phone shows one whole week');
  await ph.click('#f-grid [data-step="1"]');
  await ph.click('[data-act="preset"][data-p="work"]');
  check((await marked(ph)) === 5 * 16, 'and "Working hours" fills its five weekdays');
  check(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'without making the page wider than the screen');
  await ph.locator('#times-card').screenshot({ path: `${SHOTS}/09b-new-times-phone.png` });
  await ph.context().close();
}
// The hours shown are only the grid's: buttons, not a setting. The meeting
// length: a few choices or any length, fitted to the slots.
{
  const hp = await page({ mobile: false });
  await hp.goto(`${BASE}/new`);
  await hp.fill('form [name=name]', 'Timer og lengde');
  await hp.check('[name=mode][value=times]');
  const rowsShown = async () => {
    const t = (await hp.locator('#f-grid .tg-time').allTextContents()).filter(Boolean);
    return `${t[0]}-${t[t.length - 1]}`;
  };
  check((await hp.locator('[name=dayStart], [name=dayEnd]').count()) === 0 && (await rowsShown()) === '08:00-21:00', `no menus for the hours shown, and the grid shows 08-22 (${await rowsShown()})`);
  check((await hp.locator('#hours-reset').isHidden()) && (await hp.locator('#hours-earlier').isVisible()) && (await hp.locator('#hours-later').isVisible()), 'with "show earlier" above it and "show later" below, and no reset yet');
  await hp.click('#hours-earlier');
  check((await rowsShown()) === '06:00-21:00' && (await hp.locator('#hours-reset').isVisible()), `"show earlier" adds two hours (${await rowsShown()}), and the reset shows`);
  for (let i = 0; i < 3; i++) await hp.click('#hours-earlier');
  check((await rowsShown()).startsWith('00:00') && (await hp.locator('#hours-earlier').isHidden()), 'at midnight the button goes');
  check((await hp.evaluate(() => document.activeElement?.id)) === 'hours-later', 'and the focus moves on to "show later"');
  await hp.click('#hours-later');
  check((await rowsShown()) === '00:00-23:00' && (await hp.locator('#hours-later').isHidden()), `"show later" reaches midnight too (${await rowsShown()})`);
  await showWeek(hp, D(0));
  await dragCells(hp, D(0, '06:00'), D(0, '06:30'));
  await hp.click('#hours-reset');
  check((await rowsShown()) === '06:00-21:00' && (await on(hp, D(0))) === 2 && (await hp.locator('#hours-reset').isHidden()), `the reset goes back to 08-22, or as far as the times marked need (${await rowsShown()})`);
  // Meeting length.
  const durNote = () => hp.locator('#dur-note').textContent();
  check((await hp.locator('[name=durPick][value="60"]').isChecked()) && (await hp.locator('.dur-custom').isHidden()), 'the meeting lasts 1 hour unless changed');
  check((await hp.locator('[name=slot]').isHidden()) && (await hp.locator('.fold > summary', { hasText: '30 min' }).count()) === 1, 'the slots are folded away, with their length in the fold\'s title');
  await hp.locator('label.chip.pick', { hasText: '2 t' }).click();
  check(await hp.locator('[name=durPick][value="120"]').isChecked(), 'a choice is a tap');
  await hp.locator('[name=durPick][value=other]').check();
  check((await hp.locator('.dur-custom').isVisible()) && (await hp.inputValue('[name=durH]')) === '2' && (await hp.inputValue('[name=durM]')) === '0', '"Other length" shows hours and minutes, filled with the length chosen');
  check((await hp.evaluate(() => document.activeElement?.getAttribute('name'))) === 'durH', 'and puts the focus in the hours');
  await hp.fill('[name=durH]', '1');
  await hp.keyboard.press('Tab');
  check((await hp.inputValue('[name=durM]')) === '0' && (await hp.locator('#dur-note').isHidden()), 'going on to the minutes changes nothing yet');
  await hp.fill('[name=durM]', '20');
  await hp.keyboard.press('Tab');
  check((await hp.inputValue('[name=durH]')) === '1' && (await hp.inputValue('[name=durM]')) === '30' && (await durNote()).startsWith('Rundet opp til 1 t 30 min'), `leaving the fields rounds up to the slots and says so (${await durNote()})`);
  check(await hp.locator('[name=durPick][value=other]').isChecked(), '"Other length" stays open, even on a length that has a button');
  await hp.click('.fold > summary:has(#slot-now)');
  await hp.selectOption('[name=slot]', '60');
  check((await hp.locator('[name=durPick][value="120"]').isChecked()) && (await durNote()).startsWith('Rundet opp til 2 t') && (await hp.locator('#slot-now').textContent()) === '60 min', 'hourly slots round the length up to 2 hours');
  await hp.locator('label.chip.pick', { hasText: '1 t 30 min' }).click();
  check((await hp.inputValue('[name=slot]')) === '30' && (await durNote()).startsWith('Rutene er nå på 30 min') && (await on(hp, D(0))) === 2, `a length the slots don't divide makes them finer, and says so (${await durNote()})`);
  await hp.locator('[name=durPick][value=other]').check();
  await hp.fill('[name=durH]', '0');
  await hp.fill('[name=durM]', '45');
  await hp.click('button[type=submit]');
  await hp.waitForURL(LINK_RE);
  const [hid, htok] = hp.url().split('/e/')[1].split('#');
  const hev = await hp.evaluate(async ([id, tok]) => (await (await fetch(`/api/events/${id}`, { headers: { authorization: `Bearer ${tok}` } })).json()).view.event, [hid, htok]);
  check(hev.duration === 45 && hev.slot === 15 && hev.dayStart === 360 && hev.dayEnd === 1320, `saved with focus still in the minutes: 45 min in 15-minute slots, hours 06-22 (${hev.duration}, ${hev.slot}, ${hev.dayStart}-${hev.dayEnd})`);
  await hp.context().close();
}
await boss.click('button[type=submit]');
await boss.waitForURL(LINK_RE);
const timesUrl = boss.url().replace(/#.*$/, '');

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
  await pp.waitForURL(LINK_RE);
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
check((await legendOverlaps(admin)).length === 0, `and nothing in the legend overlaps (${await legendOverlaps(admin)})`);
const legendUrl = admin.url();
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
      return `/e/${r.id}#${r.token}`;
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
  const undoBtn = un.locator('#days-card .count-row [data-act="undo"]');
  const redoBtn = un.locator('#days-card .count-row [data-act="redo"]');
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
  await un.locator('#days-card .count-row').evaluate((el) => el.scrollIntoView({ block: 'center' }));
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
  // Back in days mode, the days with times are the ones picked.
  await un.check('[name=mode][value=dates]');
  check((await picked(un)) === 15, 'switching back to days keeps the days that have times');
  await un.click('[data-act="sel-none"]');
  check(await toastEl.locator('.toast-act').isVisible(), '"None" shows its Undo toast');
  await un.click('a.brand');
  await un.click('#dlg button[value="yes"]');
  await un.waitForURL(`${BASE}/`);
  check(await toastEl.isHidden(), 'leaving the form takes that toast away');
  await un.close();
}

// --- V) Organisers: answers with the admin link, and the organisers' addresses ---------------
{
  const ad = await page({ refused: true });
  await ad.context().setExtraHTTPHeaders({ 'x-dev-ip': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  await ad.goto(`${BASE}/`);
  const days = [D(0), D(1), D(2)];
  const made = await ad.evaluate(async (days) => {
    const r = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: { name: 'Teammøte', mode: 'dates', start: days[0], end: days[2], options: days }, emails: [] }) });
    return r.json();
  }, days);
  const adminUrl = `${BASE}/e/${made.id}#${made.token}`;
  await ad.goto(adminUrl);
  await ad.waitForSelector('.role');
  check((await ad.locator('.role [data-act="answer"]').textContent()).includes('Legg til svar') && (await ad.locator('.role [data-act="answer-other"], [data-act="mark-own"]').count()) === 0, 'the admin has one "Legg til svar"');
  await ad.locator('.role').screenshot({ path: `${SHOTS}/37-admin-role.png` });
  // Anyone's answers, an organiser's own too: no email, and the person's link afterwards.
  const add = async (p, name, date) => {
    await p.click('.role [data-act="answer"]');
    await p.waitForSelector('#answer-form');
    const ok = (await p.locator('h1').textContent()) === 'Legg til svar' && (await p.locator('#answer-form [name=email]').count()) === 0;
    await p.fill('#answer-form [name=name]', name);
    await day(p, date).click();
    await p.click('[data-act="save-answer"]');
    await p.waitForSelector('#dlg[open]');
    const title = await p.locator('#dlg h3').textContent();
    await p.click('#dlg button[value=""]');
    return ok && title.includes(`Lenken til ${name}`);
  };
  check(await add(ad, 'Kari', D(0)), '"Legg til svar" has no email field, and saving shows that person’s link');
  check((await ad.locator('#answer-form [data-field="name"] .label').count()) === 0, 'and closes the form');
  check(await add(ad, 'Ola Admin', D(1)), 'an organiser adds their own answers the same way');
  check((await ad.locator('.plist .tag').count()) === 0, 'and nobody is "deg" with the admin link');
  const api = (method, body, path = '', token = made.token) =>
    ad.evaluate(
      async ([id, token, method, body, path]) => {
        const r = await fetch(`/api/events/${id}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: r.status, ...(await r.json()) };
      },
      [made.id, token, method, body, path],
    );
  let a = (await api('GET')).view;
  check(a.me === null && a.adminEmails.length === 0 && !('adminEmail' in a), 'the admin link is no person: no "me", and no addresses yet');
  // Kari sets her email with her own link; the admin changing her answers keeps it.
  const kari = a.people.find((p) => p.name === 'Kari');
  const kariTok = (await api('POST', {}, `/people/${kari.id}/link`)).token;
  await api('PUT', { name: 'Kari', comment: '', email: 'kari@example.com', answers: kari.answers }, `/people/${kari.id}`, kariTok);
  await ad.locator('.plist li', { hasText: 'Kari' }).locator('[data-act="edit-entry"]').click();
  await ad.waitForSelector('#answer-form');
  check((await ad.locator('h1').textContent()) === 'Endre svarene til Kari' && (await ad.locator('#answer-form [name=email]').count()) === 0, 'the admin changes anyone’s answers, without an email field');
  await day(ad, D(2)).click();
  await ad.click('[data-act="save-answer"]');
  await ad.waitForSelector('.role');
  const kariView = (await api('GET', undefined, '', kariTok)).view;
  const kariNow = kariView.people.find((p) => p.id === kari.id);
  check(kariNow.email === 'kari@example.com' && kariNow.answers[D(2)] === 1, 'the change is saved and her email kept');
  // An app from before sends own: true with an email: the entry still gets none.
  const old = await api('POST', { name: 'Gammel', comment: '', email: 'old@example.com', answers: {}, own: true }, '/people');
  check(!(await api('GET', undefined, '', old.token)).view.people.find((p) => p.id === old.pid).email, 'an entry added with the admin link never gets an email');
  // A second organiser with the same admin link.
  const co = await page({ refused: true });
  await co.context().setExtraHTTPHeaders({ 'x-dev-ip': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  await co.goto(adminUrl);
  await co.waitForSelector('.role');
  check(await add(co, 'Per', D(0)), 'a second organiser with the admin link adds their answers too');
  await co.close();
  // The organisers' addresses: a list in the event form; each gets the admin link back.
  const ownMail = `admin-${Date.now()}@example.com`;
  const coMail = `co-${Date.now()}@example.com`;
  await ad.click('[data-act="edit-event"]');
  await ad.waitForSelector('#ev-form');
  check((await ad.locator('#ev-form [data-field="email"] .label').textContent()) === 'E-post til arrangørene (valgfritt)', 'the event form asks for the organisers’ email');
  const mails = ad.locator('#ev-form input[name=email]');
  const removeBtns = ad.locator('#ev-form [data-act="email-remove"]');
  check((await mails.count()) === 1 && !(await removeBtns.first().isVisible()), 'one email field, with no × while it is alone');
  await mails.nth(0).fill(ownMail);
  await ad.click('#ev-form [data-act="email-add"]');
  check((await mails.count()) === 2 && (await ad.evaluate(() => document.activeElement === document.querySelectorAll('#ev-form input[name=email]')[1])), '"add another" adds a field and moves to it');
  await ad.keyboard.type(coMail.toUpperCase());
  await ad.click('#ev-form [data-act="email-add"]');
  await mails.nth(2).fill('ikke en adresse');
  await ad.click('#ev-form button[type=submit]');
  await ad.waitForSelector('#form-err:not([hidden])');
  check((await ad.locator('#form-err').textContent()).includes('ser ikke riktig ut') && (await ad.evaluate(() => document.activeElement === document.querySelectorAll('#ev-form input[name=email]')[2])), 'a wrong address is pointed out, in its own field');
  await removeBtns.nth(2).click();
  check((await mails.count()) === 2 && (await removeBtns.first().isVisible()), 'its × removes it');
  for (let i = 0; i < 10 && (await ad.locator('#ev-form [data-act="email-add"]').isVisible()); i++) await ad.click('#ev-form [data-act="email-add"]');
  check((await mails.count()) === 10, 'at most 10 fields');
  await ad.click('#ev-form button[type=submit]');
  await ad.waitForSelector('.role');
  a = (await api('GET')).view;
  check(JSON.stringify(a.adminEmails) === JSON.stringify([ownMail, coMail]), 'the list is saved, cleaned, without the empty fields');
  await ad.click('[data-act="edit-event"]');
  await ad.waitForSelector('#ev-form');
  check(JSON.stringify(await mails.evaluateAll((els) => els.map((e) => e.value))) === JSON.stringify([ownMail, coMail]), 'and shown again, one field each');
  await ad.locator('#ev-form [data-field="email"]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await ad.locator('#ev-form [data-field="email"]').screenshot({ path: `${SHOTS}/36-organiser-emails.png` });
  await ad.click('#ev-form [data-act="close-sub"]');
  await ad.waitForSelector('.role');
  const codeFor = async (email) => {
    const asked = await ad.evaluate(async (email) => (await fetch('/api/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, lang: 'nb' }) })).json(), email);
    const found = await ad.evaluate(async ([email, code]) => (await fetch('/api/lookup/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) })).json(), [email, asked.echo]);
    return (found.events ?? []).find((e) => e.id === made.id);
  };
  const ownHit = await codeFor(ownMail);
  const coHit = await codeFor(coMail);
  check(ownHit?.admin === made.token && coHit?.admin === made.token && !coHit.me, 'an email code for each organiser address gives the admin link');
  // Apps from before send `email` back as '' with every change: the list stays.
  const legacy = await api('PUT', { event: a.event, email: '' });
  check(legacy.status === 200 && legacy.view.adminEmails.length === 2, 'an old app’s empty `email` leaves the list alone');
  const tooMany = await api('PUT', { event: a.event, emails: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`) });
  check(tooMany.status === 400 && tooMany.error === 'emails', 'more than 10 addresses is refused');
  check((await api('PUT', { pid: null }, '/own')).status === 404, 'PUT /own is gone');
  // Deleting someone's answers keeps the admin link.
  const adminAt = ad.url();
  await ad.reload();
  await ad.waitForSelector('.plist');
  await ad.locator('.people').screenshot({ path: `${SHOTS}/31-admin-people.png` });
  await ad.locator('.plist li', { hasText: 'Ola Admin' }).locator('[data-act="delete-entry"]').click();
  await ad.click('#dlg button[value="yes"]');
  await ad.waitForSelector('.plist li:has-text("Ola Admin")', { state: 'detached' });
  check(ad.url() === adminAt, 'deleting answers keeps you on the admin link');
  // Signing out: the link once more, then the event is gone from this device.
  await ad.click('.role [data-act="leave"]');
  await ad.waitForSelector('#dlg[open]');
  check((await ad.locator('#dlg .linkbox input').inputValue()) === adminUrl, '"Logg ut" shows the admin link first');
  check((await ad.locator('#dlg').textContent()).includes('kode til e-postadressen'), 'and that an email code can bring it back');
  await ad.locator('#dlg').screenshot({ path: `${SHOTS}/35-leave.png` });
  await ad.click('#dlg button[value=""]');
  check(ad.url() === adminAt, 'cancelling stays');
  await ad.click('.role [data-act="leave"]');
  await ad.click('#dlg button[value="yes"]');
  await ad.waitForURL(`${BASE}/`);
  check((await ad.locator('#toast').textContent()).includes('Logget ut'), 'signing out goes home and says so');
  check(!(await ad.evaluate((id) => Boolean(JSON.parse(localStorage.getItem('whenever-v1') ?? '{}').events?.[id]), made.id)), 'and the event is gone from this device');
  await ad.goBack();
  await ad.waitForTimeout(300);
  check(!ad.url().includes(made.token), 'Back no longer leads to the admin link');
  await ad.close();
}

// --- X) Link tokens stay in the hash: never sent with a page, kept by the sub-views ---------
{
  const lp = await page();
  await lp.context().setExtraHTTPHeaders({ 'x-dev-ip': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  await lp.goto(`${BASE}/`);
  const days = [D(0), D(1), D(2)];
  const made = await lp.evaluate(async (days) => {
    const r = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: { name: 'Lenkeprøve', mode: 'dates', start: days[0], end: days[2], options: days }, emails: [] }) });
    return r.json();
  }, days);
  const adminUrl = `${BASE}/e/${made.id}#${made.token}`;
  const isAdmin = async () => (await lp.locator('.role [data-act="edit-event"]').count()) === 1;
  // Links from before, with the token in the path, still open: the token moves into the hash.
  await lp.goto(`${BASE}/e/${made.id}/${made.token}`);
  await lp.waitForSelector('.role');
  check(lp.url() === adminUrl && (await isAdmin()), 'a link from before opens as the admin link, with the token moved into the hash');
  await lp.goto(`${BASE}/e/${made.id}/${made.token}#answer`);
  await lp.waitForSelector('#answer-form');
  check(lp.url() === `${adminUrl}&answer`, 'and one with a sub-view keeps it after the token');
  // From here on, what goes over the wire: each request's path and query (a
  // browser never sends the hash) and the live socket's address.
  const sent = [];
  lp.on('request', (r) => {
    const u = new URL(r.url());
    sent.push(u.pathname + u.search);
  });
  lp.on('websocket', (ws) => {
    const u = new URL(ws.url());
    sent.push(u.pathname + u.search);
  });
  await lp.goto(`${BASE}/`);
  check((await lp.locator(`.mine a[href^="/e/${made.id}"]`).first().getAttribute('href')) === `/e/${made.id}#${made.token}`, 'the home page links your events with the token in the hash');
  await lp.goto(adminUrl);
  await lp.waitForSelector('.role');
  await lp.click('.role [data-act="edit-event"]');
  await lp.waitForSelector('#ev-form');
  check(lp.url() === `${adminUrl}&edit`, 'editing the event is #<token>&edit');
  await lp.click('#ev-form a.back');
  await lp.waitForSelector('.role');
  check(lp.url() === adminUrl && (await isAdmin()), 'Back from editing keeps the admin link');
  await lp.click('.role [data-act="answer"]');
  await lp.waitForSelector('#answer-form');
  check(lp.url() === `${adminUrl}&answer`, 'adding answers is #<token>&answer');
  await lp.click('a.back[data-act="cancel-answer"]');
  await lp.waitForSelector('.role');
  check(lp.url() === adminUrl && (await isAdmin()), 'and Back from there keeps it too');
  // Opened straight from the address, with no history entry to go back to.
  await lp.goto(`${BASE}/`);
  await lp.goto(`${adminUrl}&edit`);
  await lp.waitForSelector('#ev-form');
  await lp.click('#ev-form a.back');
  await lp.waitForSelector('.role');
  check(lp.url() === adminUrl && (await isAdmin()), 'an edit opened from the address goes back to the admin link');
  await lp.reload();
  await lp.waitForSelector('.role');
  check(await isAdmin(), 'and reloading stays admin');
  // The admin link pasted into a tab on the event link only changes the hash: no load.
  await lp.goto(`${BASE}/e/${made.id}`);
  await lp.waitForSelector('.plist, .role');
  check(!(await isAdmin()), 'the event link is no admin');
  await lp.goto(adminUrl);
  await lp.waitForFunction(() => document.querySelector('.role [data-act="edit-event"]'));
  check(await isAdmin(), 'and the admin link opened in the same tab makes it the admin page');
  const pages = sent.filter((u) => u === `/e/${made.id}`).length;
  const calls = sent.filter((u) => u.startsWith(`/api/events/${made.id}`)).length;
  check(pages >= 3 && calls >= 1 && !sent.some((u) => u.includes(made.token) || u.includes(made.token.slice(16))), `no page, API call or socket sent the token in its address (${pages} pages, ${calls} API calls and sockets)`);
  await lp.close();
}

// --- N) Listed names: who hasn't answered yet, apart from "can't make any" ------------------
{
  const ad = await page({ refused: true });
  await ad.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await ad.context().setExtraHTTPHeaders({ 'x-dev-ip': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  await ad.goto(`${BASE}/`);
  const days = [D(0), D(1), D(2)];
  const mk = (settings) =>
    ad.evaluate(
      async ([days, settings]) => (await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: { name: 'Hyttetur', mode: 'dates', start: days[0], end: days[2], options: days, settings } }) })).json(),
      [days, settings],
    );
  const made = await mk({ maybe: true });
  const api = (method, body, path = '', token = made.token, id = made.id) =>
    ad.evaluate(
      async ([id, token, method, body, path]) => {
        const r = await fetch(`/api/events/${id}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: r.status, ...(await r.json()) };
      },
      [id, token, method, body, path],
    );
  await ad.goto(`${BASE}/e/${made.id}#${made.token}`);
  await ad.waitForSelector('.people [data-act="add-names"]');
  check((await ad.locator('.people .wait-head').count()) === 0 && (await ad.locator('.people .progress').count()) === 0, 'no names listed: the Svar card is as before, with «Legg til navn»');
  await ad.click('[data-act="add-names"]');
  await ad.waitForSelector('#dlg[open] #names');
  await ad.fill('#dlg #names', 'Kari\nOla\n- Per\n2. Siri\nkari');
  await shot(ad, '60-names-dialog', false);
  await ad.click('#dlg button[value="add"]');
  await ad.waitForSelector('.people .wait-head');
  check((await ad.locator('#toast').textContent()).includes('La til 4 navn'), 'four names added (bullets, numbers and a repeat cleaned away)');
  check((await ad.locator('.people h2 .count').textContent()) === '0 av 4' && (await ad.locator('.people .progress').count()) === 1, 'the heading says 0 av 4, with a progress bar');
  check((await ad.locator('.plist li.wait').count()) === 4 && (await ad.locator('.plist li.wait [data-act="person-link"]').count()) === 4, 'the admin sees each waiting name with its link');
  await ad.click('[data-act="copy-reminder"]');
  const reminder = await ad.evaluate(() => navigator.clipboard.readText());
  check(reminder === `Kari, Ola, Per og Siri: husk å svare på «Hyttetur»! ${BASE}/e/${made.id}`, `the reminder names them, with the event link only (${reminder})`);
  let a = (await api('GET')).view;
  const ids = Object.fromEntries(a.waiting.map((w) => [w.name, w.id]));
  const id = (name) => ids[name];
  const olaOld = (await api('POST', { reset: false }, `/people/${id('Ola')}/link`)).token;
  const kariTok = (await api('POST', { reset: false }, `/people/${id('Kari')}/link`)).token;
  await ad.click('[data-act="add-names"]');
  await ad.waitForSelector('#dlg[open] #names');
  await ad.fill('#dlg #names', 'OLA\nPer');
  await ad.click('#dlg button[value="add"]');
  await ad.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('fra før'));
  check((await ad.locator('#toast').textContent()) === '2 navn var der fra før.' && (await ad.locator('.plist li.wait').count()) === 4, 'names already there are skipped, ignoring case');

  // Someone with the event link: the names, and "Er du en av disse?".
  const vis = await page();
  await vis.context().setExtraHTTPHeaders({ 'x-dev-ip': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  await vis.goto(`${BASE}/e/${made.id}`);
  await vis.waitForSelector('.people .wait-names');
  check((await vis.locator('.wait-names .pn').allTextContents()).join(',') === 'Kari,Ola,Per,Siri' && (await vis.locator('[data-act="person-link"], [data-act="add-names"], [data-act="copy-reminder"]').count()) === 0, 'others see who hasn’t answered, without the admin’s buttons');
  await vis.locator('.people').screenshot({ path: `${SHOTS}/61-names-visitor.png` });
  await vis.click('.role [data-act="answer"]');
  await vis.waitForSelector('#answer-form .claim');
  check((await vis.locator('.claim legend').textContent()) === 'Er du en av disse?' && (await vis.locator('.claim .chip').count()) === 4, 'the answer form asks «Er du en av disse?» with the four names');
  await vis.locator('#answer-form [name=name]').pressSequentially('Olav');
  check((await vis.locator('.claim .chip[aria-pressed="true"]').count()) === 0, 'typing "Olav" passes "Ola" but picks nobody');
  await vis.fill('#answer-form [name=name]', 'ola');
  check((await vis.locator('.claim .chip[aria-pressed="true"]').textContent()) === 'Ola', 'typing a listed name picks it');
  await vis.locator('#answer-form [name=name]').pressSequentially('v');
  check((await vis.locator('.claim .chip[aria-pressed="true"]').count()) === 0, 'and typing on unpicks it');
  await vis.fill('#answer-form [name=name]', 'ola');
  check((await vis.locator('.claim .chip:visible').allTextContents()).join(',') === 'Ola', 'the names are filtered by what is typed');
  await vis.fill('#answer-form [name=name]', '');
  await vis.locator('.claim .chip', { hasText: 'Siri' }).click();
  check((await vis.inputValue('#answer-form [name=name]')) === 'Siri' && (await vis.locator('.claim .chip[aria-pressed="true"]').textContent()) === 'Siri', 'tapping another name picks that one and fills it in');
  await vis.fill('#answer-form [name=name]', '');
  await vis.locator('.claim .chip', { hasText: 'Ola' }).click();
  await day(vis, D(0)).click();
  await shot(vis, '62-names-claim', false);
  await vis.click('[data-act="save-answer"]');
  await vis.waitForURL(/\/e\/[A-Za-z0-9]{12}#[0-9a-f]{16}/);
  await vis.waitForSelector('.people h2 .count');
  check((await vis.locator('.people h2 .count').textContent()) === '1 av 4' && (await vis.locator('.wait-names .pn').allTextContents()).join(',') === 'Kari,Per,Siri', 'Ola answered as Ola: 1 av 4, and Ola has left the waiting names');
  check((await vis.locator('.best-item .bn').first().textContent()).startsWith('1 av 1 kan'), 'and the results count only those who answered (1 av 1 kan, not 1 av 4)');
  a = (await api('GET')).view;
  check(a.people.length === 1 && a.people[0].id === id('Ola') && a.count === 1 && a.waitingCount === 3, 'the answer went on Ola’s entry, not a new one');
  check((await api('GET', undefined, '', olaOld)).view.link === 'ok' && tokenOf(vis.url()) === olaOld, 'and Ola got the link sent to him before, which still works');
  const again = await api('POST', { name: 'Ola', answers: {}, claim: id('Ola') }, '/people', null);
  check(again.status === 409 && again.error === 'taken', 'answering as a name that has answered: 409 taken');

  // The admin answers for Siri while she answers herself: hers stay.
  await ad.goto(`${BASE}/e/${made.id}#${made.token}`);
  await ad.waitForSelector('.plist li.wait');
  await ad.locator('.plist li.wait', { hasText: 'Siri' }).locator('[data-act="edit-entry"]').click();
  await ad.waitForSelector('#answer-form');
  const siriTok = (await api('POST', { reset: false }, `/people/${id('Siri')}/link`)).token;
  await api('PUT', { name: 'Siri', comment: '', email: '', answers: { [days[2]]: 1 } }, `/people/${id('Siri')}`, siriTok);
  await day(ad, D(0)).click();
  await ad.click('[data-act="save-answer"]');
  await ad.waitForSelector('.people h2 .count');
  check((await ad.locator('#toast').textContent()).startsWith('Personen har nettopp svart selv'), 'the admin answering for Siri as she answers herself: told so');
  a = (await api('GET')).view;
  const siri = a.people.find((p) => p.name === 'Siri');
  check(siri && JSON.stringify(siri.answers) === JSON.stringify({ [days[2]]: 1 }), 'and her own answers stay');
  // Back to waiting for the rest of this section: remove her answers' entry and list her again.
  await api('DELETE', undefined, `/people/${id('Siri')}`);
  ids.Siri = (await api('POST', { names: ['Siri'] }, '/invite')).view.waiting.find((w) => w.name === 'Siri').id;

  // The admin answers for Per with nothing marked: answered, can't make any.
  await ad.goto(`${BASE}/e/${made.id}#${made.token}`);
  await ad.waitForSelector('.plist li.wait');
  await ad.locator('.plist li.wait', { hasText: 'Per' }).locator('[data-act="edit-entry"]').click();
  await ad.waitForSelector('#answer-form');
  check((await ad.locator('h1').textContent()) === 'Svar for Per' && (await ad.inputValue('#answer-form [name=name]')) === 'Per' && (await ad.locator('.claim').count()) === 0, 'the admin answers for a waiting name from its row');
  await ad.click('[data-act="save-answer"]');
  await ad.waitForSelector('.people .plist li:not(.wait)');
  const per = ad.locator('.plist li:not(.wait)', { hasText: 'Per' });
  check((await per.locator('.psum').textContent()) === 'Kan ingen av dagene' && (await ad.locator('.people h2 .count').textContent()) === '2 av 4', 'Per answered with nothing marked: «Kan ingen av dagene», 2 av 4');
  check((await ad.locator('.plist li.wait .pinfo b').allTextContents()).join(',') === 'Kari,Siri', 'and Kari and Siri are still waiting');
  await ad.locator('.best-item').first().click();
  await ad.waitForSelector('#detail .dg.wait');
  check((await ad.locator('#detail .dg.wait b').textContent()).includes('Ikke svart (2)') && (await ad.locator('#detail .dg.wait .pn').allTextContents()).join(',') === 'Kari,Siri' && (await ad.locator('#detail .dg.no .pn').allTextContents()).join(',') === 'Per', 'the details list who hasn’t answered apart from who can’t');
  await ad.locator('.people').screenshot({ path: `${SHOTS}/63-names-admin.png` });
  // Removing a name.
  await ad.locator('.plist li.wait', { hasText: 'Siri' }).locator('[data-act="delete-entry"]').click();
  await ad.waitForSelector('#dlg[open]');
  check((await ad.locator('#dlg p').textContent()) === 'Fjerne Siri fra listen?', 'removing a name asks «Fjerne Siri fra listen?»');
  await ad.click('#dlg button[value="yes"]');
  await ad.waitForFunction(() => document.querySelectorAll('.plist li.wait').length === 1);
  check((await ad.locator('.people h2 .count').textContent()) === '2 av 3', 'and the count follows: 2 av 3');

  // Kari opens the link the admin sent her.
  const kari = await page();
  await kari.goto(`${BASE}/e/${made.id}#${kariTok}`);
  await kari.waitForSelector('.role');
  check((await kari.locator('.role b').first().textContent()) === 'Hei, Kari!' && (await kari.locator('.role p').textContent()) === 'Du har ikke svart ennå.' && (await kari.locator('.role [data-act="answer"]').textContent()).includes('Legg til dine svar'), 'Kari’s own link: «Du har ikke svart ennå.» and «Legg til dine svar»');
  await kari.click('.role [data-act="answer"]');
  await kari.waitForSelector('#answer-form');
  check((await kari.locator('h1').textContent()) === 'Legg til dine svar' && (await kari.inputValue('#answer-form [name=name]')) === 'Kari' && (await kari.locator('.claim').count()) === 0, 'her form has her name and no list to pick from');
  await day(kari, D(1)).click();
  await kari.click('[data-act="save-answer"]');
  await kari.waitForFunction(() => document.querySelector('.people h2 .count')?.textContent === '3');
  check((await api('GET', undefined, '', kariTok)).view.link === 'ok', 'her link still works after answering');
  check((await kari.locator('.people .progress').count()) === 0 && (await kari.locator('.wait-head').count()) === 0, 'everyone has answered: just 3, nobody waiting');
  // The admin's «Legg til svar» offers the names too, and fills that entry.
  await api('POST', { names: ['Tor'] }, '/invite');
  await ad.goto(`${BASE}/e/${made.id}#${made.token}`);
  await ad.waitForSelector('.plist li.wait');
  await ad.click('.role [data-act="answer"]');
  await ad.waitForSelector('#answer-form .claim');
  check((await ad.locator('.claim legend').textContent()) === 'Svarer du for en av disse?', 'the admin’s «Legg til svar» asks «Svarer du for en av disse?»');
  await ad.locator('.claim .chip', { hasText: 'Tor' }).click();
  await day(ad, D(2)).click();
  await ad.click('[data-act="save-answer"]');
  await ad.waitForFunction(() => document.querySelector('.people h2 .count')?.textContent === '4');
  a = (await api('GET')).view;
  check((await ad.locator('#dlg[open]').count()) === 0 && a.people.some((p) => p.name === 'Tor' && p.answers[days[2]] === 1) && a.waitingCount === 0 && a.people.length === 4, 'and saving fills Tor’s entry (no new one, no link dialog)');

  // Hidden answers: only the numbers, and no list to pick from.
  const hid = await mk({ maybe: true, hidden: true });
  await api('POST', { names: ['Liv', 'Mona'] }, '/invite', hid.token, hid.id);
  await vis.goto(`${BASE}/e/${hid.id}`);
  await vis.waitForSelector('.people h2');
  check((await vis.locator('.people h2 .count, .people .progress').count()) === 0 && (await vis.locator('.wait-names, .wait-head').count()) === 0 && !(await vis.content()).includes('Mona'), 'hidden answers: others see neither how many have answered nor who');
  check((await vis.locator('.results p').textContent()) === 'Svarene er skjult: bare arrangørene ser dem, og hvor mange som har svart.' && (await vis.locator('.people').textContent()).includes('Svarene er skjult. Du ser bare ditt eget.') && !(await vis.locator('.people').textContent()).includes('Ingen har svart'), 'and no number in the text, nor «Ingen har svart ennå»');
  await vis.click('.role [data-act="answer"]');
  await vis.waitForSelector('#answer-form');
  check((await vis.locator('.claim').count()) === 0, 'and no «Er du en av disse?»');
  const hv = (await api('GET', undefined, '', null, hid.id)).view;
  const liv = (await api('GET', undefined, '', hid.token, hid.id)).view.waiting[0].id;
  const ha = (await api('GET', undefined, '', hid.token, hid.id)).view;
  check(hv.waiting.length === 0 && !('count' in hv) && !('waitingCount' in hv) && ha.count === 0 && ha.waitingCount === 2 && (await api('POST', { name: 'Liv', answers: {}, claim: liv }, '/people', null, hid.id)).status === 403, 'the API sends no names and no counts (but to the admin), and refuses a claim');
  await Promise.all([ad.close(), vis.close(), kari.close()]);
}

// --- O) Drafts, tapping your name, answering for others, long lists ---------------------------
{
  const ad = await page({ refused: true });
  await ad.context().setExtraHTTPHeaders({ 'x-dev-ip': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  await ad.goto(`${BASE}/`);
  const days = [D(0), D(1), D(2)];
  const mk = (name, settings) =>
    ad.evaluate(
      async ([days, name, settings]) => (await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: { name, mode: 'dates', start: days[0], end: days[2], options: days, settings } }) })).json(),
      [days, name, settings],
    );
  const call = (ev, method, body, path = '', token = ev.token) =>
    ad.evaluate(
      async ([id, token, method, body, path]) => {
        const r = await fetch(`/api/events/${id}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: r.status, ...(await r.json()) };
      },
      [ev.id, token, method, body, path],
    );

  // Kari taps her name, saves a draft, then answers, then takes it back.
  const ev = await mk('Sommerfest', { maybe: true });
  await call(ev, 'POST', { names: ['Kari', 'Ola', 'Per'] }, '/invite');
  const kp = await page();
  await kp.goto(`${BASE}/e/${ev.id}`);
  await kp.waitForSelector('.wait-names .pn.tap');
  await kp.locator('.wait-names .pn.tap', { hasText: 'Kari' }).click();
  await kp.waitForSelector('#answer-form');
  check((await kp.locator('h1').textContent()) === 'Legg til dine svar' && (await kp.inputValue('#answer-form [name=name]')) === 'Kari' && (await kp.locator('.claim .chip[aria-pressed="true"]').textContent()) === 'Kari', 'tapping Kari in the Svar card opens the form as Kari');
  check(await kp.locator('#answer-form [name=counted]').isChecked(), '«Vis som besvart» is ticked when the form opens');
  await day(kp, D(0)).click();
  await kp.locator('#answer-form [name=counted]').uncheck();
  check((await kp.locator('#draft-note').isVisible()) && (await kp.locator('#draft-note').textContent()).startsWith('Lagres som utkast: du står under «Har ikke svart ennå»'), 'unticked, it says the answers are saved as a draft');
  await kp.click('[data-act="save-answer"]');
  await kp.waitForURL(/\/e\/[A-Za-z0-9]{12}#[0-9a-f]{16}/);
  await kp.waitForSelector('.notice.ok h2');
  const kariTok = tokenOf(kp.url());
  check((await kp.locator('.notice.ok h2').textContent()) === 'Utkastet ditt er lagret, Kari.' && (await kp.locator('.role p').textContent()) === 'Du har et utkast som ikke telles med ennå.', 'saved as a draft: «Utkastet ditt er lagret», and the role card says so');
  check((await kp.locator('.people h2 .count').textContent()) === '0 av 3' && (await kp.locator('.wait-names .pn').allTextContents()).some((x) => x.startsWith('Kari')) && (await kp.locator('.best-item').count()) === 0, 'a draft isn’t counted: 0 av 3, Kari still waiting, no results');
  const drafts = async (token) => (await call(ev, 'GET', undefined, '', token)).view.waiting.find((w) => w.name === 'Kari')?.answers;
  check((await Promise.all([null, kariTok, ev.token].map(drafts))).every((x) => JSON.stringify(x) === JSON.stringify({ [D(0)]: 1 })), 'Kari, the organisers and anyone who may answer as her get her draft');
  const kariId = (await call(ev, 'GET')).view.waiting.find((w) => w.name === 'Kari').id;
  await kp.click('.role [data-act="answer"]');
  await kp.waitForSelector('#answer-form');
  check((await kp.locator('h1').textContent()) === 'Endre svarene dine' && (await kp.locator('#pick-sum').textContent()) === 'Du kan 1 av 3 dager' && (await kp.locator('#answer-form [name=counted]').isChecked()), 'her form opens with the draft, ticked');
  await kp.click('[data-act="save-answer"]');
  await kp.waitForFunction(() => document.querySelector('.people h2 .count')?.textContent === '1 av 3');
  check((await kp.locator('.best-item .bn').first().textContent()).startsWith('1 av 1 kan'), 'saved ticked: counted, 1 av 3');
  await kp.click('.role [data-act="answer"]');
  await kp.waitForSelector('#answer-form');
  await kp.locator('#answer-form [name=counted]').uncheck();
  await kp.click('[data-act="save-answer"]');
  await kp.waitForFunction(() => document.querySelector('.people h2 .count')?.textContent === '0 av 3');
  check((await kp.locator('#toast').textContent()).startsWith('Utkastet er lagret') && JSON.stringify(await drafts(kariTok)) === JSON.stringify({ [D(0)]: 1 }), 'unticking takes the answer back: not counted, the answers kept');
  const del = await call(ev, 'DELETE', undefined, `/people/${(await call(ev, 'GET')).view.waiting.find((w) => w.name === 'Ola').id}`, null);
  check(del.status === 403, 'someone else can’t remove a waiting name');

  // Someone else answers as Kari, who has a draft (and an email), and Per
  // has a draft the organisers saved: all just waiting names.
  await call(ev, 'PUT', { name: 'Kari', comment: 'Usikker', email: 'kari@example.com', answers: { [D(0)]: 1 }, draft: true }, `/people/${kariId}`, kariTok);
  const perId = (await call(ev, 'GET')).view.waiting.find((w) => w.name === 'Per').id;
  await call(ev, 'PUT', { name: 'Per', comment: 'Kanskje', answers: { [D(1)]: 2 }, waiting: true, draft: true }, `/people/${perId}`);
  const kariFor = async (tok) => (await call(ev, 'GET', undefined, '', tok)).view.waiting.find((w) => w.name === 'Kari');
  check((await kariFor(null)).comment === 'Usikker' && (await kariFor(null)).email === undefined && (await kariFor(kariTok)).email === 'kari@example.com', 'a visitor gets Kari’s draft, but never her email');
  const e0 = (await call(ev, 'GET')).view.event;
  await call(ev, 'PUT', { event: { ...e0, settings: { ...e0.settings, closed: true } } });
  const perFor = async (tok) => (await call(ev, 'GET', undefined, '', tok)).view.waiting.find((w) => w.name === 'Per');
  check((await perFor(null)).answers === undefined && JSON.stringify((await perFor(ev.token)).answers) === JSON.stringify({ [D(1)]: 2 }), 'closed: visitors can’t answer as anyone, so they get no drafts');
  await call(ev, 'PUT', { event: e0 });
  const other = await page({ refused: true });
  await other.setViewportSize({ width: 360, height: 760 });
  await other.goto(`${BASE}/e/${ev.id}`);
  await other.waitForSelector('.wait-names .pn.tap');
  check(JSON.stringify(await other.locator('.wait-names .pn.tap').allTextContents()) === JSON.stringify(['Kari', 'Ola', 'Per']), 'names with a draft look and tap like the others');
  await other.locator('.wait-names .pn.tap', { hasText: 'Kari' }).click();
  await other.waitForSelector('#answer-form');
  const comment = () => other.inputValue('#answer-form [name=comment]');
  check((await other.locator('h1').textContent()) === 'Endre svarene dine' && (await other.locator('#pick-sum').textContent()) === 'Du kan 1 av 3 dager' && (await comment()) === 'Usikker' && (await other.inputValue('#answer-form [name=email]')) === '', 'tapping Kari opens her draft, without her email');
  await shot(other, '67-tap-draft', false);
  await other.locator('.claim .chip', { hasText: 'Kari' }).click();
  check((await comment()) === '' && (await other.locator('#pick-sum').textContent()) === 'Ingenting markert ennå', 'unpicking her takes her draft out again');
  await other.fill('#answer-form [name=name]', '');
  const perDay = async () => (await day(other, D(1)).getAttribute('class')).includes('a2');
  await other.locator('.claim .chip', { hasText: 'Per' }).click();
  check((await comment()) === 'Kanskje' && (await perDay()), 'picking Per in the name box puts his draft in the form');
  await other.locator('.claim .chip', { hasText: 'Per' }).click();
  check((await comment()) === '' && !(await perDay()), 'and unpicking takes it out');
  await other.fill('#answer-form [name=name]', '');
  await other.fill('#answer-form [name=name]', 'Per');
  check((await comment()) === 'Kanskje' && (await other.evaluate(() => document.activeElement?.getAttribute('name'))) === 'name', 'typing «Per» puts it in too, and you go on typing');
  await other.fill('#answer-form [name=name]', 'Pera');
  check((await comment()) === '' && (await other.locator('.claim .chip[aria-pressed="true"]').count()) === 0, 'typing on takes it out again');
  const cy = () => other.locator('#answer-form [name=comment]').evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
  await other.fill('#answer-form [name=name]', '');
  const cy0 = await cy();
  await other.fill('#answer-form [name=name]', 'Zacharias');
  const cy1 = await cy();
  await other.fill('#answer-form [name=name]', 'pe');
  check(cy0 === cy1 && cy1 === (await cy()) && (await other.locator('.claim-none').isHidden()), 'a one-row list keeps its height too, also with «Ingen på listen heter det» (360 px)');
  // Per answers (here: the organisers for him) while his draft is in the form.
  await other.locator('.claim .chip', { hasText: 'Per' }).click();
  await call(ev, 'PUT', { name: 'Per', comment: 'Kanskje', answers: { [D(1)]: 2 }, waiting: true }, `/people/${perId}`);
  await other.click('[data-act="save-answer"]');
  await other.waitForFunction(() => !document.querySelector('.claim .chip[aria-pressed="true"]'));
  check((await comment()) === '' && !(await perDay()) && (await other.locator('.claim .chip', { hasText: 'Per' }).count()) === 0 && (await other.locator('#toast').textContent()).startsWith('Noen har nettopp svart'), 'if Per answers meanwhile, saving says so and takes his draft out of the form');
  await other.fill('#answer-form [name=name]', '');
  await other.fill('#answer-form [name=name]', 'Kari');
  check((await comment()) === 'Usikker', 'typing «Kari» puts her draft back');
  await other.click('[data-act="save-answer"]');
  await other.waitForURL(/\/e\/[A-Za-z0-9]{12}#[0-9a-f]{16}/);
  await other.waitForSelector('.people h2 .count');
  const kariNow = (await call(ev, 'GET', undefined, '', kariTok)).view;
  const kariRow = kariNow.people.find((x) => x.id === kariId);
  check(tokenOf(other.url()) === kariTok && kariNow.link === 'ok' && (await call(ev, 'POST', { reset: false }, `/people/${kariId}/link`)).token === kariTok, 'answering as Kari gives her own link, which still works for her (the same as the organisers’ copy)');
  check(kariRow?.comment === 'Usikker' && JSON.stringify(kariRow.answers) === JSON.stringify({ [D(0)]: 1 }) && kariRow.email === '' && (await other.locator('.people h2 .count').textContent()) === '2 av 3', 'her draft was saved as the answer, counted, and her email replaced (none given)');
  await other.context().close();

  // With «Alle kan endre svarene»: anyone answers for a waiting name.
  const open = await mk('Dugnad', { maybe: true, openEdit: true });
  await call(open, 'POST', { names: ['Liv', 'Mona'] }, '/invite');
  let ov = (await call(open, 'GET')).view;
  const liv = ov.waiting.find((w) => w.name === 'Liv').id;
  const mona = ov.waiting.find((w) => w.name === 'Mona').id;
  const livTok = (await call(open, 'POST', { reset: false }, `/people/${liv}/link`)).token;
  const monaTok = (await call(open, 'POST', { reset: false }, `/people/${mona}/link`)).token;
  await call(open, 'PUT', { name: 'Mona', comment: '', email: '', answers: { [D(2)]: 1 }, draft: true }, `/people/${mona}`, monaTok);
  const op = await page();
  await op.goto(`${BASE}/e/${open.id}`);
  await op.waitForSelector('.plist li.wait');
  const livRow = op.locator('.plist li.wait', { hasText: 'Liv' });
  check((await livRow.locator('[data-act="edit-entry"]').count()) === 1 && (await op.locator('.plist li.wait [data-act="person-link"], .plist li.wait [data-act="delete-entry"], [data-act="copy-reminder"]').count()) === 0, 'with «Alle kan endre svarene», waiting names have «Svar for», but no link or remove');
  check(JSON.stringify((await call(open, 'GET', undefined, '', null)).view.waiting.find((w) => w.id === mona).answers) === JSON.stringify({ [D(2)]: 1 }), 'and anyone who may change Mona’s answers gets her draft');
  await livRow.locator('[data-act="edit-entry"]').click();
  await op.waitForSelector('#answer-form');
  check((await op.locator('h1').textContent()) === 'Svar for Liv' && (await op.locator('.claim').count()) === 0 && (await op.locator('#answer-form [name=counted]').count()) === 1, 'answering for Liv: no name list, and the checkbox');
  await op.locator('#answer-form [name=counted]').uncheck();
  check((await op.locator('#draft-note').textContent()).startsWith('Lagres som utkast: personen står'), 'whose note is about her, not you');
  await op.locator('#answer-form [name=counted]').check();
  await day(op, D(1)).click();
  await op.click('[data-act="save-answer"]');
  await op.waitForFunction(() => document.querySelector('.people h2 .count')?.textContent === '1 av 2');
  ov = (await call(open, 'GET', undefined, '', livTok)).view;
  check(ov.link === 'ok' && ov.role === 'participant' && ov.people.some((p) => p.id === liv && p.answers[D(1)] === 1) && (await op.evaluate(() => localStorage.getItem('whenever-v1') ?? '')).includes(liv) === false, 'Liv is answered, her link still works, and this device didn’t get it');

  // 40 names: a box of three rows, filtered as you type, at a fixed height.
  const many = await mk('Julebord', { maybe: true });
  const fill = Array.from({ length: 37 }, (_, i) => `Gjest ${String(i + 1).padStart(2, '0')}`);
  await call(many, 'POST', { names: ['Kari', 'Karianne', 'Anne Karlsen', ...fill] }, '/invite');
  const mp = await page();
  await mp.goto(`${BASE}/e/${many.id}`);
  await mp.waitForSelector('.role [data-act="answer"]');
  await mp.click('.role [data-act="answer"]');
  await mp.waitForSelector('#answer-form .claim-box');
  const boxH = () => mp.locator('.claim-box').evaluate((e) => e.offsetHeight);
  const below = () => mp.locator('#answer-form [name=comment]').evaluate((e) => Math.round(e.getBoundingClientRect().top + scrollY));
  const h0 = await boxH();
  const y0 = await below();
  const inert = () => mp.locator('.claim-box .chip').evaluateAll((cs) => cs.filter((c) => c.inert).length);
  check((await mp.locator('.claim-box.cut').count()) === 1 && h0 < 130 && (await inert()) > 20 && (await mp.locator('.claim-more button').textContent()) === 'Vis alle (40)', `40 names: three rows (${h0}px), the rest cut off and out of reach, «Vis alle (40)»`);
  await mp.locator('#answer-form [name=name]').pressSequentially('ka');
  check((await mp.locator('.claim .chip:visible').allTextContents()).join(',') === 'Kari,Karianne,Anne Karlsen' && (await boxH()) === h0 && (await below()) === y0, '«ka» shows Kari, Karianne and Anne Karlsen, and nothing below moves');
  check((await mp.locator('#claim-status').textContent()) === '3 navn på listen passer', 'and a screen reader hears how many');
  await mp.locator('#answer-form [name=name]').pressSequentially('x');
  check((await mp.locator('.claim .chip:visible').count()) === 0 && (await mp.locator('.claim-none').isVisible()) && (await boxH()) === h0 && (await below()) === y0, 'no match: «Ingen på listen heter det», still the same height');
  await mp.fill('#answer-form [name=name]', '');
  await mp.click('.claim-more button');
  check((await inert()) === 0 && (await boxH()) > h0 * 3 && (await mp.locator('.claim-more button').textContent()) === 'Vis færre', '«Vis alle» opens the box');
  await shot(mp, '66-names-box', false);
  // The admin's Svar card: the first ten, then «Vis alle».
  await ad.goto(`${BASE}/e/${many.id}#${many.token}`);
  await ad.waitForSelector('.plist li.wait');
  check((await ad.locator('.plist li.wait').count()) === 10 && (await ad.locator('[data-act="wait-more"]').textContent()).startsWith('Vis alle (40)'), 'the admin sees the first 10 waiting names, then «Vis alle (40)»');
  await ad.click('[data-act="wait-more"]');
  await ad.waitForFunction(() => document.querySelectorAll('.plist li.wait').length === 40);
  check(true, 'and all 40 after');

  // The checkbox and the bar fit a 360 px phone in every language.
  const fits = [];
  for (const lang of ['nb-NO', 'nn-NO', 'sv-SE', 'da-DK', 'is-IS', 'en-GB']) {
    const lp = await page({ lang });
    await lp.setViewportSize({ width: 360, height: 760 });
    await lp.goto(`${BASE}/e/${ev.id}#answer`);
    await lp.waitForSelector('#answer-form [name=counted]');
    const ok = await lp.evaluate(() => {
      const bs = [...document.querySelectorAll('.savebar .btn')];
      const one = bs.every((b) => b.getBoundingClientRect().top === bs[0].getBoundingClientRect().top);
      const lab = document.querySelector('.check.counted');
      return one && lab.scrollWidth <= lab.clientWidth && document.documentElement.scrollWidth <= 360;
    });
    if (!ok) fits.push(lang);
    await lp.close();
  }
  check(fits.length === 0, `the checkbox and the bar fit 360 px in all six languages${fits.length ? ` (not ${fits.join(', ')})` : ''}`);
  await Promise.all([ad.close(), kp.close(), op.close(), mp.close()]);
}

// --- Q) What participants may do: the settings under «Deltakerne kan» -----------------------
{
  const ad = await page({ refused: true });
  await ad.goto(`${BASE}/`);
  const days = [D(0), D(1), D(2)];
  const mk = (name, settings) =>
    ad.evaluate(
      async ([days, name, settings]) => (await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: { name, mode: 'dates', start: days[0], end: days[2], options: days, settings } }) })).json(),
      [days, name, settings],
    );
  const call = (ev, method, body, path = '', token = ev.token) =>
    ad.evaluate(
      async ([id, token, method, body, path]) => {
        const r = await fetch(`/api/events/${id}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: r.status, ...(await r.json()) };
      },
      [ev.id, token, method, body, path],
    );
  const toastText = async (p) => {
    await p.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
    const s = await p.locator('#toast').textContent();
    await p.evaluate(() => (document.querySelector('#toast').hidden = true));
    return s;
  };

  // The settings card: «Deltakerne kan», what hangs on «se svarene», 360 px in every language.
  await ad.setViewportSize({ width: 360, height: 760 });
  await ad.goto(`${BASE}/new`);
  await ad.waitForSelector('.perms');
  const boxes = () => ad.evaluate(() => Object.fromEntries([...document.querySelectorAll('.perms input')].map((e) => [e.name.slice(2), `${e.checked ? 'on' : 'off'}${e.disabled ? '-' : ''}`])));
  check(JSON.stringify(await boxes()) === JSON.stringify({ hidden: 'on', newNames: 'on', claims: 'on', rename: 'on', openEdit: 'off', decide: 'off', details: 'off' }) && (await ad.locator('.perms legend').textContent()) === 'Deltakerne kan', 'the form says what participants can do, ticked as before the settings existed');
  await ad.check('.perms [name="s-openEdit"]');
  await ad.uncheck('.perms [name="s-hidden"]');
  const greyed = await boxes();
  await ad.check('.perms [name="s-hidden"]');
  const back = await boxes();
  check(greyed.openEdit === 'off-' && greyed.claims === 'off-' && greyed.decide === 'off-' && greyed.newNames === 'on' && back.openEdit === 'on' && back.claims === 'on', 'without «se svarene», what needs the others’ answers is greyed out, and comes back as it was');
  await ad.locator('section.card:has(.perms)').screenshot({ path: `${SHOTS}/70-perms-settings.png` });
  const tight = [];
  for (const lang of ['nb-NO', 'nn-NO', 'sv-SE', 'da-DK', 'is-IS', 'en-GB']) {
    const lp = await page({ lang });
    await lp.setViewportSize({ width: 360, height: 760 });
    await lp.goto(`${BASE}/new`);
    await lp.waitForSelector('.perms');
    const ok = await lp.evaluate(() => [...document.querySelectorAll('.perms .check')].every((c) => c.scrollWidth <= c.clientWidth) && document.documentElement.scrollWidth <= 360);
    if (!ok) tight.push(lang);
    await lp.close();
  }
  check(tight.length === 0, `«Deltakerne kan» fits 360 px in all six languages${tight.length ? ` (not ${tight.join(', ')})` : ''}`);
  await ad.setViewportSize({ width: 390, height: 844 });

  // Defaults, and a PUT from an app or API client that doesn't know the new settings.
  const plain = await mk('Vanlig', { maybe: true });
  const ps = plain.view.event.settings;
  check(ps.newNames && ps.claims && ps.rename && !ps.decide && !ps.details, 'a poll made without them gets the defaults');
  const ev0 = (await mk('Gammel klient', { newNames: false, decide: true, details: true }));
  const { newNames, claims, rename, decide, details, ...old } = ev0.view.event.settings;
  const put = await call(ev0, 'PUT', { event: { ...ev0.view.event, name: 'Gammel klient 2', settings: { ...old } } });
  check(put.status === 200 && !put.view.event.settings.newNames && put.view.event.settings.decide && put.view.event.settings.details, 'the admin’s PUT without the new settings keeps them');
  const hid = await call(ev0, 'PUT', { event: { ...put.view.event, settings: { ...put.view.event.settings, hidden: true } } });
  check(hid.view.event.settings.hidden && (await call(ev0, 'POST', { decided: days[0] }, '/decide', null)).status === 403, 'with hidden answers, nobody else picks (the setting stays for later)');
  const unhid = await call(ev0, 'PUT', { event: { ...hid.view.event, settings: { ...hid.view.event.settings, hidden: false } } });
  check(unhid.view.event.settings.decide && (await call(ev0, 'POST', { decided: days[0] }, '/decide', null)).status === 200, 'and un-hiding brings it back');

  // Only the listed names answer (newNames off).
  const lo = await mk('Bare lista', { newNames: false });
  await call(lo, 'POST', { names: ['Kari', 'Per'] }, '/invite');
  const loV = (await call(lo, 'GET')).view;
  const per = loV.waiting.find((w) => w.name === 'Per').id;
  check((await call(lo, 'POST', { name: 'Ola', comment: '', answers: {} }, '/people', null)).error === 'listOnly', 'a new name gets 403 listOnly');
  const vp = await page({ refused: true });
  await vp.goto(`${BASE}/e/${lo.id}`);
  await vp.waitForSelector('.role.cta');
  check((await vp.locator('.head .meta').textContent()).includes('Bare navnene på listen kan svare') && (await vp.locator('.role.cta').textContent()).includes('Bare navnene på listen kan svare.'), 'the page says only the names on the list can answer');
  await vp.click('.role [data-act="answer"]');
  await vp.waitForSelector('#answer-form .claim');
  check((await vp.locator('.claim legend').textContent()) === 'Hvem er du?', 'the form asks «Hvem er du?»');
  await vp.locator('section.card:has(#answer-form)').screenshot({ path: `${SHOTS}/71-list-only.png` });
  await vp.fill('#answer-form [name=name]', 'Ola');
  await day(vp, D(0)).click();
  await vp.click('[data-act="save-answer"]');
  check((await toastText(vp)) === 'Bare navnene på listen kan svare. Velg ditt.', 'a name not on the list isn’t saved');
  await vp.fill('#answer-form [name=name]', '');
  await vp.locator('.claim .chip', { hasText: 'Per' }).click();
  await vp.click('[data-act="save-answer"]');
  await vp.waitForURL(new RegExp(`/e/${lo.id}#${per}`));
  check(true, 'picking Per answers as Per');
  const lo2 = await mk('Bare lenker', { newNames: false, claims: false });
  await call(lo2, 'POST', { names: ['Kari'] }, '/invite');
  const kari2 = (await call(lo2, 'GET')).view.waiting[0].id;
  const vq = await page({ refused: true });
  await vq.goto(`${BASE}/e/${lo2.id}`);
  await vq.waitForSelector('.role.cta');
  check((await vq.locator('.role [data-act="answer"]').count()) === 0 && (await vq.locator('.role.cta').textContent()).includes('med den personlige lenken de har fått fra arrangørene') && (await vq.locator('.wait-names .tap').count()) === 0, 'without claims too, only personal links answer: no button, no names to tap');
  check((await call(lo2, 'POST', { name: 'Kari', comment: '', answers: {}, claim: kari2 }, '/people', null)).status === 403, 'and the API refuses a claim');

  // No claims: listed names answer with their personal link; visitors see no drafts.
  const nc = await mk('Uten trykk', { claims: false });
  await call(nc, 'POST', { names: ['Kari'] }, '/invite');
  const ncK = (await call(nc, 'GET')).view.waiting[0].id;
  await call(nc, 'PUT', { name: 'Kari', comment: 'Usikker', answers: { [days[0]]: 1 }, waiting: true, draft: true }, `/people/${ncK}`);
  await vq.goto(`${BASE}/e/${nc.id}`);
  await vq.waitForSelector('.wait-names');
  const ncV = (await call(nc, 'GET', undefined, '', null)).view;
  check((await vq.locator('.wait-names .tap').count()) === 0 && !ncV.waiting[0].answers && !('comment' in ncV.waiting[0]), 'without claims: names aren’t tappable, and visitors get no drafts');
  await vq.click('.role [data-act="answer"]');
  await vq.waitForSelector('#answer-form');
  check((await vq.locator('.claim').count()) === 0, 'and the form has no «Er du en av disse?»');

  // Names stay (rename off).
  const rn = await mk('Faste navn', { rename: false });
  await call(rn, 'POST', { names: ['Kari', 'Per'] }, '/invite');
  const rnW = (await call(rn, 'GET')).view.waiting;
  const rnK = rnW.find((w) => w.name === 'Kari').id;
  const rnP = rnW.find((w) => w.name === 'Per').id;
  check((await call(rn, 'POST', { name: 'Karianne', comment: '', answers: {}, claim: rnP }, '/people', null)).error === 'rename', 'a claim under another name gets 403 rename');
  const rp = await page({ refused: true });
  await rp.goto(`${BASE}/e/${rn.id}`);
  await rp.locator('.wait-names .pn.tap', { hasText: 'Kari' }).click();
  await rp.waitForSelector('#answer-form');
  check((await rp.locator('#answer-form [name=name]').getAttribute('readonly')) !== null && (await rp.locator('[data-field="name"] .hint').textContent()) === 'Navnet kan ikke endres i denne avstemningen.', 'tapping Kari: the name can’t be changed');
  await rp.locator('.claim .chip', { hasText: 'Kari' }).click();
  check((await rp.locator('#answer-form [name=name]').getAttribute('readonly')) === null, 'unpicked, a new name can be typed');
  await rp.locator('.claim .chip', { hasText: 'Kari' }).click();
  await day(rp, D(1)).click();
  await rp.click('[data-act="save-answer"]');
  await rp.waitForURL(new RegExp(`/e/${rn.id}#${rnK}`));
  const rkTok = tokenOf(rp.url());
  check((await call(rn, 'PUT', { name: 'Kari N', comment: '', email: '', answers: {} }, `/people/${rnK}`, rkTok)).error === 'rename', 'Kari can’t rename herself (403 rename)');
  const same = await call(rn, 'PUT', { name: ' kari ', comment: 'Ok', email: '', answers: {} }, `/people/${rnK}`, rkTok);
  check(same.status === 200 && same.view.people.find((p) => p.id === rnK).name === 'Kari', 'the same name in other case and spaces is fine, and stays as listed');
  await rp.click('.role [data-act="answer"]');
  await rp.waitForSelector('#answer-form');
  check((await rp.locator('#answer-form [name=name]').getAttribute('readonly')) !== null, 'her own form shows the name read-only');
  check((await call(rn, 'PUT', { name: 'Kari Nordmann', comment: '', answers: {} }, `/people/${rnK}`)).status === 200, 'the admin still can');
  check((await call(rn, 'POST', { name: 'Ola', comment: '', answers: {} }, '/people', null)).status === 200, 'and new names still answer under their own name');

  // Picking the final date (decide on): anyone, and it stays open.
  const dc = await mk('Alle velger', { decide: true });
  await call(dc, 'POST', { name: 'Ola', comment: '', answers: { [days[1]]: 1 } }, '/people', null);
  const dp = await page({ refused: true });
  await dp.goto(`${BASE}/e/${dc.id}`);
  await dp.waitForSelector('.best-item');
  check((await dp.locator('.head .meta').textContent()).includes('Alle kan velge hva det blir'), 'the page says everyone can pick');
  await dp.locator('.best-item').first().click();
  await dp.click('.detail [data-act="decide"]');
  check((await dp.locator('#dlg p').first().textContent()).endsWith('Alle som åpner avstemningen ser valget.'), 'a participant’s pick doesn’t say it closes anything');
  await dp.click('#dlg button[value="yes"]');
  await dp.waitForSelector('.decided [data-act="undecide"]');
  const dv = (await call(dc, 'GET')).view;
  check(dv.event.decided === days[1] && !dv.event.settings.closed && (await dp.locator('.role [data-act="answer"]').count()) === 1, 'a visitor picks the date, and the poll stays open');
  check((await call(dc, 'POST', { decided: 'x' }, '/decide', null)).error === 'decided', 'something not an option gets 400 decided');
  check((await call(dc, 'POST', { decide: days[0] }, '/decide', null)).error === 'decided' && (await call(dc, 'GET')).view.event.decided === days[1], 'a body without «decided» too, and the pick stays');
  check((await call(dc, 'POST', { decided: null }, '/decide', null)).view.event.decided === undefined, 'and anyone can unpick it');
  check((await call(plain, 'POST', { decided: days[0] }, '/decide', null)).status === 403, 'without decide, a visitor can’t pick');
  await call(dc, 'PUT', { event: { ...dv.event, settings: { ...dv.event.settings, closed: true } } });
  check((await call(dc, 'POST', { decided: days[0] }, '/decide', null)).error === 'closed', 'and nobody but the admin once it is closed');

  // Changing the poll's name, place and description (details on).
  const dt = await mk('Hyttetur', { details: true });
  const tp = await page({ refused: true });
  await tp.goto(`${BASE}/e/${dt.id}`);
  await tp.click('.head [data-act="edit-details"]');
  await tp.waitForSelector('#dlg[open] #details-form');
  await tp.fill('#details-form [name=name]', 'Hyttetur i mars');
  await tp.fill('#details-form [name=location]', 'Hytta på Geilo');
  await tp.locator('#dlg').screenshot({ path: `${SHOTS}/72-edit-details.png` });
  await tp.click('#dlg button[value="save"]');
  await tp.waitForFunction(() => document.querySelector('.head h1')?.textContent === 'Hyttetur i mars');
  check((await tp.locator('.head .meta').textContent()).includes('Hytta på Geilo'), 'a visitor changes the name and place');
  await tp.locator('.head').screenshot({ path: `${SHOTS}/73-head-details.png` });
  const dt2 = (await call(dt, 'PUT', { name: 'X', description: '', location: '', settings: { closed: true }, options: [days[0]] }, '/details', null)).view;
  check(dt2.event.name === 'X' && !dt2.event.settings.closed && dt2.event.options.length === 3, 'and nothing else, whatever is sent');
  check((await call(dt, 'PUT', { name: ' ', description: '', location: '' }, '/details', null)).error === 'name', 'a poll needs a name');
  check((await call(plain, 'PUT', { name: 'Y', description: '', location: '' }, '/details', null)).status === 403, 'without details, a visitor can’t');
  await ad.goto(`${BASE}/e/${dt.id}#${dt.token}`);
  await ad.waitForSelector('.head h1');
  check((await ad.locator('.head [data-act="edit-details"]').count()) === 0, 'the admin changes it in the event form instead');
  errors.splice(0); // the 4xx above are on purpose
  await Promise.all([ad.close(), vp.close(), vq.close(), rp.close(), dp.close(), tp.close()]);
}

// --- R) Ties beyond the first three, and the footer -----------------------------------------
const tie = await page();
await tie.goto(`${BASE}/`);
const tieLink = await tie.evaluate(async (days) => {
  const j = (method, url, body, token) => fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
  const ev = await j('POST', '/api/events', { event: { name: 'Seks like dager', mode: 'dates', start: days[0], end: days[5], options: days }, email: '' });
  await j('POST', `/api/events/${ev.id}/people`, { name: 'Ola', answers: Object.fromEntries(days.map((d) => [d, 1])) });
  return `/e/${ev.id}#${ev.token}`;
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
          return `/e/${r.id}#${r.token}`;
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
  // Once per tab: a reload keeps what the page changed.
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
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
// Forgetting one on the home page: gone at once, with Undo in the message.
await many.keyboard.press('Escape');
const mineNames = () => many.locator('.mine .mine-name b').allTextContents();
await many.click('[data-act="forget"][data-id="abcdefghijk5"]');
check(!(await mineNames()).includes('Event 5'), 'forgetting takes the event off the list at once, with no question');
check((await many.locator('#toast').textContent()).startsWith('Removed “Event 5” from this device'), `and says so (${await many.locator('#toast').textContent()})`);
check((await many.evaluate(() => document.activeElement?.dataset.id)) === 'abcdefghijk4', 'the focus goes to the next row');
await many.screenshot({ path: `${SHOTS}/24-forget-undo.png` });
await many.click('#toast [data-act="unforget"]');
const back = await many.evaluate(() => JSON.parse(localStorage.getItem('whenever-v1')).events.abcdefghijk5);
check((await mineNames()).join() === 'Event 9,Event 8,Event 7,Event 6,Event 5,Event 4,Event 3,Event 2,Event 1' && back.admin === 'a'.repeat(38) && back.seen === 5, 'Undo puts it back as it was, in its place');
check(await many.locator('#toast').isHidden(), 'and the message goes');
await many.click('[data-act="forget"][data-id="abcdefghijk5"]');
await many.reload();
check(!(await mineNames()).includes('Event 5') && (await mineNames()).length === 8, 'without Undo it stays forgotten');
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
check((await toastText()).includes('Fant 1 avstemning'), 'the right code finds the event');
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
  check((await mp.locator('a').count()) === 1 && (await mp.locator('a').textContent()) === 'Vis avstemningene mine', 'with one button');
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

// --- W) Live updates: what others do shows up without a reload -------------------------------
{
  const days = [D(0), D(1), D(2)];
  const ip = devIp();
  const api = (path, method, body, token) =>
    fetch(`${BASE}/api/events${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-dev-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body && JSON.stringify(body),
    }).then((r) => r.json());
  const ev = { name: 'Live', mode: 'dates', start: days[0], end: days[2], options: days };
  const made = await api('', 'POST', { event: ev, emails: [] });
  const row = (p, name) => p.locator(`.plist li:has-text("${name}")`);
  const ad = await page();
  await ad.context().setExtraHTTPHeaders({ 'x-dev-ip': devIp() });
  await ad.goto(`${BASE}/e/${made.id}#${made.token}`);
  await ad.waitForSelector('html[data-live="open"]');
  await ad.evaluate(() => (window.__same = 1));
  const kari = await api(`/${made.id}/people`, 'POST', { name: 'Kari', comment: '', answers: { [days[0]]: 1, [days[1]]: 1 } });
  await row(ad, 'Kari').waitFor({ timeout: 5000 });
  check(await ad.evaluate(() => window.__same === 1), "someone's answers show up on the organiser's page by themselves, without a reload");
  check((await row(ad, 'Kari').getAttribute('class'))?.includes('fresh'), 'and the new row is marked for a moment');
  await ad.evaluate(() => window.scrollTo(0, 260));
  const y = await ad.evaluate(() => window.scrollY);
  await api(`/${made.id}/people`, 'POST', { name: 'Ola', comment: '', answers: { [days[1]]: 1 } });
  await row(ad, 'Ola').waitFor({ timeout: 5000 });
  check(y > 0 && (await ad.evaluate(() => window.scrollY)) === y, `and the page stays where it was scrolled to (${y})`);
  await ad.locator('.plist').screenshot({ path: `${SHOTS}/42-live-fresh.png` });
  // A menu open: the page waits, then catches up once it closes.
  await ad.click('[data-act="admin-more"]');
  await api(`/${made.id}/people`, 'POST', { name: 'Per', comment: '', answers: { [days[2]]: 2 } });
  await ad.waitForTimeout(1500);
  check((await row(ad, 'Per').count()) === 0, 'with a menu open, the page is not drawn again under it');
  await ad.keyboard.press('Escape');
  await row(ad, 'Per').waitFor({ timeout: 3000 });
  check(true, 'and catches up once it is closed');
  // In a form: the answers stay as typed; a change to the event itself is said once.
  const kp = await page();
  await kp.context().setExtraHTTPHeaders({ 'x-dev-ip': devIp() });
  await kp.goto(`${BASE}/e/${made.id}#${kari.token}&answer`);
  await kp.waitForSelector('html[data-live="open"]');
  await kp.waitForSelector('#pick-area');
  await api(`/${made.id}`, 'PUT', { event: { ...ev, name: 'Live 2' } }, made.token);
  await kp.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
  check((await kp.locator('#toast').textContent()).includes('endret nettopp'), 'someone answering is told once that the event just changed');
  check((await kp.locator('#pick-area').count()) === 1, 'and stays in the form');
  await kp.close();

  // Hidden answers: each socket gets its own view, checked again every time.
  const hid = await api('', 'POST', { event: { ...ev, name: 'Hemmelig', settings: { hidden: true } }, emails: [] });
  const hk = await api(`/${hid.id}/people`, 'POST', { name: 'Kari', comment: '', answers: { [days[0]]: 1 } });
  const sock = async (id, token) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/events/${id}/live`);
    const got = [];
    ws.onmessage = (e) => got.push(e.data);
    ws.closed = new Promise((r) => ws.addEventListener('close', (e) => r(e)));
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    ws.send(JSON.stringify({ token }));
    await waitFor(() => got.length > 0);
    return { ws, got, last: () => JSON.parse(got.at(-1)) };
  };
  const waitFor = async (ok, ms = 5000) => {
    for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
    return ok();
  };
  const sa = await sock(hid.id, hid.token);
  const sk = await sock(hid.id, hk.token);
  const sv = await sock(hid.id, null);
  check(sa.last().type === 'view' && sa.last().view.role === 'admin' && sk.last().view.role === 'participant' && sv.last().view.role === 'visitor', 'live: the first message says who, and the view comes back for that link');
  check(/^[A-Za-z0-9]+$/.test(sa.last().app), `with the live app version (${sa.last().app})`);
  check(sk.last().view.people.length === 1 && !('count' in sk.last().view) && sv.last().view.people.length === 0 && !sv.got.at(-1).includes('Kari'), 'in a hidden poll, a participant gets only their own answers (and no count), a visitor nobody’s');
  const n = [sa, sk, sv].map((s) => s.got.length);
  await api(`/${hid.id}/people`, 'POST', { name: 'Ola', comment: '', answers: { [days[1]]: 1 } });
  check(await waitFor(() => sa.got.length > n[0]), 'a change goes to the organiser’s socket');
  check(sa.last().view.people.length === 2 && sa.last().view.rev > 0 && sa.last().view.count === 2, 'with everyone, the count and a newer rev');
  await new Promise((r) => setTimeout(r, 400));
  check(sk.got.length === n[1] && sv.got.length === n[2], 'but nothing to those who can’t see it, so nobody counts the answers coming in');
  await api(`/${hid.id}/people/${hk.pid}`, 'PUT', { name: 'Kari', comment: 'Kanskje', answers: { [days[0]]: 1 } }, hk.token);
  check(await waitFor(() => sk.got.length > n[1]) && sk.last().view.people[0].comment === 'Kanskje' && sv.got.length === n[2], 'Kari’s own change goes to her socket, still not to the visitor’s');
  // The organiser makes a new link for Kari: her old one gets no more of her view.
  await api(`/${hid.id}/people/${hk.pid}/link`, 'POST', { reset: true }, hid.token);
  const m = sk.got.length;
  await api(`/${hid.id}/people`, 'POST', { name: 'Per', comment: '', answers: {} });
  check(await waitFor(() => sk.got.length > m), 'the old link still gets a message');
  check(sk.last().view.role === 'visitor' && sk.last().view.link === 'invalid' && sk.last().view.people.length === 0, 'but as a visitor with an invalid link');
  // Too often, too long, or not JSON: ignored, and the socket stays.
  sv.ws.send(JSON.stringify({ token: null }));
  sv.ws.send('x'.repeat(500));
  sv.ws.send('not json');
  sv.ws.send('ping');
  const pong = await waitFor(() => sv.got.at(-1) === 'pong');
  check(pong && sv.ws.readyState === WebSocket.OPEN, 'junk is ignored, and "ping" gets "pong"');
  await api(`/${hid.id}`, 'DELETE', undefined, hid.token);
  const closed = await Promise.all([sa, sk, sv].map((s) => s.ws.closed));
  check([sa, sk, sv].every((s) => s.got.at(-1) === '{"type":"gone"}') && closed.every((e) => e.code === 1000 && e.reason === 'gone'), 'deleting the poll tells every socket, and closes it');
  const late = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/events/${hid.id}/live`);
  check(await new Promise((r) => ((late.onopen = () => r(false)), (late.onerror = () => r(true)))), 'and a new socket to it is refused');

  // No live socket (blocked or failing): the 30 s refresh and tab focus still work.
  const fb = await page();
  await fb.context().setExtraHTTPHeaders({ 'x-dev-ip': devIp() });
  await fb.addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      static OPEN = 1;
      readyState = 0;
      constructor() {
        super();
        setTimeout(() => {
          this.readyState = 3;
          this.onerror?.(new Event('error'));
          this.onclose?.(new CloseEvent('close', { code: 1006 }));
        }, 20);
      }
      send() {}
      close() {}
    };
  });
  await fb.goto(`${BASE}/e/${made.id}#${made.token}`);
  await fb.waitForSelector('.plist');
  await fb.waitForTimeout(200);
  check((await fb.evaluate(() => document.documentElement.dataset.live)) === 'closed', 'without WebSockets the page still works');
  await api(`/${made.id}/people`, 'POST', { name: 'Siv', comment: '', answers: { [days[0]]: 2 } });
  await fb.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await row(fb, 'Siv').waitFor({ timeout: 5000 });
  check(true, 'and catches up when the tab is shown again');
  await fb.close();

  // A new version is live: a bar with a button to reload. The socket names
  // another version, and the page itself (/, never cached) confirms it.
  const olderSocket = (p) =>
    p.routeWebSocket(/\/live$/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((msg) => ws.send(typeof msg === 'string' ? msg.replace(/"app":"[^"]*"/, '"app":"OLDER"') : msg));
    });
  const asked = (p) => p.waitForResponse((r) => new URL(r.url()).pathname === '/' && r.request().resourceType() === 'fetch');
  // Right after a deploy the Poll object may still name the old version: the page says ours is current, so no bar.
  const fresh = await page();
  await fresh.context().setExtraHTTPHeaders({ 'x-dev-ip': devIp() });
  await olderSocket(fresh);
  const freshAsked = asked(fresh);
  await fresh.goto(`${BASE}/e/${made.id}#${made.token}`);
  await freshAsked;
  await fresh.waitForTimeout(300);
  check((await fresh.locator('#update').count()) === 0, 'a socket naming another version alone shows no bar, while the page itself serves ours');
  await fresh.close();
  const old = await page();
  await old.context().setExtraHTTPHeaders({ 'x-dev-ip': devIp() });
  await olderSocket(old);
  await old.route(
    (u) => new URL(u).pathname === '/',
    (r) => (r.request().resourceType() === 'fetch' ? r.fulfill({ contentType: 'text/html', body: '<script type="module" src="/app-NEWER123.js"></script>' }) : r.continue()),
  );
  await old.goto(`${BASE}/e/${made.id}#${made.token}`);
  const notice = old.locator('#update');
  await notice.waitFor({ timeout: 5000 });
  check((await notice.textContent()).includes('En ny versjon er klar.') && (await notice.locator('[data-act="reload"]').isVisible()), 'an app older than the live one says so, with a button to reload');
  await shot(old, '43-live-new-version', false);
  await old.evaluate(() => (window.__same = 1));
  await Promise.all([old.waitForEvent('load'), old.click('#update [data-act="reload"]')]);
  check(await old.evaluate(() => window.__same === undefined), 'and the button reloads the page');
  await old.close();

  // The poll is deleted elsewhere: the open page says so.
  await api(`/${made.id}`, 'DELETE', undefined, made.token);
  await ad.waitForSelector('h1:has-text("Fant ikke")', { timeout: 5000 });
  check((await ad.evaluate(() => document.documentElement.dataset.live)) === 'closed', 'a page on a poll deleted elsewhere shows "not found" and stops');
  await ad.close();
}

// --- Y) Guards: the last day, the size of a body, HSTS, live sockets an event -------------------
{
  const hdr = (token) => ({ 'content-type': 'application/json', 'x-dev-ip': devIp(), ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const send = (method, path, body, token) => fetch(`${BASE}/api/events${path}`, { method, headers: hdr(token), body: typeof body === 'string' ? body : JSON.stringify(body), ...(body instanceof ReadableStream ? { body, duplex: 'half' } : {}) });
  const ahead = (n) => iso(today + n * DAY);
  const ev = (start, end, name = 'Guards') => ({ event: { name, mode: 'dates', start, end, options: [start] } });
  let r = await send('POST', '', ev(ahead(740), ahead(741)));
  check(r.status === 400 && (await r.json()).error === 'tooFar', 'an event more than two years ahead is refused, so every event is deleted one day');
  r = await send('POST', '', ev('9998-01-01', '9998-01-02'));
  check(r.status === 400, 'and one in the year 9998');
  r = await send('POST', '', ev(ahead(700), ahead(701)));
  const far = await r.json();
  check(r.status === 200, 'one 700 days ahead is fine');
  await send('DELETE', `/${far.id}`, undefined, far.token);
  r = await send('POST', '', ev(D(0), D(6)));
  const made = await r.json();
  check(r.headers.get('strict-transport-security') === 'max-age=31536000', 'the API tells browsers to only come back over https');
  r = await send('PUT', `/${made.id}`, ev(ahead(800), ahead(801)), made.token);
  check(r.status === 400 && (await r.json()).error === 'tooFar', "the organiser can't move it more than two years ahead either");
  r = await send('PUT', `/${made.id}/details`, { name: 'Guards 2' }, made.token);
  check(r.status === 200 && (await r.json()).view.event.name === 'Guards 2', 'changing its name still works');
  r = await send('POST', '', JSON.stringify({ event: { name: 'x'.repeat(300 * 1024) } }));
  check(r.status === 413, 'a 300 KB body is refused');
  const pieces = new ReadableStream({
    start(c) {
      for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('y'.repeat(16 * 1024)));
      c.close();
    },
  });
  r = await send('POST', '', pieces);
  check(r.status === 413, 'and one that says nothing about its length');
  for (const path of ['/', `/e/${made.id}`, '/privacy', '/llms.txt']) {
    r = await fetch(`${BASE}${path}`, { headers: { 'x-dev-ip': devIp() }, redirect: 'manual' });
    check(r.status === 200 && r.headers.get('strict-transport-security') === 'max-age=31536000', `${path} comes with Strict-Transport-Security (and no redirect on this machine)`);
  }
  // 300 live sockets an event: the page's is the one heard from longest ago,
  // so the 300th other one takes its place, and the page connects again.
  const p = await page();
  await p.goto(`${BASE}/e/${made.id}`);
  await p.waitForSelector('html[data-live="open"]');
  await p.evaluate(() => {
    window.__live = [];
    new MutationObserver(() => window.__live.push(document.documentElement.dataset.live)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-live'] });
  });
  const socks = [];
  for (let i = 0; i < 300; i++) {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/events/${made.id}/live`, { headers: { 'x-dev-ip': devIp() } });
    socks.push(ws);
    await new Promise((yes, no) => {
      ws.addEventListener('open', yes, { once: true });
      ws.addEventListener('error', () => no(new Error(`live socket ${i} failed`)), { once: true });
    });
    ws.send(JSON.stringify({ token: null }));
  }
  await p.waitForFunction(() => window.__live.join() === 'closed,open', null, { timeout: 8000 }).catch(() => {});
  check((await p.evaluate(() => window.__live.join())) === 'closed,open', 'with 300 other live sockets the page lost its own, and connected again by itself');
  await send('PUT', `/${made.id}/details`, { name: 'Guards 3' }, made.token);
  await p.locator('h1:has-text("Guards 3")').waitFor({ timeout: 5000 }).catch(() => {});
  check((await p.locator('h1').textContent()).includes('Guards 3'), 'and it still hears about changes');
  // (Node's WebSocket waits for the server to end the connection, so the one
  // that made room for the page isn't counted as closed here.)
  check(socks.filter((s) => s.readyState === WebSocket.OPEN).length === 299, 'one of the others made room for it');
  for (const s of socks) s.close();
  await send('DELETE', `/${made.id}`, undefined, made.token);
  await p.context().close();
}

// --- Z) A narrow phone (320 px), finger-sized links, and when the event is deleted --------------
{
  const hdr = (token) => ({ 'content-type': 'application/json', 'x-dev-ip': devIp(), ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const days = [D(0), D(1), D(2), D(7)];
  const made = await (await fetch(`${BASE}/api/events`, { method: 'POST', headers: hdr(), body: JSON.stringify({ event: { name: 'Smal skjerm', mode: 'dates', start: days[0], end: days[3], options: days } }) })).json();
  await fetch(`${BASE}/api/events/${made.id}/people`, { method: 'POST', headers: hdr(), body: JSON.stringify({ name: 'Kari', answers: { [days[0]]: 1 } }) });
  // The server says when it goes: the day before, as its last whole day.
  const last = iso(Date.parse(days[3]) + 30 * DAY);
  check(iso(made.view.deletes - DAY) === last, `the view says when the event is deleted (${iso(made.view.deletes)})`);
  for (const theme of ['light', 'hacker']) {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, locale: 'nb-NO', timezoneId: 'Europe/Oslo', extraHTTPHeaders: { 'x-dev-ip': devIp() } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${BASE}/`);
    await p.evaluate((th) => localStorage.setItem('whenever-v1', JSON.stringify({ lang: 'nb', theme: th })), theme);
    const wide = [];
    for (const [name, path, act] of [
      ['the form', '/new', null],
      ['the form with times', '/new', (q) => q.check('[name=mode][value=times]')],
      ['the event page', `/e/${made.id}`, null],
      ['the answer form', `/e/${made.id}#answer`, null],
    ]) {
      await p.goto('about:blank');
      await p.goto(`${BASE}${path}`);
      await p.waitForSelector('main.page :is(h1, .card)');
      if (act) await act(p);
      if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) wide.push(name);
    }
    check(wide.length === 0, `at 320 px (${theme}) no page is wider than the screen${wide.length ? `: ${wide.join(', ')}` : ''}`);
    if (theme === 'light') {
      await p.goto('about:blank');
      await p.goto(`${BASE}/e/${made.id}#answer`);
      await p.waitForSelector('.back');
      const h = await p.evaluate(() => Math.min(...[...document.querySelectorAll('main .linkish, main .back')].filter((e) => e.checkVisibility()).map((e) => e.getBoundingClientRect().height)));
      check(h >= 36, `text links are a finger high on a touch screen (${Math.round(h)} px)`);
      await p.goto(`${BASE}/e/${made.id}`);
      await p.waitForSelector('.results');
      check((await p.locator('main').textContent()).includes(`slettes automatisk`), 'the event page says when it is deleted');
      check((await p.locator('.cal-month h3').count()) > 0 && (await p.locator('.cal-month h4').count()) === 0, 'month names are headings right under the card\'s');
    }
    await ctx.close();
  }
  await fetch(`${BASE}/api/events/${made.id}`, { method: 'DELETE', headers: hdr(made.token) });
}

// --- J) Time zones: times shown and answered in the viewer's own zone -------------------------
{
  const hdr = (token) => ({ 'content-type': 'application/json', 'x-dev-ip': devIp(), ...(token ? { authorization: `Bearer ${token}` } : {}) });
  // Oslo: an afternoon that is the next morning in Tokyo, and 10:00.
  const opts = [D(1, '15:00'), D(1, '16:00'), D(1, '17:00'), D(2, '10:00')];
  const event = { name: 'Tidssoner', mode: 'times', start: D(1), end: D(2), options: opts, slot: 60, dayStart: 480, dayEnd: 1320, duration: 60, tz: 'Europe/Oslo' };
  const made = await (await fetch(`${BASE}/api/events`, { method: 'POST', headers: hdr(), body: JSON.stringify({ event }) })).json();
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const ctxFor = (tz) => browser.newContext({ viewport: { width: 900, height: 900 }, locale: 'en-GB', timezoneId: tz, extraHTTPHeaders: { 'x-dev-ip': devIp() } });

  const ctx = await ctxFor('Asia/Tokyo');
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.evaluate(() => localStorage.setItem('whenever-v1', JSON.stringify({ lang: 'en' })));
  await p.goto(`${BASE}/e/${made.id}#answer`);
  await p.waitForSelector('#pick-area .tg-cell');
  check((await p.locator('.zone-line').textContent()).includes('your time zone (Asia/Tokyo)'), 'the answer form says the times are in your zone');
  // The 16:00 Oslo slot, where Tokyo has it: its column's date and its row's time.
  const want = moveClock(D(1), 960, 'Europe/Oslo', 'Asia/Tokyo');
  const at = await p.evaluate((k) => {
    const cell = document.querySelector(`#pick-area .tg-cell[data-k="${k}"]`);
    if (!cell) return null;
    const grid = cell.closest('.tg');
    const days = [...grid.querySelectorAll('.tg-day')].map((d) => d.querySelector('[data-day]')?.dataset.day ?? d.textContent);
    const times = [...grid.querySelectorAll('.tg-time')].map((t) => t.textContent);
    return { day: days[Number(cell.dataset.c)], time: times[Number(cell.dataset.r)] };
  }, D(1, '16:00'));
  check(at?.day === want.date && at?.time === hm(want.min), `the Oslo 16:00 slot is drawn at Tokyo's ${want.date} ${hm(want.min)} (${JSON.stringify(at)})`);
  await shot(p, 'zone-answer-tokyo');
  await p.fill('#answer-form [name="name"]', 'Taro');
  await p.click(`#pick-area .tg-cell[data-k="${D(1, '16:00')}"]`);
  // Switching zones in the form keeps what is painted, and the name.
  await p.click('.zone-line [data-act="zone"]');
  await p.waitForSelector('.zone-line [data-act="zone"][data-zone="mine"]');
  const kept = await p.locator(`#pick-area .tg-cell[data-k="${D(1, '16:00')}"]`).evaluate((c) => c.classList.contains('v1'));
  check(kept && (await p.inputValue('#answer-form [name="name"]')) === 'Taro', 'switching the time zone in the answer form keeps the unsaved answers');
  await p.click('.zone-line [data-act="zone"]');
  await p.waitForSelector('.zone-line [data-act="zone"][data-zone="event"]');
  await p.click('[data-act="save-answer"]');
  await p.waitForSelector('.results');
  const view = (await (await fetch(`${BASE}/api/events/${made.id}`, { headers: hdr() })).json()).view;
  check(JSON.stringify(view.people[0]?.answers) === JSON.stringify({ [D(1, '16:00')]: 1 }), `the answer is stored under the event's own key (${JSON.stringify(view.people[0]?.answers)})`);
  const best = await p.locator('.best-item').first().textContent();
  check(best.includes(`${hm(want.min)}–${hm(want.min + 60)}`), `the best list shows Tokyo's time (${best.trim().replace(/\s+/g, ' ')})`);
  await shot(p, 'zone-event-tokyo');
  await p.click('[data-act="zone"]');
  await p.waitForSelector('[data-act="zone"][data-zone="mine"]');
  check((await p.locator('.best-item').first().textContent()).includes('16:00–17:00'), 'shown in the event\'s zone, the best list says 16:00–17:00');
  await p.reload();
  await p.waitForSelector('.results');
  check((await p.locator('[data-act="zone"]').getAttribute('data-zone')) === 'mine', 'the choice is remembered on this device');
  await p.click('[data-act="zone"]');
  await ctx.close();

  // Kolkata is off the hour: rows on the half hour, labelled.
  const ctx2 = await ctxFor('Asia/Kolkata');
  const q = await ctx2.newPage();
  q.on('pageerror', (e) => errors.push(e.message));
  await q.goto(`${BASE}/`);
  await q.evaluate(() => localStorage.setItem('whenever-v1', JSON.stringify({ lang: 'en' })));
  await q.goto(`${BASE}/e/${made.id}`);
  await q.waitForSelector('#res-grid .tg-time');
  const labels = (await q.locator('#res-grid .tg-time').allTextContents()).filter(Boolean);
  check(labels.length > 0 && labels.every((l) => l.endsWith(':30')), `in Kolkata the rows are labelled on the half hour (${labels.join(' ')})`);
  await ctx2.close();

  // Stockholm reads the same as Oslo: nothing to switch.
  const ctx3 = await ctxFor('Europe/Stockholm');
  const s = await ctx3.newPage();
  await s.goto(`${BASE}/e/${made.id}`);
  await s.waitForSelector('.results');
  check((await s.locator('[data-act="zone"]').count()) === 0, 'Stockholm gets no time zone switch');
  await ctx3.close();
  await fetch(`${BASE}/api/events/${made.id}`, { method: 'DELETE', headers: hdr(made.token) });
}

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
const firstMonth = (await lg.locator('#f-cal .cal-month h3').first().textContent()).split(' ')[0];
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

// --- P) Link previews: the tags Messenger, Signal and the like read ----------------------------
// They fetch the HTML without running the app; the Worker fills the tags in.
// The tags are read back with the browser's HTML parser. wrangler dev makes
// every host the first route's (nb), so en is left to the unit tests.
{
  const name = 'Quiz & «julebord» <2026> "&amp;"';
  const res = await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: { name, description: 'Middag og quiz.\n\nSvar innen fredag!', mode: 'dates', start: D(2), end: D(3), options: [D(2), D(3)] }, email: '' }),
  });
  const ev = await res.json();
  const p = await page();
  const read = async (path, ua = 'facebookexternalhit/1.1') => {
    const r = await fetch(`${BASE}${path}`, { headers: { 'user-agent': ua } });
    const html = await r.text();
    const tags = await p.evaluate((h) => {
      const d = new DOMParser().parseFromString(h, 'text/html');
      const get = (s) => d.querySelector(s)?.getAttribute('content') ?? null;
      return {
        lang: d.documentElement.lang,
        title: d.title,
        ogTitle: get('meta[property="og:title"]'),
        desc: get('meta[property="og:description"]'),
        image: get('meta[property="og:image"]'),
        width: get('meta[property="og:image:width"]'),
        url: get('meta[property="og:url"]'),
        agentsTitle: d.querySelector('#for-agents h1')?.textContent ?? null,
        agents: d.querySelector('#for-agents')?.textContent ?? '',
        noscript: d.querySelector('noscript')?.textContent ?? '',
      };
    }, html);
    return { r, html, ...tags };
  };
  const pub = await read(`/e/${ev.id}`);
  check(pub.ogTitle === name, `an event link previews with the event's name (${pub.ogTitle})`);
  check(pub.title === `${name} · Finn tid`, 'and has it as the page title');
  check(pub.desc === 'Kryss av for dagene som passer for deg. Middag og quiz. Svar innen fredag!', `then what to do, and the description (${pub.desc})`);
  check(pub.image === 'https://finn-tid.apphub.casa/og-nb.png' && pub.width === '1200', 'and the card image, absolute and https');
  check(pub.url === null, 'with no og:url');
  // An admin link's token is after the #, so a preview never gets it; a link
  // from before has it in the path.
  const adm = await read(`/e/${ev.id}/${ev.token}`, 'WhatsApp/2');
  check(adm.ogTitle === name && !adm.html.includes(ev.token), 'an admin link from before (token in the path) previews the same, and the token is nowhere in the page');
  check(adm.r.headers.get('referrer-policy') === 'no-referrer' && (adm.r.headers.get('content-security-policy') ?? '').includes("script-src 'self'"), 'the pages keep their security headers');
  check(adm.r.headers.get('etag') === null && adm.r.headers.get('cache-control') === 'no-cache', 'and are never answered from an old copy');
  const gone = await read('/e/AAAAAAAAAAAA', 'Mozilla/5.0');
  check(gone.r.status === 200 && gone.ogTitle === 'Finn tid' && gone.desc.startsWith('Finn dagen eller tiden'), "an unknown event gives the app's own preview");
  const home = await read('/');
  check(home.ogTitle === 'Finn tid' && home.lang === 'nb' && home.image === pub.image, 'so does the home page');
  // What AI assistants and people without JavaScript get instead of the app.
  check(pub.agentsTitle === name && pub.agents.includes(`https://finn-tid.apphub.casa/api/events/${ev.id}`) && pub.agents.includes('https://finn-tid.apphub.casa/llms.txt'), 'the page tells AI assistants where the poll is as JSON, and the guide');
  check(adm.agents.includes(`/api/events/${ev.id}`), 'so does an admin link (without its token, as above)');
  check(pub.noscript === `${name}Finn tid trenger JavaScript for å vise avstemningen.`, `people without JavaScript get its name (${pub.noscript})`);
  check(home.agents.includes('/llms.txt') && !home.agents.includes('/api/events/') && home.noscript === 'Finn tid trenger JavaScript.', 'the home page points to the guide');
  const guide = await fetch(`${BASE}/llms.txt`);
  const guideText = await guide.text();
  check(guide.ok && guide.headers.get('content-type') === 'text/plain; charset=utf-8' && guideText.includes('Authorization: Bearer <token>'), 'the API guide is served as text');
  // What llms.txt tells an assistant to do: answer, give the person the
  // token, and change the entry by sending it back whole, email included.
  const api = (path, method, body, token) =>
    fetch(`${BASE}/api/events/${ev.id}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body && JSON.stringify(body),
    }).then((r) => r.json());
  const added = await api('/people', 'POST', { name: 'Kari', comment: '', email: 'kari@example.com', answers: { [D(2)]: 1 } });
  const mine = (await api('', 'GET', undefined, added.token)).view;
  const entry = mine.people.find((x) => x.id === mine.me);
  check(mine.role === 'participant' && mine.me === added.pid && entry?.email === 'kari@example.com', 'as llms.txt says: the new token is a personal link, and its view has the email');
  const changed = (await api(`/people/${mine.me}`, 'PUT', { name: entry.name, comment: entry.comment, email: entry.email, answers: { [D(2)]: 1, [D(3)]: 2 } }, added.token)).view;
  const after = changed.people.find((x) => x.id === mine.me);
  check(after.email === 'kari@example.com' && after.answers[D(3)] === 2, 'and sending the entry back whole changes the answers and keeps the email');
  const nojs = await (await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  await nojs.goto(`${BASE}/e/${ev.id}`);
  const line = nojs.locator('noscript p.page');
  check((await line.isVisible()) && (await line.textContent()).endsWith('trenger JavaScript for å vise avstemningen.') && (await nojs.locator('#for-agents').count()) === 1 && !(await nojs.locator('#for-agents').isVisible()), 'without JavaScript: the name and one line, and the text for AI assistants stays hidden');
  await shot(nojs, '41-no-javascript', false);
  await nojs.close();
  const img = await fetch(`${BASE}/og-nb.png`);
  check(img.ok && img.headers.get('content-type') === 'image/png' && (await img.arrayBuffer()).byteLength < 300_000, 'the card image is a small PNG');
  // The site's icon as pictures, for those that can't use the SVG; they look
  // at the root without reading the page, so these must not be the app.
  const files = await Promise.all(['/favicon.ico', '/apple-touch-icon.png', '/robots.txt'].map((f) => fetch(`${BASE}${f}`)));
  const types = files.map((r) => (r.ok ? r.headers.get('content-type') : String(r.status)));
  check(types[0] === 'image/vnd.microsoft.icon' && types[1] === 'image/png' && types[2].startsWith('text/plain'), `the icon is at /favicon.ico and /apple-touch-icon.png, and robots.txt is text (${types.join(', ')})`);
  const icons = await p.evaluate((h) => [...new DOMParser().parseFromString(h, 'text/html').querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map((l) => l.getAttribute('href')), pub.html);
  check(['/favicon.ico', '/icons/icon.svg', '/apple-touch-icon.png'].every((h) => icons.includes(h)), 'and the page links all three icons');
  await p.goto(`${BASE}/e/${ev.id}`);
  await p.waitForSelector('.role');
  check((await p.title()) === `${name} · Finn tid`, 'and the app still starts on the page');
  check((await p.locator('#for-agents').count()) === 0, 'and replaces the text for AI assistants');
  await p.close();
}

// --- F) Firefox, where it differs: only with PWFIREFOX (a Playwright Firefox build) ---------
if (process.env.PWFIREFOX) {
  const ff = await firefox.launch({ executablePath: process.env.PWFIREFOX });
  const p = await (await ff.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'nb-NO' })).newPage();
  await p.goto(legendUrl);
  await p.waitForSelector('.legend .sw.top');
  check((await legendOverlaps(p)).length === 0, `Firefox: nothing in the legend overlaps (${await legendOverlaps(p)})`);
  await p.locator('.legend').scrollIntoViewIfNeeded();
  await p.locator('.results').screenshot({ path: `${SHOTS}/40-firefox-legend.png` });
  await ff.close();
} else {
  console.log('skip Firefox checks (set PWFIREFOX)');
}

check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
