// Whenever / Finn tid: the UI. Plain ES modules, no framework. Each view is an
// HTML string painted into #app; clicks are delegated through data-act.
//
// Routes (path): /  ·  /new  ·  /e/<id>  ·  /e/<id>/<token>
// Sub-views of an event (hash): #answer, #answer=<pid>, #edit

import * as M from '../shared/model.ts';
import { t, tx, holidayNames, getLang, setLang, isLang, LANGS, LANG_NAMES, fmtDate, fmtRange, monthName, slotLabel, windowLabel, weekdayShort, weekdayLong, durationLabel, cap } from './i18n.ts';
import type { Key, Lang } from './i18n.ts';
import { api, ApiError } from './api.ts';
import * as store from './store.ts';
import type { Stored } from './store.ts';
import { $, $opt, $$, esc, icon, toast, ask, menu, dialog, copyText, shareUrl, qrSvg } from './ui.ts';
import type { MenuItem } from './ui.ts';
import { calendarHtml, bindPaint } from './calendar.ts';
import { THEMES, isTheme, applyTheme } from './theme.ts';
import { TimeGrid, weekPages } from './timegrid.ts';
import { icsFor, icsName } from './ics.ts';

type Route = { page: 'home' } | { page: 'new' } | { page: 'find' } | { page: 'missing' } | { page: 'event'; id: string; token: string | null };
type Sub = { kind: 'overview' } | { kind: 'edit' } | { kind: 'answer'; pid: string | null };
type Tab = 'cal' | 'list' | 'table' | 'grid';
type Flash = { kind: 'created' } | { kind: 'savedNew'; name: string };

// The event form's state while it is open.
interface Draft extends M.DayWindow {
  name: string;
  description: string;
  location: string;
  mode: M.Mode;
  duration: number;
  tz: string;
  settings: M.Settings;
  holidays: M.HolidayCalendar; // which holidays the calendar marks
  email: string;
  dates: Set<string>;
  times: Set<string>;
  pattern: Set<number> | null; // times a newly added day gets (null = all)
  until: string; // the calendar shows months up to this day
  decided: string | null; // kept when the event is edited, if it still fits
  dirty: boolean; // changed since it was opened or saved
}

// The answer editor's state while it is open.
interface AnswerDraft {
  pid: string | null;
  own: boolean;
  name: string;
  comment: string;
  email: string;
  answers: M.Answers;
  brush: M.Answer;
  view: 'cal' | 'list';
  dirty: boolean;
}

const app: {
  route: Route | null;
  where: string | null;
  view: M.View | null;
  viewKey: string | null;
  viewJson: string | null;
  flash: Flash | null;
  pick: { k: string; win?: boolean } | null;
  tab: Tab | null;
  gridPage: number;
  draft: Draft | null;
  answer: AnswerDraft | null;
  formGrid: TimeGrid | null;
  resGrid: TimeGrid | null;
  refreshResGrid: (() => void) | null;
  pushedSub: boolean;
  renders: number;
  busy: boolean;
  // An unsaved form left with the browser's back button, given back when
  // its page is opened again.
  kept: { where: string; draft: Draft | null; answer: AnswerDraft | null } | null;
} = {
  route: null,
  where: null,
  view: null,
  viewKey: null,
  viewJson: null,
  flash: null, // one-off notice after creating an event or a first answer
  pick: null, // selected result: { k, win }
  tab: null, // results tab
  gridPage: 0,
  draft: null, // event form
  answer: null, // answer editor
  formGrid: null,
  resGrid: null,
  refreshResGrid: null,
  pushedSub: false,
  renders: 0,
  busy: false,
  kept: null,
};

// The current event page, view, form and answer. Code that uses them only
// runs while they exist.
function here(): { id: string; token: string | null } {
  const r = app.route;
  if (r?.page !== 'event') throw new Error('not on an event page');
  return r;
}
function current(): M.View {
  if (!app.view) throw new Error('no event loaded');
  return app.view;
}
function draft(): Draft {
  if (!app.draft) throw new Error('no event form');
  return app.draft;
}
function answer(): AnswerDraft {
  if (!app.answer) throw new Error('no answer editor');
  return app.answer;
}

// An open event form or answer editor with changes that aren't saved.
function unsaved(): boolean {
  return Boolean(app.draft?.dirty || app.answer?.dirty);
}

// Before leaving a page with unsaved changes. True = go ahead (and drop them).
async function leaveOk(): Promise<boolean> {
  if (!unsaved()) return true;
  if (!(await ask(t('discardQ'), { ok: t('discard'), danger: true }))) return false;
  app.draft = null;
  app.answer = null;
  app.kept = null;
  return true;
}

// el.dataset[k], '' if missing.
const data = (el: HTMLElement, k: string): string => el.dataset[k] ?? '';
// A form control by name (form.elements.namedItem).
const control = <T = HTMLInputElement>(form: HTMLFormElement, name: string): T => form.elements.namedItem(name) as T;

// A finger is the main pointer (phones, tablets): painting starts with a hold.
const touch = () => matchMedia('(pointer: coarse)').matches;

const eventUrl = (id: string) => `${location.origin}/e/${id}`;
const linkUrl = (id: string, token: string | null) => `${location.origin}/e/${id}/${token}`;

// A new event's holiday calendar: where the browser's clock is, else its
// languages, else none (a foreign calendar would be worse than none).
function guessHolidays(): M.HolidayCalendar {
  const byZone: Record<string, M.HolidayCalendar> = { 'Europe/Oslo': 'no', 'Arctic/Longyearbyen': 'no', 'Europe/Stockholm': 'se', 'Europe/Copenhagen': 'dk' };
  const zone = byZone[browserTz()];
  if (zone) return zone;
  for (const l of navigator.languages ?? [navigator.language]) {
    if (/^(nb|nn|no)\b/i.test(l)) return 'no';
    if (/^sv\b/i.test(l)) return 'se';
    if (/^da\b/i.test(l)) return 'dk';
  }
  return 'none';
}

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Oslo';
  } catch {
    return 'Europe/Oslo';
  }
}

function errText(e: unknown): string {
  const k = `err.${e instanceof ApiError ? e.code : 'server'}`;
  const s = tx(k);
  return s === k ? t('err.server') : s;
}

// --- Routing ------------------------------------------------------------------------

const ROUTE_RE = new RegExp(`^/e/([A-Za-z0-9]{12})(?:/(${M.TOKEN}))?$`);
const ANSWER_RE = new RegExp(`^answer=(${M.PID})$`);

function parseRoute(): Route {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return { page: 'home' };
  if (p === '/new') return { page: 'new' };
  if (p === '/find') return { page: 'find' };
  const m = p.match(ROUTE_RE);
  if (m) return { page: 'event', id: m[1], token: m[2] ?? null };
  return { page: 'missing' };
}

function subView(): Sub {
  const h = location.hash.slice(1);
  if (h === 'edit') return { kind: 'edit' };
  if (h === 'answer') return { kind: 'answer', pid: null };
  const m = h.match(ANSWER_RE);
  if (m) return { kind: 'answer', pid: m[1] };
  return { kind: 'overview' };
}

function go(url: string, replace = false): void {
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  app.pushedSub = false;
  render();
}

function openSub(hash: string): void {
  history.pushState(null, '', `${location.pathname}#${hash}`);
  app.pushedSub = true;
  render();
}

function closeSub(): void {
  if (app.pushedSub) {
    app.pushedSub = false;
    history.back();
  } else {
    history.replaceState(null, '', location.pathname);
    render();
  }
}

// --- Shell ----------------------------------------------------------------------------

// The header's menus (your events, theme, language) are popovers (see the
// handlers near the end). Browsers from before 2024 (Safari 16, Firefox 124) have
// none: there the buttons open the dialog menu instead. Never put data-act
// on a popover's button: the click delegation's preventDefault() would
// stop it opening.
const canPopover = 'popover' in HTMLElement.prototype;

// An item is a button (attrs: data-act and its data) or an in-app link
// (href). The current one is ticked and gets the focus, else the first.
interface DropItem {
  attrs?: string;
  href?: string;
  label: string;
  hint?: string;
  on: boolean;
}
const dropItems = (items: DropItem[]) => {
  const focus = Math.max(0, items.findIndex((i) => i.on));
  return items
    .map((i, n) => {
      const inner = `<span>${i.on ? icon('check') : ''}${esc(i.label)}</span>${i.hint ? `<small>${esc(i.hint)}</small>` : ''}`;
      const attrs = `class="menu-item${i.on ? ' on' : ''}"${i.on ? ' aria-current="true"' : ''}${n === focus ? ' autofocus' : ''}`;
      return i.href ? `<a ${attrs} href="${esc(i.href)}" data-link>${inner}</a>` : `<button type="button" ${attrs} ${i.attrs ?? ''}>${inner}</button>`;
    })
    .join('');
};

// The button that opens a header menu: a popover, or the dialog without.
const menuButton = (cls: string, menuId: string, fallbackAct: string, label: string, title: string, face: string) =>
  `<button type="button" class="btn ghost small menu-btn ${cls}" ${canPopover ? `popovertarget="${menuId}"` : `data-act="${fallbackAct}"`} aria-label="${esc(label)}" title="${esc(title)}">${face}<span class="chev" aria-hidden="true">▾</span></button>`;

const themeItems = () => {
  const cur = store.getTheme();
  return dropItems(THEMES.map((x) => ({ attrs: `data-act="theme-set" data-theme="${x}"`, label: t(`theme.${x}`), hint: x === 'auto' ? t('theme.autoHint') : undefined, on: x === cur })));
};
const themeLabel = () => `${t('theme')}: ${t(`theme.${store.getTheme()}`)}`;

// Your events on this device, to jump between them: the most recently
// opened first, each by its admin link, else your personal link.
const EVENTS_SHOWN = 8;
function eventItems(): DropItem[] {
  const cur = app.route?.page === 'event' ? app.route.id : null;
  const all = store.events();
  const items: DropItem[] = all.slice(0, EVENTS_SHOWN).map((e) => ({
    href: `/e/${e.id}${e.admin ? `/${e.admin}` : e.me ? `/${e.me}` : ''}`,
    label: e.name || '–',
    hint: [e.admin ? t('tagAdmin') : '', e.me ? t('tagAnswered') : ''].filter(Boolean).join(' · ') || undefined,
    on: e.id === cur,
  }));
  if (all.length > EVENTS_SHOWN) items.push({ href: '/', label: t('showAllEvents', { n: all.length }), on: false });
  return items;
}

async function pickEvent(): Promise<void> {
  const items = eventItems();
  const href = await menu(
    t('yourEvents'),
    items.map((i) => ({ id: i.href ?? '', label: i.label, hint: i.hint, on: i.on })),
  );
  if (href && (await leaveOk())) go(href);
}

function paint(inner: string): void {
  const cur = getLang();
  const events = eventItems();
  $('#app').innerHTML = `
    <header class="bar">
      <a class="brand" href="/" data-link><img src="/icons/icon.svg" alt="" width="28" height="28"><span>${esc(t('appName'))}</span></a>
      <span class="grow"></span>
      ${events.length ? menuButton('events-btn', 'events-menu', 'events-pick', t('yourEvents'), t('yourEvents'), icon('cal')) : ''}
      ${menuButton('theme-btn', 'theme-menu', 'theme', themeLabel(), t('theme'), icon('theme'))}
      ${menuButton('lang-btn', 'lang-menu', 'lang-pick', `${t('language')}: ${LANG_NAMES[cur]}`, t('language'), cur.toUpperCase())}
      ${
        canPopover
          ? `${events.length ? `<div id="events-menu" class="dropdown" popover>${dropItems(events)}</div>` : ''}
      <div id="theme-menu" class="dropdown" popover>${themeItems()}</div>
      <div id="lang-menu" class="dropdown" popover>${dropItems(LANGS.map((l) => ({ attrs: `data-act="lang" data-lang="${l}" lang="${l}"`, label: LANG_NAMES[l], on: l === cur })))}</div>`
          : ''
      }
    </header>
    <main class="page">${inner}</main>
    <footer class="foot"><a href="/privacy">${esc(t('privacy'))}</a><span aria-hidden="true">·</span><a href="https://apphub.casa">apphub.casa</a></footer>`;
}

const field = (name: string, label: string, control: string, hint = '') =>
  `<label class="field" data-field="${name}"><span class="label">${esc(label)}</span>${control}${hint ? `<small class="hint">${esc(hint)}</small>` : ''}</label>`;

const linkBox = (url: string, { share = false, qr = false, label = t('link'), title = '', primary = false } = {}) => `
  <div class="linkbox">
    <input readonly value="${esc(url)}" aria-label="${esc(label)}" data-select>
    <button type="button" class="btn small" data-act="copy" data-url="${esc(url)}">${icon('copy')}${esc(t('copy'))}</button>
    ${share ? `<button type="button" class="btn small${primary ? ' primary' : ''}" data-act="share" data-url="${esc(url)}" data-title="${esc(title)}">${icon('share')}${esc(t('share'))}</button>` : ''}
    ${qr ? `<button type="button" class="btn small" data-act="qr" data-url="${esc(url)}" aria-label="${esc(t('qrTitle'))}">${icon('qr')}</button>` : ''}
  </div>`;

function setBusy(on: boolean): void {
  app.busy = on;
  for (const b of $$<HTMLButtonElement>('button[type="submit"], [data-act="save-answer"]')) b.disabled = on;
}

// --- Render ----------------------------------------------------------------------------

async function render(): Promise<void> {
  const n = ++app.renders;
  const r = parseRoute();
  const s = subView();
  app.route = r;
  document.documentElement.lang = getLang();
  const where = [r.page, r.page === 'event' ? r.id : '', r.page === 'event' ? r.token : '', s.kind, s.kind === 'answer' ? s.pid : ''].join('|');
  if (where !== app.where) {
    if (app.where && unsaved()) app.kept = { where: app.where, draft: app.draft, answer: app.answer };
    app.where = where;
    app.draft = null;
    app.answer = null;
    if (app.kept?.where === where) {
      ({ draft: app.draft, answer: app.answer } = app.kept);
      app.kept = null;
    }
    app.pick = null;
    window.scrollTo(0, 0);
  }
  app.formGrid = null;
  app.resGrid = null;
  app.refreshResGrid = null;

  if (r.page === 'home') return renderHome();
  if (r.page === 'new') return renderForm(null);
  if (r.page === 'find') return renderFind();
  if (r.page === 'missing') return renderMissing();

  const key = `${r.id}/${r.token ?? ''}`;
  if (app.viewKey !== key || !app.view) {
    paint(`<p class="loading">${esc(t('loading'))}</p>`);
    try {
      const { view } = await api<{ view: M.View }>('GET', `/events/${r.id}`, { token: r.token });
      if (n !== app.renders) return;
      setView(view, r.id, r.token);
    } catch (e) {
      if (n !== app.renders) return;
      return renderLoadError(e);
    }
  }
  const v = current();
  if (s.kind === 'edit') {
    if (v.role !== 'admin') return closeSub();
    return renderForm(v);
  }
  if (s.kind === 'answer') return renderAnswer(v, s.pid);
  return renderOverview(v);
}

function setView(view: M.View, id = here().id, token = here().token): void {
  app.view = view;
  app.viewKey = `${id}/${token ?? ''}`;
  app.viewJson = JSON.stringify(view);
  if (token && view.link === 'ok') {
    if (view.role === 'admin') store.put(id, { name: view.event.name, admin: token });
    else if (view.role === 'participant') store.put(id, { name: view.event.name, me: token, pid: view.me ?? undefined });
  } else if (token && view.link === 'invalid') {
    store.dropToken(id, token);
  } else if (store.get(id)) {
    store.put(id, { name: view.event.name });
  }
}

function renderMissing(): void {
  document.title = t('appName');
  paint(`<section class="card notice"><h1>${esc(t('pageNotFound'))}</h1><p><a class="btn" href="/" data-link>${esc(t('toHome'))}</a></p></section>`);
}

function renderLoadError(e: unknown): void {
  document.title = t('appName');
  if (e instanceof ApiError && e.status === 404) {
    const { id } = here();
    if (store.get(id)) store.forget(id);
    return paint(`<section class="card notice warn"><h1>${esc(t('eventNotFound'))}</h1><p>${esc(t('eventNotFoundText'))}</p><p><a class="btn" href="/" data-link>${esc(t('toHome'))}</a></p></section>`);
  }
  paint(`<section class="card notice warn"><p>${esc(errText(e))}</p><p><button type="button" class="btn" data-act="retry">${esc(t('retry'))}</button></p></section>`);
}

// --- Home ---------------------------------------------------------------------------------

function renderHome(): void {
  document.title = `${t('appName')} · ${t('tagline')}`;
  const mine = store.events();
  const row = (e: Stored & { id: string }) => {
    const links = [];
    if (e.admin) links.push(`<a class="btn small" href="/e/${e.id}/${e.admin}" data-link>${esc(t('openAdmin'))}</a>`);
    if (e.me) links.push(`<a class="btn small" href="/e/${e.id}/${e.me}" data-link>${esc(t('openMine'))}</a>`);
    if (!links.length) links.push(`<a class="btn small" href="/e/${e.id}" data-link>${esc(t('open'))}</a>`);
    return `<li>
      <div class="mine-name"><b>${esc(e.name || '–')}</b>
        <span class="tags">${e.admin ? `<span class="tag">${esc(t('tagAdmin'))}</span>` : ''}${e.me ? `<span class="tag">${esc(t('tagAnswered'))}</span>` : ''}</span></div>
      <div class="row">${links.join('')}<button type="button" class="icon-btn" data-act="forget" data-id="${e.id}" aria-label="${esc(t('forget'))}" title="${esc(t('forget'))}">${icon('x')}</button></div>
    </li>`;
  };
  paint(`
    <section class="hero">
      <h1>${esc(t('heroTitle'))}</h1>
      <p class="lead">${esc(t('heroLead'))}</p>
      <a class="btn primary big" href="/new" data-link>${icon('plus')}${esc(t('newEvent'))}</a>
      ${mine.length ? '' : `<p class="small find-link"><a href="/find" data-link>${esc(t('findLink'))}</a></p>`}
    </section>
    ${mine.length ? `<section class="card"><h2>${esc(t('yourEvents'))}</h2><ul class="mine">${mine.map(row).join('')}</ul><p class="muted small">${esc(t('yourEventsHint'))} <a href="/find" data-link>${esc(t('findLink'))}</a></p></section>` : ''}
    <section class="steps">
      ${([1, 2, 3] as const).map((i) => `<div class="step"><span class="num">${i}</span><div><b>${esc(t(`step${i}`))}</b><p>${esc(t(`step${i}Text`))}</p></div></div>`).join('')}
    </section>`);
}

// --- Find your events by email ----------------------------------------------------------
// An address entered on events gets a code by email (see src/worker/index.ts);
// the code adds those events' links to this device. The page says the same
// whether or not the address is known.

const find = { email: '', sent: false };

interface Found {
  id: string;
  name: string;
  admin?: string;
  me?: string;
  pid?: string;
}

function renderFind(): void {
  document.title = `${t('findTitle')} · ${t('appName')}`;
  const actions = find.sent
    ? `<button type="submit" class="btn primary">${esc(t('findShow'))}</button>
       <button type="button" class="btn" data-act="find-again">${esc(t('findAgain'))}</button>
       <button type="button" class="btn ghost" data-act="find-other">${esc(t('findOther'))}</button>`
    : `<button type="submit" class="btn primary">${icon('mail')}${esc(t('findSend'))}</button>`;
  paint(`
    <section class="card find">
      <h1>${esc(t('findTitle'))}</h1>
      <p class="muted">${esc(t('findLead'))}</p>
      <form id="find-form" novalidate>
        ${field('email', t('findEmail'), `<input type="email" name="email" maxlength="${M.LIMITS.email}" value="${esc(find.email)}" autocomplete="email" inputmode="email" required${find.sent ? ' readonly' : ''}>`)}
        ${find.sent ? `<p class="sent" role="status">${esc(t('findSent'))}</p>${field('code', t('findCode'), '<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required>')}` : ''}
        <div class="row wrap">${actions}</div>
      </form>
    </section>`);
  const form = $<HTMLFormElement>('#find-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (find.sent) useCode($<HTMLInputElement>('#find-form [name="code"]').value);
    else askCode($<HTMLInputElement>('#find-form [name="email"]').value);
  });
  $<HTMLInputElement>(`#find-form [name="${find.sent ? 'code' : 'email'}"]`).focus();
}

async function askCode(email: string, again = false): Promise<void> {
  if (app.busy) return;
  const e = M.cleanEmail(email);
  if (!e.ok || !e.email) {
    toast(t('err.email'));
    $opt<HTMLInputElement>('#find-form [name="email"]')?.focus();
    return;
  }
  setBusy(true);
  try {
    await api('POST', '/lookup', { body: { email: e.email, lang: getLang() } });
    find.email = e.email;
    find.sent = true;
    if (again) toast(t('findAsked'));
    renderFind();
  } catch (err) {
    toast(errText(err));
  } finally {
    setBusy(false);
  }
}

async function useCode(code: string): Promise<void> {
  if (app.busy) return;
  const c = code.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(c)) {
    toast(t('err.code'));
    $opt<HTMLInputElement>('#find-form [name="code"]')?.focus();
    return;
  }
  setBusy(true);
  try {
    const r = await api<{ events: Found[] }>('POST', '/lookup/code', { body: { email: find.email, code: c } });
    for (const e of r.events) {
      const patch: Partial<Stored> = { name: e.name };
      if (e.admin) patch.admin = e.admin;
      if (e.me) Object.assign(patch, { me: e.me, pid: e.pid });
      store.put(e.id, patch);
    }
    find.email = '';
    find.sent = false;
    toast(r.events.length ? t('findFound', { n: r.events.length }) : t('findNone'));
    go('/');
  } catch (err) {
    toast(errText(err));
    $opt<HTMLInputElement>('#find-form [name="code"]')?.select();
  } finally {
    setBusy(false);
  }
}

// --- Event form (create and edit) ----------------------------------------------------------

type Preset = 'all' | 'work' | 'evening' | 'clear';
const PRESETS: Record<Preset, [number, number]> = { all: [0, 1440], work: [540, 1020], evening: [1020, 1320], clear: [0, 0] };
const DURATIONS = [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720];
const rowHeight = (slot: number) => (slot === 15 ? 14 : slot === 30 ? 20 : 30);

// 15-minute marks in [from, to): what a preset or a copied day covers,
// independent of the slot length.
function marks(from: number, to: number): Set<number> {
  const s = new Set<number>();
  for (let m = from; m < to; m += 15) s.add(m);
  return s;
}

function newDraft(): Draft {
  return {
    name: '',
    description: '',
    location: '',
    mode: 'dates',
    slot: 30,
    dayStart: 480,
    dayEnd: 1320,
    duration: 60,
    tz: browserTz(),
    settings: { ...M.DEFAULT_SETTINGS },
    holidays: guessHolidays(),
    email: '',
    dates: new Set(),
    times: new Set(),
    // In times mode a picked day starts with working hours.
    pattern: marks(...PRESETS.work),
    // At least six weeks ahead, to the end of that month.
    until: M.monthEnd(M.addDays(M.localToday(), 42)),
    decided: null,
    dirty: false,
  };
}

function draftFromView(v: M.View): Draft {
  const ev = v.event;
  const d = newDraft();
  Object.assign(d, {
    name: ev.name,
    description: ev.description,
    location: ev.location,
    mode: ev.mode,
    settings: { ...ev.settings },
    holidays: M.holidayCal(ev),
    email: v.adminEmail ?? '',
    decided: ev.decided ?? null,
  });
  if (ev.mode === 'times') {
    Object.assign(d, { slot: ev.slot, dayStart: ev.dayStart, dayEnd: ev.dayEnd, duration: ev.duration, tz: ev.tz });
    d.times = new Set(ev.options);
    d.dates = new Set(M.optionDates(ev));
  } else {
    d.dates = new Set(ev.options);
  }
  if (ev.end > d.until) d.until = M.monthEnd(ev.end);
  return d;
}

// The days the event offers: the picked ones (in times mode, those with times).
function offeredDays(d: Draft): string[] {
  const days = [...d.dates].sort();
  return d.mode === 'times' ? days.filter((x) => hasTimes(d, x)) : days;
}

// What the form would send (sanitizeEvent checks it like the server does).
// The event's period is its first to its last offered day.
function draftToEvent(d: Draft): Record<string, unknown> & { options: string[] } {
  const days = offeredDays(d);
  const start = days[0] ?? M.localToday();
  const end = days[days.length - 1] ?? start;
  const ev = { name: d.name, description: d.description, location: d.location, mode: d.mode, start, end, settings: { ...d.settings }, holidays: d.holidays, decided: d.decided ?? undefined };
  if (d.mode === 'dates') return { ...ev, options: days };
  return {
    ...ev,
    slot: d.slot,
    dayStart: d.dayStart,
    dayEnd: d.dayEnd,
    duration: d.duration,
    tz: d.tz,
    options: [...d.times].filter((k) => d.dates.has(k.slice(0, 10))).sort(),
  };
}

// Too long from the first to the last offered day?
function spanError(d: Draft): string | null {
  const days = offeredDays(d);
  if (days.length < 2) return null;
  const n = M.diffDays(days[0], days[days.length - 1]) + 1;
  if (d.mode === 'times' && n > M.LIMITS.daysTimes) return 'rangeLongTimes';
  if (n > M.LIMITS.daysDates) return 'rangeLong';
  return null;
}

function hasTimes(d: Draft, date: string): boolean {
  for (const k of d.times) if (k.startsWith(date)) return true;
  return false;
}

function setDateTimes(d: Draft, date: string, mins: Iterable<number>): void {
  for (const k of [...d.times]) if (k.startsWith(date)) d.times.delete(k);
  for (const m of mins) d.times.add(M.slotKey(date, m));
}

function fillDate(d: Draft, date: string): void {
  for (const m of M.daySlots(d)) if (!d.pattern || d.pattern.has(m)) d.times.add(M.slotKey(date, m));
}

// Every way of picking days goes through here. A day that joins in times mode
// gets the current pattern if it has no times yet.
function selectDates(d: Draft, dates: Iterable<string>, on: boolean): void {
  for (const date of dates) {
    if (!on) d.dates.delete(date);
    else if (!d.dates.has(date)) {
      d.dates.add(date);
      if (d.mode === 'times' && !hasTimes(d, date)) fillDate(d, date);
    }
  }
}

// New window or slot length: keep what was selected (resampled to the new
// slots); rows new to the window follow the pattern.
function setWindow(d: Draft, dayStart: number, dayEnd: number, slot: number): void {
  const oldSlot = d.slot;
  const oldMins = new Set(M.daySlots(d));
  const old = d.times;
  const dates = new Set([...old].map((k) => k.slice(0, 10)));
  d.dayStart = dayStart;
  d.dayEnd = dayEnd;
  d.slot = slot;
  const next = new Set<string>();
  for (const date of dates) {
    for (const m of M.daySlots(d)) {
      const src = Math.floor(m / oldSlot) * oldSlot;
      const on = oldMins.has(src) ? old.has(M.slotKey(date, src)) : !d.pattern || d.pattern.has(m);
      if (on) next.add(M.slotKey(date, m));
    }
  }
  d.times = next;
  d.duration = durationsFor(d).reduce((best, x) => (Math.abs(x - d.duration) < Math.abs(best - d.duration) ? x : best), slot);
}

function durationsFor(d: M.DayWindow): number[] {
  const list = DURATIONS.filter((x) => x % d.slot === 0 && x <= d.dayEnd - d.dayStart);
  return list.length ? list : [d.slot];
}

const hourOptions = (from: number, to: number, sel: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => (from + i) * 60)
    .map((m) => `<option value="${m}" ${m === sel ? 'selected' : ''}>${M.pad(m / 60)}:00</option>`)
    .join('');

const durationOptions = (d: Draft) => durationsFor(d).map((x) => `<option value="${x}" ${x === d.duration ? 'selected' : ''}>${esc(durationLabel(x))}</option>`).join('');

function tzOptions(sel: string): string {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // Old browser: just the current one.
  }
  if (!zones.includes(sel)) zones = [sel, ...zones];
  return zones.map((z) => `<option value="${esc(z)}" ${z === sel ? 'selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('');
}

function renderForm(v: M.View | null): void {
  if (!app.draft) app.draft = v ? draftFromView(v) : newDraft();
  const d = app.draft;
  const editing = Boolean(v);
  document.title = `${t(editing ? 'editEvent' : 'newEvent')} · ${t('appName')}`;
  const modeCard = (mode: M.Mode) => `
    <label class="opt-card">
      <input type="radio" name="mode" value="${mode}" ${d.mode === mode ? 'checked' : ''}>
      ${icon(mode === 'dates' ? 'cal' : 'clock')}
      <span><b>${esc(t(`mode.${mode}`))}</b><small>${esc(t(`mode.${mode}Hint`))}</small></span>
    </label>`;
  const check = (key: keyof M.Settings) => `
    <label class="check${key === 'maybeCounts' ? ' sub' : ''}">
      <input type="checkbox" name="s-${key}" ${d.settings[key] ? 'checked' : ''} ${(key === 'openEdit' && d.settings.hidden) || (key === 'maybeCounts' && !d.settings.maybe) ? 'disabled' : ''}>
      <span><b>${esc(t(`set.${key}`))}</b><small>${esc(t(`set.${key}Hint`))}</small></span>
    </label>`;
  paint(`
    <form id="ev-form" class="stack" novalidate>
      ${editing ? `<a class="back" href="${esc(location.pathname)}" data-act="close-sub">${icon('back')}${esc(t('back'))}</a>` : ''}
      <h1>${esc(t(editing ? 'editEvent' : 'newEvent'))}</h1>
      <section class="card">
        <h2>${esc(t('aboutEvent'))}</h2>
        ${field('name', `${t('eventName')} *`, `<input name="name" maxlength="${M.LIMITS.name}" required value="${esc(d.name)}" placeholder="${esc(t('eventNamePh'))}" autocomplete="off">`)}
        <details class="fold" ${d.description || d.location ? 'open' : ''}>
          <summary>${esc(t('addDetails'))}</summary>
          ${field('description', t('descriptionOptional'), `<textarea name="description" rows="3" maxlength="${M.LIMITS.description}">${esc(d.description)}</textarea>`)}
          ${field('location', t('locationOptional'), `<input name="location" maxlength="${M.LIMITS.location}" value="${esc(d.location)}" autocomplete="off">`)}
        </details>
      </section>
      <section class="card">
        <h2>${esc(t('whatToFind'))}</h2>
        <div class="choice">${modeCard('dates')}${modeCard('times')}</div>
        <div id="times-opts" ${d.mode === 'times' ? '' : 'hidden'}>
          <div class="grid4">
            ${field('dayStart', t('fromHour'), `<select name="dayStart">${hourOptions(0, 23, d.dayStart)}</select>`)}
            ${field('dayEnd', t('toHour'), `<select name="dayEnd">${hourOptions(1, 24, d.dayEnd)}</select>`)}
            ${field('slot', t('slotLength'), `<select name="slot">${M.SLOTS.map((s) => `<option value="${s}" ${s === d.slot ? 'selected' : ''}>${s} min</option>`).join('')}</select>`)}
            ${field('duration', t('meetingLength'), `<select name="duration">${durationOptions(d)}</select>`)}
          </div>
          ${field('tz', t('timeZone'), `<select name="tz">${tzOptions(d.tz)}</select>`, t('timeZoneHint'))}
        </div>
      </section>
      <section class="card">
        <h2>${esc(t('possibleDays'))}</h2>
        <p class="muted">${esc(t('possibleDaysHint'))}</p>
        <div id="f-chips"></div>
        <div id="f-cal"></div>
        <p class="cal-tip muted small">${esc(t(touch() ? 'rangeHintTouch' : 'rangeHint'))}</p>
        <button type="button" class="btn small" id="more-months" data-act="more-months">${icon('plus')}${esc(t('moreMonths'))}</button>
        <p id="f-count" class="count-line" aria-live="polite"></p>
        <p class="err" id="range-err" hidden></p>
      </section>
      <section class="card" id="times-card" ${d.mode === 'times' ? '' : 'hidden'}>
        <h2>${esc(t('possibleTimes'))}</h2>
        <p class="muted">${esc(t(touch() ? 'possibleTimesHintTouch' : 'possibleTimesHint'))}</p>
        <div class="chip-row">${(Object.keys(PRESETS) as Preset[]).map((p) => `<button type="button" class="btn small" data-act="preset" data-p="${p}">${esc(t(`preset.${p}`))}</button>`).join('')}</div>
        <div id="f-grid"></div>
        <p id="f-warn" class="note warn" hidden></p>
      </section>
      <section class="card">
        <h2>${esc(t('settings'))}</h2>
        ${check('maybe')}${check('maybeCounts')}${check('openEdit')}${check('hidden')}${editing ? check('closed') : ''}
        ${field('holidays', t('holidayCal'), `<select name="holidays">${M.HOLIDAY_CALENDARS.map((c) => `<option value="${c}"${d.holidays === c ? ' selected' : ''}>${esc(t(`holidayCal.${c}`))}</option>`).join('')}</select>`, t('holidayCalHint'))}
        ${field('email', t('yourEmailOptional'), `<input type="email" name="email" maxlength="${M.LIMITS.email}" value="${esc(d.email)}" autocomplete="email" inputmode="email">`, t('adminEmailHint'))}
      </section>
      <p class="err" id="form-err" hidden></p>
      <div class="savebar">
        ${editing ? `<button type="button" class="btn" data-act="close-sub">${esc(t('cancel'))}</button>` : ''}
        <button type="submit" class="btn primary">${icon('check')}${esc(t(editing ? 'saveChanges' : 'createEvent'))}</button>
      </div>
    </form>`);
  bindForm();
  refreshDays();
  refreshTimes();
}

function bindForm(): void {
  const form = $<HTMLFormElement>('#ev-form');
  const d = draft();
  form.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const n = el.name;
    if (n === 'name' || n === 'description' || n === 'location' || n === 'email') d[n] = el.value;
    d.dirty = true;
  });
  // Enter in a text field shouldn't create the event by accident.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as Element).matches('input')) e.preventDefault();
  });
  form.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    const n = el.name;
    d.dirty = true;
    if (n === 'mode') setMode(el.value as M.Mode);
    else if (n === 'dayStart' || n === 'dayEnd' || n === 'slot') changeWindow(n);
    else if (n === 'duration') d.duration = Number(el.value);
    else if (n === 'tz') d.tz = el.value;
    else if (n === 'holidays' && M.isHolidayCalendar(el.value)) {
      // Only the dots and the Helligdager button change, never the picked days.
      d.holidays = el.value;
      refreshDays();
    }
    else if (n.startsWith('s-')) {
      d.settings[n.slice(2) as keyof M.Settings] = el.checked;
      if (n === 's-hidden') {
        if (el.checked) d.settings.openEdit = false;
        const openEdit = control(form, 's-openEdit');
        openEdit.checked = d.settings.openEdit;
        openEdit.disabled = el.checked;
      }
      // Without maybe answers there is nothing for it to count.
      if (n === 's-maybe') control(form, 's-maybeCounts').disabled = !el.checked;
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitForm();
  });
  bindPaint($('#f-cal'), '.cal-day[data-d]', {
    get: (el) => d.dates.has(data(el, 'd')),
    next: (el) => !d.dates.has(data(el, 'd')),
    apply: (el, on) => {
      changed();
      selectDates(d, [data(el, 'd')], on);
      el.classList.toggle('on', on);
      el.setAttribute('aria-pressed', String(on));
    },
    done: () => {
      refreshChips();
      refreshCount();
      refreshTimes();
    },
  });
}

// The organiser changed days or times by hand.
function changed(): void {
  draft().dirty = true;
}

function setMode(mode: M.Mode): void {
  const d = draft();
  d.mode = mode;
  if (mode === 'times') for (const date of d.dates) if (!hasTimes(d, date)) fillDate(d, date);
  $('#times-opts').hidden = mode !== 'times';
  $('#times-card').hidden = mode !== 'times';
  refreshCount();
  refreshTimes();
}

function changeWindow(which: string): void {
  const d = draft();
  const form = $<HTMLFormElement>('#ev-form');
  const dayStart = control<HTMLSelectElement>(form, 'dayStart');
  const dayEnd = control<HTMLSelectElement>(form, 'dayEnd');
  let ds = Number(dayStart.value);
  let de = Number(dayEnd.value);
  const slot = Number(control<HTMLSelectElement>(form, 'slot').value);
  if (de <= ds) {
    if (which === 'dayEnd') ds = Math.max(0, de - 60);
    else de = Math.min(1440, ds + 60);
    dayStart.value = String(ds);
    dayEnd.value = String(de);
  }
  setWindow(d, ds, de, slot);
  control<HTMLSelectElement>(form, 'duration').innerHTML = durationOptions(d);
  refreshCount();
  refreshTimes();
}

// The form calendar: from today (or an earlier picked day, when editing) to
// the end of the last month shown. Past days can only be unpicked.
function refreshDays(): void {
  const d = draft();
  const today = M.localToday();
  const first = [...d.dates].sort()[0];
  const start = first && first < today ? first : today;
  const hol = M.holidaysIn(start, d.until, d.holidays);
  $('#f-cal').innerHTML = calendarHtml({
    start,
    end: d.until,
    weekHtml: (mon, wk) => `<button type="button" class="cal-wk" data-act="week" data-mon="${mon}" title="${esc(t('toggleWeek', { n: wk }))}" aria-label="${esc(t('toggleWeek', { n: wk }))}">${wk}</button>`,
    dayHtml: (x) => {
      const on = d.dates.has(x);
      if (x < today && !on) return `<span class="cal-day out">${Number(x.slice(8))}</span>`;
      const h = hol.get(x);
      const name = h ? holidayNames(h) : '';
      return `<button type="button" class="cal-day pick${on ? ' on' : ''}${h ? ' hol' : ''}${M.isWeekend(x) ? ' we' : ''}" data-d="${x}" aria-pressed="${on}" aria-label="${esc(fmtDate(x, 'long'))}${name ? ` (${esc(name)})` : ''}"${name ? ` title="${esc(name)}"` : ''}>${Number(x.slice(8))}</button>`;
    },
  });
  $('#more-months').hidden = d.until >= M.monthEnd(today, MAX_MONTHS);
  refreshChips();
  refreshCount();
}

// How far ahead the calendar goes: this month and MAX_MONTHS more.
const MAX_MONTHS = 12;

// What the quick buttons act on: every day shown, from today on.
function scopeDays(): string[] {
  return M.dateRange(M.localToday(), draft().until);
}

function groupDays(g: string): string[] {
  const days = scopeDays();
  if (g === 'weekdays') return days.filter((x) => !M.isWeekend(x));
  if (g === 'weekends') return days.filter(M.isWeekend);
  if (g === 'holidays') {
    const hol = M.holidaysIn(days[0], days[days.length - 1], draft().holidays);
    return days.filter((x) => hol.has(x));
  }
  return days;
}

type Period = '2w' | '4w' | 'month';
// The days a period button picks.
function periodDays(p: Period): string[] {
  const today = M.localToday();
  if (p === 'month') return M.dateRange(M.monthStart(today, 1), M.monthEnd(today, 1));
  return M.dateRange(today, M.addDays(today, p === '2w' ? 13 : 27));
}

function refreshChips(): void {
  const d = draft();
  const days = scopeDays();
  const short = weekdayShort();
  const long = weekdayLong();
  const nextMonth = M.monthStart(M.localToday(), 1);
  const chip = (attrs: string, label: string, state: M.ChipState, title: string) => `
    <button type="button" class="chip st-${state}" ${attrs} ${state === 'empty' ? 'disabled' : ''}
      aria-pressed="${state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}" title="${esc(title)}">${state === 'all' ? icon('check') : state === 'some' ? icon('minus') : ''}${esc(label)}</button>`;
  const period = (p: Period, label: string) => `<button type="button" class="btn small" data-act="period" data-p="${p}" title="${esc(t('periodHint'))}">${esc(label)}</button>`;
  $('#f-chips').innerHTML = `
    <div class="chip-row">
      ${period('2w', t('period2w'))}${period('4w', t('period4w'))}${period('month', t('periodMonth', { month: monthName(nextMonth) }))}
      <button type="button" class="btn small" data-act="sel-none">${esc(t('selNone'))}</button>
    </div>
    <div class="chip-row">
      ${(d.holidays === 'none' ? (['weekdays', 'weekends'] as const) : (['weekdays', 'weekends', 'holidays'] as const)).map((g) => chip(`data-act="sel-group" data-g="${g}"`, t(g), M.groupState(d.dates, groupDays(g)), t(`${g}Hint`))).join('')}
    </div>
    <div class="chip-row wd">${short.map((n, wd) => chip(`data-act="sel-wd" data-wd="${wd}"`, n, M.weekdayState(d.dates, days, wd), t('weekdayHint', { day: long[wd] }))).join('')}</div>`;
}

function refreshCount(): void {
  const d = draft();
  const offered = offeredDays(d);
  let s = t('nDays', { n: d.dates.size });
  if (d.mode === 'times') {
    const n = draftToEvent(d).options.length;
    s += ` · ${t('nSlots', { n })}`;
    const empty = d.dates.size - offered.length;
    if (empty) s += ` · ${t('nDaysNoTimes', { n: empty })}`;
  }
  if (offered.length) s += ` · ${fmtRange(offered[0], offered[offered.length - 1])}`;
  $('#f-count').textContent = s;
  const err = spanError(d);
  const errEl = $('#range-err');
  errEl.hidden = !err;
  errEl.textContent = err ? tx(`err.${err}`) : '';
  // Participants answer one week at a time on a phone (see TimeGrid).
  const warn = $opt('#f-warn');
  if (warn) {
    const weeks = d.mode === 'times' ? weekPages(offered).length : 0;
    // Two weeks from a Saturday already touch three calendar weeks.
    warn.hidden = weeks <= 3;
    warn.textContent = weeks > 3 ? t('manyWeeks', { n: weeks }) : '';
  }
}

function refreshTimes(): void {
  const d = draft();
  if (d.mode !== 'times') return;
  const opts = { dates: [...d.dates].sort(), mins: M.daySlots(d), rowh: rowHeight(d.slot), empty: t('pickDaysFirst') };
  if (app.formGrid?.el.isConnected) {
    app.formGrid.set(opts);
    return;
  }
  app.formGrid = new TimeGrid($('#f-grid'), {
    ...opts,
    mode: 'paint',
    value: (k) => (draft().times.has(k) ? 1 : 0),
    brush: () => 1,
    onPaint: (keys, val) => {
      changed();
      const times = draft().times;
      for (const k of keys) {
        if (val) times.add(k);
        else times.delete(k);
      }
      refreshCount();
    },
    onDay: (date) => dayMenu(date),
  });
}

async function dayMenu(date: string): Promise<void> {
  const d = draft();
  const r = await menu(cap(fmtDate(date, 'long')), [
    { id: 'all', label: t('dayAll') },
    { id: 'clear', label: t('dayClear') },
    { id: 'copy', label: t('dayCopy'), hint: t('dayCopyHint') },
    { id: 'remove', label: t('dayRemove'), danger: true },
  ]);
  if (r === '') return;
  changed();
  const mins = M.daySlots(d);
  if (r === 'all') setDateTimes(d, date, mins);
  else if (r === 'clear') setDateTimes(d, date, []);
  else if (r === 'copy') {
    const own = mins.filter((m) => d.times.has(M.slotKey(date, m)));
    d.pattern = new Set(own.flatMap((m) => [...marks(m, m + d.slot)]));
    for (const x of d.dates) setDateTimes(d, x, own);
  } else if (r === 'remove') {
    selectDates(d, [date], false);
    refreshDays();
  } else return;
  refreshCount();
  refreshTimes();
}

function applyPreset(p: Preset): void {
  changed();
  const d = draft();
  const [from, to] = PRESETS[p];
  d.pattern = p === 'all' ? null : marks(from, to);
  const mins = M.daySlots(d).filter((m) => m >= from && m + d.slot <= to);
  for (const x of d.dates) setDateTimes(d, x, mins);
  refreshCount();
  refreshTimes();
}

// A quick button: if any of its days are picked it drops them, otherwise it
// picks them all.
function selectGroup(list: string[]): void {
  changed();
  const d = draft();
  selectDates(d, list, !list.some((x) => d.dates.has(x)));
  refreshDays();
  refreshTimes();
}

async function submitForm(): Promise<void> {
  if (app.busy) return;
  const d = draft();
  const v = app.route?.page === 'event' ? app.view : null;
  const form = $<HTMLFormElement>('#ev-form');
  const errEl = $('#form-err');
  errEl.hidden = true;
  const fail = (msg: string, focus?: HTMLElement) => {
    errEl.textContent = msg;
    errEl.hidden = false;
    toast(msg);
    focus?.focus();
  };
  if (!d.name.trim()) return fail(t('err.name'), control(form, 'name'));
  const re = spanError(d);
  if (re) return fail(tx(`err.${re}`));
  const r = M.sanitizeEvent(draftToEvent(d));
  if (!r.ok) return fail(tx(`err.${r.error}`));
  const em = M.cleanEmail(d.email);
  if (!em.ok) return fail(t('err.email'), control(form, 'email'));
  if (v) {
    const keep = new Set(r.event.options);
    let lost = 0;
    for (const p of v.people) for (const k of Object.keys(p.answers)) if (!keep.has(k)) lost += 1;
    if (lost && !(await ask(t('lostAnswers', { n: lost }), { ok: t('saveAnyway'), danger: true }))) return;
  }
  setBusy(true);
  try {
    if (v) {
      const { id, token } = here();
      const { view } = await api<{ view: M.View }>('PUT', `/events/${id}`, { token, body: { event: r.event, email: em.email } });
      d.dirty = false;
      setView(view);
      toast(t('saved'));
      closeSub();
    } else {
      const res = await api<M.Created>('POST', '/events', { body: { event: r.event, email: em.email } });
      store.put(res.id, { name: r.event.name, admin: res.token });
      d.dirty = false;
      app.flash = { kind: 'created' };
      setView(res.view, res.id, res.token);
      go(`/e/${res.id}/${res.token}`, true);
    }
  } catch (e) {
    fail(errText(e));
  } finally {
    setBusy(false);
  }
}

// --- Event page -----------------------------------------------------------------------------

const heat = (g: M.Tally, n: number, s: M.Settings): string => M.heat(g, n, s).toFixed(3);
// Dark cells get light text.
const hi = (h: string) => (Number(h) > 0.55 ? ' hi' : '');

function rowsFor(ev: M.TimesEvent): number[] {
  let lo = 1440;
  let hi = 0;
  for (const k of ev.options) {
    const min = M.parseKey(k)?.min;
    if (min === null || min === undefined) continue;
    lo = Math.min(lo, min);
    hi = Math.max(hi, min);
  }
  lo = Math.max(ev.dayStart, Math.floor(lo / 60) * 60);
  return M.daySlots(ev).filter((m) => m >= lo && m <= hi);
}

function hue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + (c.codePointAt(0) ?? 0)) % 360;
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? '?').slice(0, 2)).toUpperCase();
}

function personSummary(ev: M.PollEvent, p: M.Person): string {
  let y = 0;
  let m = 0;
  for (const k of ev.options) {
    if (p.answers[k] === M.YES) y += 1;
    else if (p.answers[k] === M.MAYBE) m += 1;
  }
  if (!y && !m) return t(ev.mode === 'dates' ? 'sumNoneDates' : 'sumNoneTimes');
  if (ev.mode === 'dates') return [t('sumYes', { n: y, m: ev.options.length }), m ? t('nMaybe', { n: m }) : ''].filter(Boolean).join(' · ');
  return [t('sumYesTime', { dur: durationLabel(y * ev.slot) }), m ? t('maybeDur', { dur: durationLabel(m * ev.slot) }) : ''].filter(Boolean).join(' · ');
}

function renderOverview(v: M.View): void {
  const ev = v.event;
  const { id } = here();
  document.title = `${ev.name} · ${t('appName')}`;
  const stored = store.get(id);
  // Just created: sharing the link is the next thing to do.
  const created = app.flash?.kind === 'created';
  const share = v.role === 'admin' ? shareHtml(v) : '';
  paint(`
    ${flashHtml()}
    ${noticesHtml(v, stored)}
    ${headHtml(v)}
    ${decidedHtml(v)}
    ${created ? share : ''}
    ${actionsHtml(v)}
    ${created ? '' : share}
    ${resultsHtml(v)}
    ${peopleHtml(v, stored)}
    <p class="muted small center">${esc(t('expiresNote', { date: fmtDate(M.addDays(ev.end, M.RETENTION_DAYS), 'full') }))}</p>`);
  mountResults(v);
  app.flash = null;
}

function flashHtml(): string {
  const f = app.flash;
  if (!f) return '';
  if (f.kind === 'created') {
    return `<section class="card notice ok"><h2>${icon('check')}${esc(t('createdTitle'))}</h2><p>${esc(t('createdText'))}</p></section>`;
  }
  if (f.kind === 'savedNew') {
    const { id, token } = here();
    return `<section class="card notice ok">
      <h2>${icon('check')}${esc(t('savedNewTitle', { name: f.name }))}</h2>
      <p>${esc(t('savedNewText'))}</p>
      ${linkBox(linkUrl(id, token), { share: true, label: t('yourLink') })}
      <p class="muted small">${esc(t('savedNewHint'))}</p>
    </section>`;
  }
  return '';
}

function noticesHtml(v: M.View, stored: Stored | null): string {
  const { id, token } = here();
  const out: string[] = [];
  if (v.link === 'invalid') out.push(`<section class="card notice warn"><p>${esc(t('linkInvalid'))}</p></section>`);
  if (v.role === 'visitor' && stored && (stored.admin || stored.me)) {
    const btns: string[] = [];
    if (stored.admin && stored.admin !== token) btns.push(`<a class="btn small" href="/e/${id}/${stored.admin}" data-link>${esc(t('openAdmin'))}</a>`);
    if (stored.me && stored.me !== token) btns.push(`<a class="btn small" href="/e/${id}/${stored.me}" data-link>${esc(t('openMine'))}</a>`);
    if (btns.length) out.push(`<section class="card notice info"><p>${esc(t(stored.admin ? 'storedAdmin' : 'storedMine'))}</p><div class="row wrap">${btns.join('')}</div></section>`);
  }
  if (v.event.settings.closed) out.push(`<section class="card notice">${icon('lock')}<p>${esc(t(v.role === 'admin' ? 'closedAdmin' : 'closedInfo'))}</p></section>`);
  return out.join('');
}

function headHtml(v: M.View): string {
  const ev = v.event;
  const meta: [string, string][] = [[icon('cal'), fmtRange(ev.start, ev.end)]];
  if (ev.mode === 'dates') meta.push([icon('grid'), t('metaDates', { n: ev.options.length })]);
  else {
    meta.push([icon('clock'), t('metaTimes', { dur: durationLabel(ev.duration) })]);
    const mine = browserTz();
    meta.push([icon('globe'), `${t('timesIn', { tz: ev.tz.replace(/_/g, ' ') })}${mine !== ev.tz ? ` ${t('yourTz', { tz: mine.replace(/_/g, ' ') })}` : ''}`]);
  }
  if (ev.location) meta.push([icon('pin'), ev.location]);
  if (ev.settings.hidden) meta.push([icon('eye-off'), t('metaHidden')]);
  if (ev.settings.openEdit && !ev.settings.hidden) meta.push([icon('users'), t('metaOpenEdit')]);
  return `<section class="card head">
    <h1>${esc(ev.name)}</h1>
    <ul class="meta">${meta.map(([i, s]) => `<li>${i}<span>${esc(s)}</span></li>`).join('')}</ul>
    ${ev.description ? `<p class="desc">${esc(ev.description)}</p>` : ''}
  </section>`;
}

function actionsHtml(v: M.View): string {
  const ev = v.event;
  const { id, token } = here();
  const who = { role: v.role, me: v.me };
  const add = M.canAdd(who, ev.settings);
  const shareBtn = `<button type="button" class="btn" data-act="share" data-url="${esc(eventUrl(id))}" data-title="${esc(ev.name)}">${icon('share')}${esc(t('shareEvent'))}</button>`;
  if (v.role === 'admin') {
    return `<section class="card role">
      <div class="role-text"><b>${esc(t('youAreAdmin'))}</b><p class="muted">${esc(t('adminHint'))}</p></div>
      <div class="row wrap">
        ${add ? `<button type="button" class="btn${app.flash?.kind === 'created' ? '' : ' primary'}" data-act="answer">${icon('plus')}${esc(t('addAnswers'))}</button>` : ''}
        <button type="button" class="btn" data-act="edit-event">${icon('edit')}${esc(t('editEvent'))}</button>
        <button type="button" class="btn" data-act="toggle-closed">${icon('lock')}${esc(t(ev.settings.closed ? 'reopen' : 'close'))}</button>
        <button type="button" class="btn" data-act="admin-more" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('dots')}</button>
      </div>
    </section>`;
  }
  if (v.role === 'participant') {
    const me = v.people.find((p) => p.id === v.me);
    return `<section class="card role">
      <div class="role-text"><b>${esc(t('hiName', { name: me?.name ?? '' }))}</b>${app.flash?.kind === 'savedNew' ? '' : `<p class="muted">${esc(t('personalHint'))}</p>`}</div>
      <div class="row wrap">
        ${M.canEdit(who, ev.settings, v.me) ? `<button type="button" class="btn primary" data-act="answer">${icon('edit')}${esc(t('editYourAnswers'))}</button>` : ''}
        <button type="button" class="btn" data-act="copy" data-url="${esc(linkUrl(id, token))}">${icon('copy')}${esc(t('copyMyLink'))}</button>
        ${shareBtn}
        <button type="button" class="btn" data-act="me-more" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('dots')}</button>
      </div>
    </section>`;
  }
  return `<section class="card role cta">
    ${add ? `<button type="button" class="btn primary big" data-act="answer">${icon('plus')}${esc(t('addYourAnswers'))}</button>` : ''}
    ${shareBtn}
  </section>`;
}

function shareHtml(v: M.View): string {
  const { id, token } = here();
  const open = app.flash?.kind === 'created' || v.count === 0;
  return `<details class="card share" ${open ? 'open' : ''}>
    <summary><h2>${icon('share')}${esc(t('shareTitle'))}</h2></summary>
    <p class="muted">${esc(t('shareHint'))}</p>
    ${linkBox(eventUrl(id), { share: true, qr: true, label: t('eventLink'), title: v.event.name, primary: app.flash?.kind === 'created' })}
    <h3>${icon('key')}${esc(t('adminLinkTitle'))}</h3>
    <p class="muted">${esc(t('adminLinkHint'))}</p>
    ${linkBox(linkUrl(id, token), { label: t('adminLinkTitle') })}
  </details>`;
}

// "2 av 4 kan · 1 kanskje"; when maybe counts, "3 av 4 kan · inkl. 1 kanskje".
function countText(g: M.Tally, n: number, s: M.Settings): string {
  const m = g.maybe.length;
  return t('nOfM', { n: M.score(g, s), m: n }) + (m ? ` · ${t(s.maybeCounts ? 'nMaybeIncl' : 'nMaybe', { n: m })}` : '');
}

// Every option ranked best first: dates, or in times mode windows that
// don't overlap.
const ranked = (ev: M.PollEvent, people: readonly M.Person[]): (M.Tally | M.TimeWindow)[] =>
  ev.mode === 'dates' ? M.bestOptions(ev, people, Infinity) : M.bestWindows(ev, people, Infinity);

// The ones sharing first place.
const firstPlace = <T extends M.Tally>(list: T[], s: M.Settings): T[] => list.filter((b) => M.sameScore(b, list[0], s));

const SHOW_BEST = 3;

function bestHtml(v: M.View): string {
  const ev = v.event;
  const s = ev.settings;
  const n = v.people.length;
  if (!n) return '';
  const all = ranked(ev, v.people);
  if (!all.length) return `<p class="muted">${esc(t('noneAvailable'))}</p>`;
  const rank = M.ranks(all, s);
  // Never leave out one that is as good as the first.
  const more = rank.slice(SHOW_BEST).filter((r) => r === 1).length;
  return `<ol class="best">${all
    .slice(0, SHOW_BEST)
    .map(
      (b, i) => `<li><button type="button" class="best-item${rank[i] === 1 ? ' first' : ''}${app.pick?.k === b.key ? ' sel' : ''}" data-act="pick" data-k="${b.key}" ${ev.mode === 'times' ? 'data-win="1"' : ''}>
        <span class="rank">${rank[i]}</span>
        <span class="bl">${esc(cap('date' in b ? windowLabel(b) : fmtDate(b.key, 'long')))}${ev.decided === b.key ? ` <span class="tag">${esc(t('decidedTag'))}</span>` : ''}</span>
        <span class="bn">${esc(countText(b, n, s))}</span>
      </button></li>`,
    )
    .join('')}</ol>
    ${more ? `<p class="best-more muted small">${esc(t('moreTied', { n: more }))}</p>` : ''}
    ${s.maybe ? `<p class="best-how muted small">${esc(t(s.maybeCounts ? 'rankMaybeCounts' : 'rankYesFirst'))}</p>` : ''}`;
}

function resultsHtml(v: M.View): string {
  const ev = v.event;
  const title = `<h2>${esc(t('resultsTitle'))}</h2>`;
  if (v.hidden) return `<section class="card results">${title}<p class="muted">${esc(t('hiddenInfo', { n: v.count }))}</p></section>`;
  const tabs: Tab[] = ev.mode === 'dates' ? ['cal', 'list', 'table'] : ['grid', 'list'];
  if (!app.tab || !tabs.includes(app.tab)) app.tab = tabs[0];
  return `<section class="card results">
    ${title}
    ${v.people.length ? '' : `<p class="muted">${esc(t('noAnswersYet'))}</p>`}
    ${bestHtml(v)}
    <div class="seg" role="tablist">${tabs.map((x) => `<button type="button" role="tab" class="${x === app.tab ? 'on' : ''}" aria-selected="${x === app.tab}" data-act="tab" data-tab="${x}">${esc(t(`tab.${x}`))}</button>`).join('')}</div>
    <div id="res-body">${resultsBody(v)}</div>
    ${app.tab === 'table' ? '' : `<div class="legend" aria-hidden="true"><span>${esc(t('legendFew'))}</span><span class="ramp"></span><span>${esc(t('legendMany'))}</span></div>`}
    <div id="detail" aria-live="polite">${detailHtml(v)}</div>
  </section>`;
}

function resultsBody(v: M.View): string {
  const ev = v.event;
  const n = v.people.length;
  const T = M.tally(ev, v.people);
  // tally() has every option.
  const at = (k: string): M.Tally => T.get(k) ?? { key: k, yes: [], maybe: [], no: [] };
  const pct = (x: number) => (n ? (100 * x) / n : 0).toFixed(1);
  const row = (key: string, label: string, g: M.Tally, win: boolean) => `
    <button type="button" class="res-row${app.pick?.k === key ? ' sel' : ''}" data-act="pick" data-k="${key}" ${win ? 'data-win="1"' : ''}>
      <span class="rl">${esc(cap(label))}</span>
      <span class="meter"><i class="y" style="width:${pct(g.yes.length)}%"></i><i class="m" style="width:${pct(g.maybe.length)}%"></i></span>
      <span class="rn">${M.score(g, ev.settings)}/${n}</span>
    </button>`;

  if (ev.mode === 'times') {
    if (app.tab === 'grid') return '<div id="res-grid"></div>';
    const ws = M.bestWindows(ev, v.people, 15);
    if (!ws.length) return `<p class="muted">${esc(t('noneAvailable'))}</p>`;
    return `<div class="res-list">${ws.map((w) => row(w.key, windowLabel(w), w, true)).join('')}</div>`;
  }

  if (app.tab === 'list') return `<div class="res-list">${ev.options.map((k) => row(k, fmtDate(k, 'long'), at(k), false)).join('')}</div>`;

  if (app.tab === 'table') {
    if (!n) return `<p class="muted">${esc(t('noAnswersYet'))}</p>`;
    const wd = weekdayShort();
    const cell = (a: M.Answer | undefined) =>
      a === M.YES ? `<td class="y" title="${esc(t('yes'))}">✓</td>` : a === M.MAYBE ? `<td class="m" title="${esc(t('maybe'))}">(✓)</td>` : `<td class="n" title="${esc(t('no'))}"></td>`;
    return `<div class="table-scroll"><table class="ptable">
      <thead><tr><th scope="col" class="name">${esc(t('name'))}</th>${ev.options.map((k) => `<th scope="col"><span>${wd[M.weekday(k)]}</span><b>${Number(k.slice(8))}</b><small>${esc(fmtDate(k, 'monthShort'))}</small></th>`).join('')}</tr></thead>
      <tbody>${v.people.map((p) => `<tr><th scope="row" class="name">${esc(p.name)}</th>${ev.options.map((k) => cell(p.answers[k])).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row" class="name">${esc(t('sum'))}</th>${ev.options.map((k) => `<td>${M.score(at(k), ev.settings)}</td>`).join('')}</tr></tfoot>
    </table></div>`;
  }

  const opts = new Set(ev.options);
  const ds = M.optionDates(ev);
  const top = new Set(firstPlace(M.bestOptions(ev, v.people, Infinity), ev.settings).map((b) => b.key));
  // From the first to the last offered day: weeks without any are left out.
  return calendarHtml({
    start: ds[0],
    end: ds[ds.length - 1],
    dayHtml: (x) => {
      if (!opts.has(x)) return `<span class="cal-day off">${Number(x.slice(8))}</span>`;
      const g = at(x);
      const a = M.score(g, ev.settings);
      const h = heat(g, n, ev.settings);
      return `<button type="button" class="cal-day res${hi(h)}${top.has(x) ? ' top' : ''}${app.pick?.k === x ? ' sel' : ''}" style="--h:${h}" data-act="pick" data-k="${x}" aria-label="${esc(fmtDate(x, 'long'))}: ${esc(countText(g, n, ev.settings))}"><span class="dn">${Number(x.slice(8))}</span><span class="dc">${a || ''}</span></button>`;
    },
  });
}

function detailHtml(v: M.View): string {
  const ev = v.event;
  const p = app.pick;
  if (!v.people.length) return '';
  if (!p) return `<p class="muted small">${esc(t(ev.mode === 'times' && app.tab === 'grid' ? 'tapCellForDetails' : 'tapForDetails'))}</p>`;
  let g: M.Tally | undefined;
  let label: string;
  if (p.win) {
    const w = M.windows(ev, v.people).find((x) => x.key === p.k);
    if (!w) return '';
    g = w;
    label = windowLabel(w);
  } else {
    g = M.tally(ev, v.people).get(p.k);
    if (!g) return '';
    label = ev.mode === 'dates' ? fmtDate(p.k, 'long') : slotLabel(p.k, ev.slot);
  }
  const byId = new Map(v.people.map((x) => [x.id, x.name]));
  const names = (ids: string[]) => (ids.length ? ids.map((x) => `<span class="pn">${esc(byId.get(x))}</span>`).join('') : '<span class="muted">–</span>');
  return `<div class="detail">
    <h3>${esc(cap(label))}</h3>
    <div class="dg yes"><b>${icon('check')}${esc(t('canCome'))} (${g.yes.length})</b><div>${names(g.yes)}</div></div>
    ${g.maybe.length || ev.settings.maybe ? `<div class="dg maybe"><b>${icon('maybe')}${esc(t('ifNeedBe'))} (${g.maybe.length})</b><div>${names(g.maybe)}</div></div>` : ''}
    <div class="dg no"><b>${icon('x')}${esc(t('cannot'))} (${g.no.length})</b><div>${names(g.no)}</div></div>
    ${decideHtml(v, p.k)}
  </div>`;
}

// What the picked date or time is called: "fredag 27. november" or
// "onsdag 18. november, 10:00–11:00" (times mode: the whole window).
function whenLabel(ev: M.PollEvent, key: string): string {
  if (ev.mode === 'dates') return fmtDate(key, 'long');
  const w = M.windows(ev, []).find((x) => x.key === key);
  return w ? windowLabel(w) : slotLabel(key, ev.slot);
}

// For the admin, under the details of an option: pick it as the final date.
function decideHtml(v: M.View, key: string): string {
  const ev = v.event;
  if (v.role !== 'admin' || !M.decisionKeys(ev).has(key)) return '';
  if (ev.decided === key) return `<p class="decided-mark">${icon('check')}${esc(t('decidedThis'))}</p>`;
  return `<button type="button" class="btn small" data-act="decide" data-k="${key}">${icon('check')}${esc(t('decideThis', { when: whenLabel(ev, key) }))}</button>`;
}

// Everyone sees the organiser's pick first, with a calendar file.
function decidedHtml(v: M.View): string {
  const ev = v.event;
  const pick = M.decision(ev, v.people);
  if (!pick || !ev.decided) return '';
  const n = v.people.length;
  return `<section class="card notice ok decided">
    <h2>${icon('check')}${esc(t('decidedTitle'))}</h2>
    <p class="when">${esc(cap(whenLabel(ev, ev.decided)))}</p>
    ${n && !v.hidden ? `<p class="muted">${esc(countText(pick, n, ev.settings))}</p>` : ''}
    <div class="row wrap">
      <button type="button" class="btn primary" data-act="ics">${icon('cal')}${esc(t('addToCalendar'))}</button>
      ${v.role === 'admin' ? `<button type="button" class="btn" data-act="undecide">${esc(t('undoDecision'))}</button>` : ''}
    </div>
  </section>`;
}

function updateDetail(): void {
  const el = $opt('#detail');
  if (el && app.view) el.innerHTML = detailHtml(app.view);
  for (const b of $$('[data-act="pick"]')) b.classList.toggle('sel', b.dataset.k === app.pick?.k);
  app.refreshResGrid?.();
}

function mountResults(v: M.View): void {
  const el = $opt('#res-grid');
  const ev = v.event;
  if (!el || ev.mode !== 'times') return;
  const n = v.people.length;
  const T = M.tally(ev, v.people);
  const opts = new Set(ev.options);
  const topKeys = new Set(firstPlace(M.bestWindows(ev, v.people, Infinity), ev.settings).flatMap((w) => w.keys));
  const selKeys = (): Set<string> => {
    const p = app.pick;
    if (!p) return new Set();
    if (p.win) return new Set(M.windows(ev, v.people).find((w) => w.key === p.k)?.keys ?? []);
    return new Set([p.k]);
  };
  let sel = selKeys();
  app.resGrid = new TimeGrid(el, {
    mode: 'view',
    dates: M.optionDates(ev),
    mins: rowsFor(ev),
    rowh: rowHeight(ev.slot),
    page: app.gridPage,
    allowed: (k) => opts.has(k),
    decorate: (k) => {
      const g = T.get(k) ?? { key: k, yes: [], maybe: [], no: [] };
      const a = M.score(g, ev.settings);
      const h = heat(g, n, ev.settings);
      return { cls: `heat${hi(h)}${topKeys.has(k) ? ' top' : ''}${sel.has(k) ? ' sel' : ''}`, h, text: n && a ? String(a) : '' };
    },
    onPick: (k) => {
      app.pick = { k };
      updateDetail();
    },
    onPage: (p) => (app.gridPage = p),
  });
  app.refreshResGrid = () => {
    sel = selKeys();
    app.resGrid?.refresh();
  };
}

function peopleHtml(v: M.View, stored: Stored | null): string {
  const ev = v.event;
  const who = { role: v.role, me: v.me };
  const mine = (p: M.Person) => p.id === v.me || Boolean(stored?.pid && p.id === stored.pid);
  const rows = v.people
    .map((p) => {
      const edit = M.canEdit(who, ev.settings, p.id);
      const btn = (act: string, ic: string, label: string) => `<button type="button" class="icon-btn" data-act="${act}" data-pid="${p.id}" title="${esc(label)}" aria-label="${esc(label)}">${icon(ic)}</button>`;
      return `<li class="${mine(p) ? 'mine' : ''}">
        <span class="avatar" style="--hue:${hue(p.name)}" aria-hidden="true">${esc(initials(p.name))}</span>
        <div class="pinfo">
          <b>${esc(p.name)}${mine(p) ? ` <span class="tag">${esc(t('you'))}</span>` : ''}</b>
          <span class="psum">${esc(personSummary(ev, p))}</span>
          ${p.comment ? `<span class="pcomment">${esc(p.comment)}</span>` : ''}
        </div>
        <div class="pact">
          ${v.role === 'admin' ? btn('person-link', 'link', t('copyPersonLink', { name: p.name })) : ''}
          ${edit ? btn('edit-entry', 'edit', t('editAnswersOf', { name: p.name })) + btn('delete-entry', 'trash', t('deleteEntry', { name: p.name })) : ''}
        </div>
      </li>`;
    })
    .join('');
  return `<section class="card people">
    <h2>${esc(t('responses'))} <span class="count">${v.count}</span></h2>
    ${v.hidden ? `<p class="muted small">${esc(t('hiddenPeople'))}</p>` : ''}
    ${rows ? `<ul class="plist">${rows}</ul>` : `<p class="muted">${esc(t('noAnswersYet'))}</p>`}
  </section>`;
}

// --- Answer editor --------------------------------------------------------------------------

function renderAnswer(v: M.View, pid: string | null): void {
  const ev = v.event;
  const who = { role: v.role, me: v.me };
  const target = pid ? v.people.find((p) => p.id === pid) : v.me ? v.people.find((p) => p.id === v.me) : null;
  if (pid && !target) {
    toast(t('err.person'));
    return closeSub();
  }
  if (target ? !M.canEdit(who, ev.settings, target.id) : !M.canAdd(who, ev.settings)) {
    toast(t(ev.settings.closed ? 'err.closed' : 'err.forbidden'));
    return closeSub();
  }
  const own = !target || target.id === v.me;
  if (!app.answer) {
    app.answer = {
      pid: target?.id ?? null,
      own,
      name: target?.name ?? '',
      comment: target?.comment ?? '',
      email: target?.email ?? '',
      answers: { ...(target?.answers ?? {}) },
      brush: M.YES,
      view: 'cal',
      dirty: false,
    };
  }
  const a = answer();
  const title = target ? (own ? t('editYourAnswers') : t('editAnswersOf', { name: target.name })) : t('addYourAnswers');
  document.title = `${title} · ${ev.name}`;
  const hint: Key =
    ev.mode === 'dates'
      ? ev.settings.maybe
        ? 'answerDatesHintMaybe'
        : 'answerDatesHint'
      : touch()
        ? ev.settings.maybe
          ? 'answerTimesHintTouchMaybe'
          : 'answerTimesHintTouch'
        : ev.settings.maybe
          ? 'answerTimesHintMaybe'
          : 'answerTimesHint';
  paint(`
    <a class="back" href="${esc(location.pathname)}" data-act="cancel-answer">${icon('back')}${esc(t('back'))}</a>
    <h1>${esc(title)}</h1>
    <p class="muted sub">${esc(ev.name)}</p>
    <section class="card picker">
      <h2>${esc(t(ev.mode === 'dates' ? 'whichDays' : 'whichTimes'))}</h2>
      <p class="muted">${esc(t(hint))}</p>
      <div class="toolbar" id="pick-tools">${pickerToolbar(v)}</div>
      <div id="pick-area"></div>
      <p id="pick-sum" class="count-line" aria-live="polite"></p>
    </section>
    <section class="card">
      <form id="answer-form" novalidate>
        ${field('name', `${t('yourName')} *`, `<input name="name" required maxlength="${M.LIMITS.person}" value="${esc(a.name)}" autocomplete="name">`)}
        ${field('comment', t('commentOptional'), `<input name="comment" maxlength="${M.LIMITS.comment}" value="${esc(a.comment)}" placeholder="${esc(t('commentPh'))}">`)}
        ${
          own
            ? `<details class="fold" ${a.email ? 'open' : ''}>
                <summary>${esc(t('addEmail'))}</summary>
                ${field('email', t('emailOptional'), `<input type="email" name="email" maxlength="${M.LIMITS.email}" value="${esc(a.email)}" autocomplete="email" inputmode="email">`, t('emailHint'))}
              </details>`
            : ''
        }
      </form>
    </section>
    <div class="savebar">
      <button type="button" class="btn" data-act="cancel-answer">${esc(t('cancel'))}</button>
      <button type="button" class="btn primary" data-act="save-answer">${icon('check')}${esc(t('save'))}</button>
    </div>`);
  const form = $<HTMLFormElement>('#answer-form');
  form.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const n = el.name;
    if (n === 'name' || n === 'email' || n === 'comment') {
      a[n] = el.value;
      a.dirty = true;
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveAnswer();
  });
  mountPicker(v);
}

function pickerToolbar(v: M.View): string {
  const ev = v.event;
  const a = answer();
  const parts: string[] = [];
  if (ev.mode === 'dates') {
    parts.push(`<div class="seg">${(['cal', 'list'] as const).map((x) => `<button type="button" class="${a.view === x ? 'on' : ''}" aria-pressed="${a.view === x}" data-act="ans-view" data-v="${x}">${esc(t(`tab.${x}`))}</button>`).join('')}</div>`);
  } else if (ev.settings.maybe) {
    parts.push(`<div class="seg brush" role="radiogroup" aria-label="${esc(t('brush'))}">${(
      [
        [M.YES, 'canCome'],
        [M.MAYBE, 'ifNeedBe'],
      ] as const
    )
      .map(([b, k]) => `<button type="button" role="radio" aria-checked="${a.brush === b}" class="b${b}${a.brush === b ? ' on' : ''}" data-act="ans-brush" data-b="${b}"><i class="sw"></i>${esc(t(k))}</button>`)
      .join('')}</div>`);
  }
  // Kept together, so on a narrow screen they wrap as a pair.
  parts.push(`<span class="tb-end">
    <button type="button" class="btn small" data-act="ans-all">${esc(t('yesToAll'))}</button>
    <button type="button" class="btn small" data-act="ans-clear">${esc(t('clearAll'))}</button>
  </span>`);
  return parts.join('');
}

const answerWord = (val: number) => t(val === M.YES ? 'yes' : val === M.MAYBE ? 'maybe' : 'no');

// val: 0 no, 1 yes, 2 maybe.
function setAns(k: string, val: number): void {
  const a = answer();
  if (val) a.answers[k] = val as M.Answer;
  else delete a.answers[k];
  a.dirty = true;
}

function mountPicker(v: M.View): void {
  const ev = v.event;
  const a = answer();
  const area = $('#pick-area');
  const cycle = (x: number): number => (x === 0 ? M.YES : x === M.YES && ev.settings.maybe ? M.MAYBE : 0);
  if (ev.mode === 'times') {
    const opts = new Set(ev.options);
    new TimeGrid(area, {
      mode: 'paint',
      dates: M.optionDates(ev),
      mins: rowsFor(ev),
      rowh: rowHeight(ev.slot),
      allowed: (k) => opts.has(k),
      value: (k) => a.answers[k] || 0,
      brush: () => a.brush,
      onPaint: (keys, val) => {
        for (const k of keys) setAns(k, val);
        updatePickSum();
      },
      onDay: (date) => answerDayMenu(date),
    });
  } else if (a.view === 'list') {
    const choices: [number, Key][] = [[M.YES, 'yes'], ...(ev.settings.maybe ? [[M.MAYBE, 'maybe'] as [number, Key]] : []), [0, 'no']];
    area.innerHTML = `<ul class="ans-list">${ev.options
      .map((k) => {
        const cur = a.answers[k] || 0;
        return `<li><span>${esc(cap(fmtDate(k, 'long')))}</span><div class="seg tri" role="group" aria-label="${esc(fmtDate(k, 'long'))}">${choices
          .map(([val, key]) => `<button type="button" class="c${val}${cur === val ? ' on' : ''}" aria-pressed="${cur === val}" data-act="ans-set" data-k="${k}" data-val="${val}">${esc(t(key))}</button>`)
          .join('')}</div></li>`;
      })
      .join('')}</ul>`;
  } else {
    const opts = new Set(ev.options);
    const ds = M.optionDates(ev);
    const label = (x: string, val: number) => `${fmtDate(x, 'long')}: ${answerWord(val)}`;
    const legend = ([[M.YES, 'canCome'], ...(ev.settings.maybe ? [[M.MAYBE, 'ifNeedBe']] : []), [0, 'cannot']] as [number, Key][])
      .map(([val, key]) => `<span><i class="sw a${val}"></i>${esc(t(key))}</span>`)
      .join('');
    area.innerHTML = `<p class="ans-legend">${legend}</p><p class="cal-tip muted small">${esc(t(touch() ? 'rangeHintTouch' : 'rangeHint'))}</p>${calendarHtml({
      start: ds[0],
      end: ds[ds.length - 1],
      dayHtml: (x) => {
        if (!opts.has(x)) return `<span class="cal-day off">${Number(x.slice(8))}</span>`;
        const val = a.answers[x] || 0;
        return `<button type="button" class="cal-day ans a${val}" data-d="${x}" aria-label="${esc(label(x, val))}">${Number(x.slice(8))}</button>`;
      },
    })}`;
    bindPaint(area, '.cal-day[data-d]', {
      get: (el) => a.answers[data(el, 'd')] || 0,
      next: (el) => cycle(a.answers[data(el, 'd')] || 0),
      apply: (el, val) => {
        setAns(data(el, 'd'), val);
        el.className = `cal-day ans a${val}`;
        el.setAttribute('aria-label', label(data(el, 'd'), val));
      },
      done: updatePickSum,
    });
  }
  updatePickSum();
}

async function answerDayMenu(date: string): Promise<void> {
  const ev = current().event;
  const items: MenuItem[] = [{ id: String(M.YES), label: t('dayYes') }];
  if (ev.settings.maybe) items.push({ id: String(M.MAYBE), label: t('dayMaybe') });
  items.push({ id: '0', label: t('dayNone') });
  const r = await menu(cap(fmtDate(date, 'long')), items);
  if (r === '') return;
  for (const k of ev.options) if (k.startsWith(date)) setAns(k, Number(r));
  render();
}

function updatePickSum(): void {
  const ev = current().event;
  const a = answer();
  let y = 0;
  let m = 0;
  for (const k of ev.options) {
    if (a.answers[k] === M.YES) y += 1;
    else if (a.answers[k] === M.MAYBE) m += 1;
  }
  let s =
    ev.mode === 'dates'
      ? `${t('pickSumDates', { n: y, m: ev.options.length })}${m ? ` · ${t('nMaybe', { n: m })}` : ''}`
      : `${t('pickSumTimes', { dur: durationLabel(y * ev.slot) })}${m ? ` · ${t('maybeDur', { dur: durationLabel(m * ev.slot) })}` : ''}`;
  if (!y && !m) s = t('pickSumNone');
  const el = $opt('#pick-sum');
  if (el) el.textContent = s;
}

async function saveAnswer(): Promise<void> {
  if (app.busy) return;
  const v = current();
  const a = answer();
  const { id, token } = here();
  const name = a.name.trim();
  if (!name) {
    toast(t('err.personName'));
    $opt('#answer-form [name="name"]')?.focus();
    return;
  }
  const body: { name: string; comment: string; answers: M.Answers; email?: string } = { name, comment: a.comment, answers: a.answers };
  if (a.own) {
    if (!M.cleanEmail(a.email).ok) {
      toast(t('err.email'));
      $opt('#answer-form [name="email"]')?.focus();
      return;
    }
    body.email = a.email;
  }
  setBusy(true);
  try {
    if (a.pid) {
      const { view } = await api<{ view: M.View }>('PUT', `/events/${id}/people/${a.pid}`, { token, body });
      setView(view);
      app.answer = null;
      toast(t('saved'));
      closeSub();
    } else {
      const r = await api<M.Added>('POST', `/events/${id}/people`, { token, body });
      app.answer = null;
      if (v.role === 'admin') {
        setView(r.view);
        if (!store.get(id)?.pid) store.put(id, { me: r.token, pid: r.pid });
        closeSub();
        linkDialog(t('personLinkTitle', { name }), t('addedByAdminText'), linkUrl(id, r.token));
      } else {
        store.put(id, { name: v.event.name, me: r.token, pid: r.pid });
        app.flash = { kind: 'savedNew', name };
        setView(r.view, id, r.token);
        go(`/e/${id}/${r.token}`, true);
      }
    }
  } catch (e) {
    toast(errText(e));
  } finally {
    setBusy(false);
  }
}

// --- Actions --------------------------------------------------------------------------------

function linkDialog(title: string, text: string, url: string): Promise<string> {
  return dialog(`
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    ${linkBox(url, { share: true })}
    <div class="row end"><button value="" class="btn primary">${esc(t('done'))}</button></div>`);
}

async function deleteEntry(pid: string): Promise<void> {
  const v = current();
  const { id, token } = here();
  const p = v.people.find((x) => x.id === pid);
  if (!p) return;
  const own = pid === v.me;
  if (!(await ask(own ? t('deleteMineQ') : t('deleteEntryQ', { name: p.name }), { ok: t('delete'), danger: true }))) return;
  try {
    const { view } = await api<{ view: M.View }>('DELETE', `/events/${id}/people/${pid}`, { token });
    if (store.get(id)?.pid === pid) store.forgetMe(id);
    toast(t('deleted'));
    if (own) {
      setView(view, id, null);
      go(`/e/${id}`, true);
    } else {
      setView(view);
      render();
    }
  } catch (e) {
    toast(errText(e));
  }
}

async function personLink(pid: string): Promise<void> {
  const { id, token } = here();
  const p = current().people.find((x) => x.id === pid);
  try {
    const r = await api<{ token: string }>('POST', `/events/${id}/people/${pid}/link`, { token, body: { reset: false } });
    linkDialog(t('personLinkTitle', { name: p?.name ?? '' }), t('personLinkText'), linkUrl(id, r.token));
  } catch (e) {
    toast(errText(e));
  }
}

// The admin picks the final date or time (key), or undoes it (null). Picking
// also closes the event for new answers.
async function decide(key: string | null): Promise<void> {
  const ev = current().event;
  const { id, token } = here();
  const q = key ? t('decideQ', { when: whenLabel(ev, key) }) : t('undecideQ');
  if (!(await ask(q, { ok: t(key ? 'decideOk' : 'undoDecision') }))) return;
  try {
    const settings = key ? { ...ev.settings, closed: true } : ev.settings;
    const body = { event: { ...ev, settings, decided: key ?? undefined } };
    const { view } = await api<{ view: M.View }>('PUT', `/events/${id}`, { token, body });
    setView(view);
    render();
    toast(t(key ? 'decidedToast' : 'undecidedToast'));
    if (key) window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    toast(errText(e));
  }
}

function downloadIcs(): void {
  const ev = current().event;
  const { id } = here();
  const ics = icsFor(ev, id, eventUrl(id));
  if (!ics) return;
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = icsName(ev.name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function toggleClosed(): Promise<void> {
  const ev = current().event;
  const { id, token } = here();
  try {
    const body = { event: { ...ev, settings: { ...ev.settings, closed: !ev.settings.closed } } };
    const { view } = await api<{ view: M.View }>('PUT', `/events/${id}`, { token, body });
    setView(view);
    render();
    toast(t(view.event.settings.closed ? 'closedToast' : 'reopenedToast'));
  } catch (e) {
    toast(errText(e));
  }
}

// A new link for the admin or yourself: the old one stops working.
async function swapLink(path: string, body: unknown, patch: (token: string) => Partial<Stored>, title: string, text: string): Promise<void> {
  const { id, token } = here();
  try {
    const r = await api<{ token: string }>('POST', path, { token, body });
    store.put(id, patch(r.token));
    app.viewKey = `${id}/${r.token}`;
    history.replaceState(null, '', `/e/${id}/${r.token}`);
    render();
    linkDialog(title, text, linkUrl(id, r.token));
  } catch (e) {
    toast(errText(e));
  }
}

async function adminMore(): Promise<void> {
  const { id, token } = here();
  const r = await menu(t('adminMenu'), [
    { id: 'reset', label: t('newAdminLink'), hint: t('newAdminLinkHint') },
    { id: 'delete', label: t('deleteEvent'), hint: t('deleteEventHint'), danger: true },
  ]);
  if (r === 'reset') {
    if (!(await ask(t('newAdminLinkQ'), { ok: t('makeNewLink') }))) return;
    await swapLink(`/events/${id}/admin-link`, undefined, (tok) => ({ admin: tok }), t('newLinkDone'), t('newAdminLinkDoneText'));
  } else if (r === 'delete') {
    if (!(await ask(t('deleteEventQ'), { ok: t('deleteEvent'), danger: true }))) return;
    try {
      await api('DELETE', `/events/${id}`, { token });
      store.forget(id);
      app.view = null;
      app.viewKey = null;
      go('/', true);
      toast(t('eventDeleted'));
    } catch (e) {
      toast(errText(e));
    }
  }
}

async function meMore(): Promise<void> {
  const me = current().me;
  const { id } = here();
  if (!me) return;
  const r = await menu(t('meMenu'), [
    { id: 'reset', label: t('newMyLink'), hint: t('newMyLinkHint') },
    { id: 'delete', label: t('deleteMine'), danger: true },
  ]);
  if (r === 'reset') {
    if (!(await ask(t('newMyLinkQ'), { ok: t('makeNewLink') }))) return;
    await swapLink(`/events/${id}/people/${me}/link`, { reset: true }, (tok) => ({ me: tok, pid: me }), t('newLinkDone'), t('newMyLinkDoneText'));
  } else if (r === 'delete') deleteEntry(me);
}

// The dialog menu, for browsers without popovers.
async function pickTheme(): Promise<void> {
  const cur = store.getTheme();
  setTheme(
    await menu(
      t('theme'),
      THEMES.map((x) => ({ id: x, label: t(`theme.${x}`), hint: x === 'auto' ? t('theme.autoHint') : undefined, on: x === cur })),
    ),
  );
}

// Only the attribute on <html> changes, and the menu's marks: no render, so
// a half-filled form stays as it is.
function setTheme(x: string): void {
  if (!isTheme(x)) return;
  store.setTheme(x);
  applyTheme(x);
  const m = $opt('#theme-menu');
  if (m) m.innerHTML = themeItems();
  $opt('.theme-btn')?.setAttribute('aria-label', themeLabel());
}

function switchLang(l: string): void {
  if (!isLang(l) || l === getLang()) return;
  setLang(l);
  store.setLang(l);
  render();
}

// data-act="<name>" -> what a click on it does.
const actions: Record<string, (b: HTMLElement) => unknown> = {
  lang: (b) => {
    $opt('#lang-menu')?.hidePopover();
    switchLang(data(b, 'lang'));
  },
  'lang-pick': async () => switchLang(await menu(t('language'), LANGS.map((l) => ({ id: l, label: LANG_NAMES[l], on: l === getLang() })))),
  theme: () => pickTheme(),
  'events-pick': () => pickEvent(),
  'find-again': () => askCode(find.email, true),
  'find-other': () => {
    find.sent = false;
    renderFind();
  },
  'theme-set': (b) => {
    $opt('#theme-menu')?.hidePopover();
    setTheme(data(b, 'theme'));
  },
  retry: () => {
    app.viewKey = null;
    render();
  },
  copy: (b) => copyText(data(b, 'url')),
  share: (b) => shareUrl(data(b, 'url'), b.dataset.title || app.view?.event.name || t('appName')),
  qr: (b) =>
    dialog(`<h3>${esc(t('qrTitle'))}</h3>${qrSvg(data(b, 'url'))}<p class="muted small center">${esc(b.dataset.url)}</p><div class="row end"><button value="" class="btn primary">${esc(t('done'))}</button></div>`),
  forget: (b) => {
    store.forget(data(b, 'id'));
    render();
  },
  decide: (b) => decide(data(b, 'k')),
  undecide: () => decide(null),
  ics: () => downloadIcs(),
  'close-sub': async () => {
    if (await leaveOk()) closeSub();
  },

  // Event form
  period: (b) => {
    changed();
    const d = draft();
    const days = periodDays(data(b, 'p') as Period);
    selectDates(d, [...d.dates], false);
    selectDates(d, days, true);
    const last = days[days.length - 1];
    if (last > d.until) d.until = M.monthEnd(last);
    refreshDays();
    refreshTimes();
  },
  'more-months': () => {
    const d = draft();
    d.until = M.monthEnd(d.until, 1);
    refreshDays();
  },
  'sel-none': () => {
    changed();
    const d = draft();
    selectDates(d, [...d.dates], false);
    refreshDays();
    refreshTimes();
  },
  'sel-group': (b) => selectGroup(groupDays(data(b, 'g'))),
  'sel-wd': (b) => selectGroup(scopeDays().filter((x) => M.weekday(x) === Number(b.dataset.wd))),
  week: (b) => {
    const scope = new Set(scopeDays());
    selectGroup([0, 1, 2, 3, 4, 5, 6].map((i) => M.addDays(data(b, 'mon'), i)).filter((x) => scope.has(x)));
  },
  preset: (b) => applyPreset(data(b, 'p') as Preset),

  // Event page
  answer: () => openSub('answer'),
  'edit-event': () => openSub('edit'),
  'edit-entry': (b) => openSub(`answer=${b.dataset.pid}`),
  'delete-entry': (b) => deleteEntry(data(b, 'pid')),
  'person-link': (b) => personLink(data(b, 'pid')),
  'toggle-closed': () => toggleClosed(),
  'admin-more': () => adminMore(),
  'me-more': () => meMore(),
  tab: (b) => {
    app.tab = data(b, 'tab') as Tab;
    app.pick = null;
    render();
  },
  pick: (b) => {
    app.pick = { k: data(b, 'k'), win: b.dataset.win === '1' };
    updateDetail();
    if (b.closest('.best')) $opt('#detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  // Answer editor
  'cancel-answer': async () => {
    if (app.answer?.dirty && !(await ask(t('discardQ'), { ok: t('discard'), danger: true }))) return;
    app.answer = null;
    closeSub();
  },
  'save-answer': () => saveAnswer(),
  'ans-view': (b) => {
    answer().view = data(b, 'v') as AnswerDraft['view'];
    render();
  },
  'ans-brush': (b) => {
    answer().brush = Number(b.dataset.b) as M.Answer;
    $('#pick-tools').innerHTML = pickerToolbar(current());
  },
  'ans-set': (b) => {
    const val = Number(b.dataset.val);
    setAns(data(b, 'k'), val);
    for (const x of b.parentElement?.children ?? []) {
      const on = Number((x as HTMLElement).dataset.val) === val;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
    }
    updatePickSum();
  },
  'ans-all': () => {
    for (const k of current().event.options) setAns(k, M.YES);
    render();
  },
  'ans-clear': () => {
    for (const k of current().event.options) setAns(k, 0);
    render();
  },
};

document.addEventListener('click', (e) => {
  const target = e.target as Element;
  const a = target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
    e.preventDefault();
    const href = a.getAttribute('href') ?? '/';
    leaveOk().then((ok) => ok && go(href));
    return;
  }
  const b = target.closest<HTMLElement>('[data-act]');
  if (!b || (b as HTMLButtonElement).disabled) return;
  const fn = actions[data(b, 'act')];
  if (!fn) return;
  e.preventDefault();
  fn(b);
});

// The header menus (.dropdown popovers): the browser closes them on Esc or
// a click outside, and focuses the current choice (autofocus) when one
// opens. A menu opens under its button, right-aligned with it; the arrow
// keys move between the choices.
const menuOpen = () => {
  try {
    return Boolean($opt('.dropdown:popover-open'));
  } catch {
    return false;
  }
};
document.addEventListener(
  'beforetoggle',
  (e) => {
    const menu = e.target as HTMLElement;
    if (!menu.classList?.contains('dropdown') || (e as ToggleEvent).newState !== 'open') return;
    const btn = $opt(`[popovertarget="${menu.id}"]`);
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.right = `${document.documentElement.clientWidth - r.right - window.scrollX}px`;
  },
  true,
);
document.addEventListener('keydown', (e) => {
  const menu = (e.target as Element).closest?.('.dropdown');
  if (!menu || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End')) return;
  e.preventDefault();
  const items = [...menu.querySelectorAll<HTMLElement>('.menu-item')];
  const i = items.indexOf(e.target as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next].focus();
});

// Closing or reloading the tab with unsaved changes: the browser asks.
window.addEventListener('beforeunload', (e) => {
  if (unsaved()) e.preventDefault();
});

document.addEventListener('focusin', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.matches?.('[data-select]')) el.select();
});

window.addEventListener('popstate', () => {
  app.pushedSub = false;
  render();
});

// Keep the results fresh while the page is open (others answer meanwhile).
async function refreshIfIdle(): Promise<void> {
  const r = app.route;
  if (r?.page !== 'event' || subView().kind !== 'overview' || !app.view || document.visibilityState !== 'visible') return;
  if ($opt('dialog[open]') || menuOpen()) return;
  try {
    const { view } = await api<{ view: M.View }>('GET', `/events/${r.id}`, { token: r.token });
    if (app.route !== r || subView().kind !== 'overview') return;
    if (JSON.stringify(view) !== app.viewJson) {
      setView(view, r.id, r.token);
      render();
    }
  } catch {
    // Offline or gone: keep what we have.
  }
}
setInterval(refreshIfIdle, 30000);
document.addEventListener('visibilitychange', refreshIfIdle);

// The host decides; elsewhere the browser's first Nordic language, even
// after English (many Nordic browsers list English first), else English.
function detectLang(): Lang {
  const host = location.hostname;
  if (host.startsWith('whenever.')) return 'en';
  if (host.startsWith('finn-tid.')) return 'nb';
  const nordic: [RegExp, Lang][] = [[/^(nb|no)\b/i, 'nb'], [/^nn\b/i, 'nn'], [/^sv\b/i, 'sv'], [/^da\b/i, 'da'], [/^is\b/i, 'is']];
  for (const l of navigator.languages ?? [navigator.language]) {
    const hit = nordic.find(([re]) => re.test(l ?? ''));
    if (hit) return hit[1];
  }
  return 'en';
}

setLang(store.getLang() ?? detectLang());
render();
