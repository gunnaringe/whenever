// Whenever / Finn tid: the UI. Plain ES modules, no framework. Each view is an
// HTML string painted into #app; clicks are delegated through data-act.
//
// Routes (path): /  ·  /new  ·  /e/<id>  ·  /e/<id>/<token>
// Sub-views of an event (hash): #answer, #answer=<pid>, #edit

import * as M from '../shared/model.ts';
import { t, tx, getLang, setLang, LANG_NAMES, fmtDate, fmtRange, slotLabel, windowLabel, weekdayShort, weekdayLong, durationLabel, cap } from './i18n.ts';
import type { Key, Lang } from './i18n.ts';
import { api, ApiError } from './api.ts';
import * as store from './store.ts';
import type { Stored } from './store.ts';
import { $, $opt, $$, esc, icon, toast, ask, menu, dialog, copyText, shareUrl, qrSvg } from './ui.ts';
import type { MenuItem } from './ui.ts';
import { calendarHtml, bindPaint } from './calendar.ts';
import { TimeGrid } from './timegrid.ts';

type Route = { page: 'home' } | { page: 'new' } | { page: 'missing' } | { page: 'event'; id: string; token: string | null };
type Sub = { kind: 'overview' } | { kind: 'edit' } | { kind: 'answer'; pid: string | null };
type Tab = 'cal' | 'list' | 'table' | 'grid';
type Flash = { kind: 'created' } | { kind: 'savedNew'; name: string };

// The event form's state while it is open.
interface Draft extends M.DayWindow {
  name: string;
  description: string;
  location: string;
  mode: M.Mode;
  start: string;
  end: string;
  duration: number;
  tz: string;
  settings: M.Settings;
  email: string;
  dates: Set<string>;
  times: Set<string>;
  pattern: Set<number> | null; // times a newly added day gets (null = all)
  rangeError: string | null;
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

// el.dataset[k], '' if missing.
const data = (el: HTMLElement, k: string): string => el.dataset[k] ?? '';
// A form control by name (form.elements.namedItem).
const control = <T = HTMLInputElement>(form: HTMLFormElement, name: string): T => form.elements.namedItem(name) as T;

// A finger is the main pointer (phones, tablets): painting starts with a hold.
const touch = () => matchMedia('(pointer: coarse)').matches;

const eventUrl = (id: string) => `${location.origin}/e/${id}`;
const linkUrl = (id: string, token: string | null) => `${location.origin}/e/${id}/${token}`;

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

function paint(inner: string): void {
  const other: Lang = getLang() === 'nb' ? 'en' : 'nb';
  $('#app').innerHTML = `
    <header class="bar">
      <a class="brand" href="/" data-link><img src="/icons/icon.svg" alt="" width="28" height="28"><span>${esc(t('appName'))}</span></a>
      <span class="grow"></span>
      <button type="button" class="btn ghost small" data-act="lang" lang="${other}">${esc(LANG_NAMES[other])}</button>
    </header>
    <main class="page">${inner}</main>
    <footer class="foot"><a href="/privacy">${esc(t('privacy'))}</a><span aria-hidden="true">·</span><a href="https://apphub.casa">apphub.casa</a></footer>`;
}

const field = (name: string, label: string, control: string, hint = '') =>
  `<label class="field" data-field="${name}"><span class="label">${esc(label)}</span>${control}${hint ? `<small class="hint">${esc(hint)}</small>` : ''}</label>`;

const linkBox = (url: string, { share = false, qr = false, label = t('link'), title = '' } = {}) => `
  <div class="linkbox">
    <input readonly value="${esc(url)}" aria-label="${esc(label)}" data-select>
    <button type="button" class="btn small" data-act="copy" data-url="${esc(url)}">${icon('copy')}${esc(t('copy'))}</button>
    ${share ? `<button type="button" class="btn small" data-act="share" data-url="${esc(url)}" data-title="${esc(title)}">${icon('share')}${esc(t('share'))}</button>` : ''}
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
    app.where = where;
    app.draft = null;
    app.answer = null;
    app.pick = null;
    window.scrollTo(0, 0);
  }
  app.formGrid = null;
  app.resGrid = null;
  app.refreshResGrid = null;

  if (r.page === 'home') return renderHome();
  if (r.page === 'new') return renderForm(null);
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
    </section>
    ${mine.length ? `<section class="card"><h2>${esc(t('yourEvents'))}</h2><ul class="mine">${mine.map(row).join('')}</ul><p class="muted small">${esc(t('yourEventsHint'))}</p></section>` : ''}
    <section class="steps">
      ${([1, 2, 3] as const).map((i) => `<div class="step"><span class="num">${i}</span><div><b>${esc(t(`step${i}`))}</b><p>${esc(t(`step${i}Text`))}</p></div></div>`).join('')}
    </section>`);
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
  const start = M.localToday();
  const end = M.addDays(start, 27);
  return {
    name: '',
    description: '',
    location: '',
    mode: 'dates',
    start,
    end,
    slot: 30,
    dayStart: 480,
    dayEnd: 1320,
    duration: 60,
    tz: browserTz(),
    settings: { ...M.DEFAULT_SETTINGS },
    email: '',
    dates: new Set(M.dateRange(start, end)),
    times: new Set(),
    pattern: null,
    rangeError: null,
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
    start: ev.start,
    end: ev.end,
    settings: { ...ev.settings },
    email: v.adminEmail ?? '',
  });
  if (ev.mode === 'times') {
    Object.assign(d, { slot: ev.slot, dayStart: ev.dayStart, dayEnd: ev.dayEnd, duration: ev.duration, tz: ev.tz });
    d.times = new Set(ev.options);
    d.dates = new Set(M.optionDates(ev));
  } else {
    d.dates = new Set(ev.options);
  }
  return d;
}

// What the form would send (sanitizeEvent checks it like the server does).
function draftToEvent(d: Draft): Record<string, unknown> & { options: string[] } {
  const ev = { name: d.name, description: d.description, location: d.location, mode: d.mode, start: d.start, end: d.end, settings: { ...d.settings } };
  if (d.mode === 'dates') return { ...ev, options: [...d.dates].sort() };
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

function rangeError(start: string, end: string, mode: M.Mode): string | null {
  if (!M.isDate(start) || !M.isDate(end) || end < start) return 'range';
  const n = M.diffDays(start, end) + 1;
  if (mode === 'times' && n > M.LIMITS.daysTimes) return 'rangeLongTimes';
  if (n > M.LIMITS.daysDates) return 'rangeLong';
  return null;
}

// Days leaving the range drop out; days joining it are selected unless every
// day of that weekday was unselected (so "no weekends" survives a longer range).
function setRange(d: Draft, start: string, end: string): void {
  const oldDays = M.dateRange(d.start, d.end);
  const old = new Set(oldDays);
  const states = [0, 1, 2, 3, 4, 5, 6].map((wd) => M.weekdayState(d.dates, oldDays, wd));
  const days = M.dateRange(start, end);
  const inRange = new Set(days);
  for (const x of [...d.dates]) if (!inRange.has(x)) d.dates.delete(x);
  d.start = start;
  d.end = end;
  selectDates(d, days.filter((x) => !old.has(x) && states[M.weekday(x)] !== 'none'), true);
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
    <label class="check">
      <input type="checkbox" name="s-${key}" ${d.settings[key] ? 'checked' : ''} ${key === 'openEdit' && d.settings.hidden ? 'disabled' : ''}>
      <span><b>${esc(t(`set.${key}`))}</b><small>${esc(t(`set.${key}Hint`))}</small></span>
    </label>`;
  paint(`
    <form id="ev-form" class="stack" novalidate>
      ${editing ? `<a class="back" href="${esc(location.pathname)}" data-act="close-sub">${icon('back')}${esc(t('back'))}</a>` : ''}
      <h1>${esc(t(editing ? 'editEvent' : 'newEvent'))}</h1>
      <section class="card">
        <h2>${esc(t('aboutEvent'))}</h2>
        ${field('name', `${t('eventName')} *`, `<input name="name" maxlength="${M.LIMITS.name}" required value="${esc(d.name)}" placeholder="${esc(t('eventNamePh'))}" autocomplete="off">`)}
        ${field('description', t('descriptionOptional'), `<textarea name="description" rows="3" maxlength="${M.LIMITS.description}">${esc(d.description)}</textarea>`)}
        ${field('location', t('locationOptional'), `<input name="location" maxlength="${M.LIMITS.location}" value="${esc(d.location)}" autocomplete="off">`)}
      </section>
      <section class="card">
        <h2>${esc(t('whatToFind'))}</h2>
        <div class="choice">${modeCard('dates')}${modeCard('times')}</div>
        <div class="grid2">
          ${field('start', t('earliest'), `<input type="date" name="start" value="${d.start}" required>`)}
          ${field('end', t('latest'), `<input type="date" name="end" value="${d.end}" required>`)}
        </div>
        <p class="err" id="range-err" ${d.rangeError ? '' : 'hidden'}>${d.rangeError ? esc(tx(`err.${d.rangeError}`)) : ''}</p>
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
        <p id="f-count" class="count-line" aria-live="polite"></p>
      </section>
      <section class="card" id="times-card" ${d.mode === 'times' ? '' : 'hidden'}>
        <h2>${esc(t('possibleTimes'))}</h2>
        <p class="muted">${esc(t(touch() ? 'possibleTimesHintTouch' : 'possibleTimesHint'))}</p>
        <div class="chip-row">${(Object.keys(PRESETS) as Preset[]).map((p) => `<button type="button" class="btn small" data-act="preset" data-p="${p}">${esc(t(`preset.${p}`))}</button>`).join('')}</div>
        <div id="f-grid"></div>
      </section>
      <section class="card">
        <h2>${esc(t('settings'))}</h2>
        ${check('maybe')}${check('openEdit')}${check('hidden')}${editing ? check('closed') : ''}
      </section>
      <section class="card">
        <h2>${esc(t('yourEmailTitle'))}</h2>
        ${field('email', t('emailOptional'), `<input type="email" name="email" maxlength="${M.LIMITS.email}" value="${esc(d.email)}" autocomplete="email" inputmode="email">`, t('adminEmailHint'))}
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
  });
  // Enter in a text field shouldn't create the event by accident.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as Element).matches('input')) e.preventDefault();
  });
  form.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    const n = el.name;
    if (n === 'mode') setMode(el.value as M.Mode);
    else if (n === 'start' || n === 'end') changeRange(n);
    else if (n === 'dayStart' || n === 'dayEnd' || n === 'slot') changeWindow(n);
    else if (n === 'duration') d.duration = Number(el.value);
    else if (n === 'tz') d.tz = el.value;
    else if (n.startsWith('s-')) {
      d.settings[n.slice(2) as keyof M.Settings] = el.checked;
      if (n === 's-hidden') {
        if (el.checked) d.settings.openEdit = false;
        const openEdit = control(form, 's-openEdit');
        openEdit.checked = d.settings.openEdit;
        openEdit.disabled = el.checked;
      }
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitForm();
  });
  bindPaint($('#f-cal'), '.cal-day[data-d]', {
    next: (el) => !d.dates.has(data(el, 'd')),
    apply: (el, on) => {
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

function showRangeError(err: string | null): void {
  draft().rangeError = err;
  const el = $('#range-err');
  el.hidden = !err;
  el.textContent = err ? tx(`err.${err}`) : '';
}

function setMode(mode: M.Mode): void {
  const d = draft();
  d.mode = mode;
  if (mode === 'times') for (const date of d.dates) if (!hasTimes(d, date)) fillDate(d, date);
  showRangeError(rangeError(d.start, d.end, mode));
  $('#times-opts').hidden = mode !== 'times';
  $('#times-card').hidden = mode !== 'times';
  refreshCount();
  refreshTimes();
}

function changeRange(which: 'start' | 'end'): void {
  const d = draft();
  const form = $<HTMLFormElement>('#ev-form');
  const start = control(form, 'start').value;
  let end = control(form, 'end').value;
  // Moving the start past the end keeps the length of the range.
  if (which === 'start' && M.isDate(start) && M.isDate(end) && end < start) {
    end = M.addDays(start, Math.max(0, M.diffDays(d.start, d.end)));
    control(form, 'end').value = end;
  }
  const err = rangeError(start, end, d.mode);
  showRangeError(err);
  if (err) return;
  setRange(d, start, end);
  refreshDays();
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

function refreshDays(): void {
  const d = draft();
  const hol = M.holidaysIn(d.start, d.end);
  $('#f-cal').innerHTML = calendarHtml({
    start: d.start,
    end: d.end,
    weekHtml: (mon, wk) => `<button type="button" class="cal-wk" data-act="week" data-mon="${mon}" title="${esc(t('toggleWeek', { n: wk }))}" aria-label="${esc(t('toggleWeek', { n: wk }))}">${wk}</button>`,
    dayHtml: (x) => {
      const on = d.dates.has(x);
      const h = hol.get(x);
      const name = h ? tx(`holiday.${h}`) : '';
      return `<button type="button" class="cal-day pick${on ? ' on' : ''}${h ? ' hol' : ''}${M.isWeekend(x) ? ' we' : ''}" data-d="${x}" aria-pressed="${on}" aria-label="${esc(fmtDate(x, 'long'))}${name ? ` (${esc(name)})` : ''}"${name ? ` title="${esc(name)}"` : ''}>${Number(x.slice(8))}</button>`;
    },
  });
  refreshChips();
  refreshCount();
}

function rangeDays(): string[] {
  const d = draft();
  return M.dateRange(d.start, d.end);
}

function groupDays(g: string): string[] {
  const d = draft();
  const days = rangeDays();
  if (g === 'weekdays') return days.filter((x) => !M.isWeekend(x));
  if (g === 'weekends') return days.filter(M.isWeekend);
  if (g === 'holidays') {
    const hol = M.holidaysIn(d.start, d.end);
    return days.filter((x) => hol.has(x));
  }
  return days;
}

function refreshChips(): void {
  const d = draft();
  const days = rangeDays();
  const short = weekdayShort();
  const long = weekdayLong();
  const chip = (attrs: string, label: string, state: M.ChipState, title: string) => `
    <button type="button" class="chip st-${state}" ${attrs} ${state === 'empty' ? 'disabled' : ''}
      aria-pressed="${state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}" title="${esc(title)}">${state === 'all' ? icon('check') : state === 'some' ? icon('minus') : ''}${esc(label)}</button>`;
  $('#f-chips').innerHTML = `
    <div class="chip-row">
      <button type="button" class="btn small" data-act="sel-all">${esc(t('selAll'))}</button>
      <button type="button" class="btn small" data-act="sel-none">${esc(t('selNone'))}</button>
      ${(['weekdays', 'weekends', 'holidays'] as const).map((g) => chip(`data-act="sel-group" data-g="${g}"`, t(g), M.groupState(d.dates, groupDays(g)), t(`${g}Hint`))).join('')}
    </div>
    <div class="chip-row wd">${short.map((n, wd) => chip(`data-act="sel-wd" data-wd="${wd}"`, n, M.weekdayState(d.dates, days, wd), t('weekdayHint', { day: long[wd] }))).join('')}</div>`;
}

function refreshCount(): void {
  const d = draft();
  let s = t('nDays', { n: d.dates.size });
  if (d.mode === 'times') {
    const valid = new Set(M.allKeys(d));
    const n = draftToEvent(d).options.filter((k) => valid.has(k)).length;
    s += ` · ${t('nSlots', { n })}`;
    const empty = [...d.dates].filter((x) => !M.daySlots(d).some((m) => d.times.has(M.slotKey(x, m)))).length;
    if (empty) s += ` · ${t('nDaysNoTimes', { n: empty })}`;
  }
  $('#f-count').textContent = s;
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
  const d = draft();
  const [from, to] = PRESETS[p];
  d.pattern = p === 'all' ? null : marks(from, to);
  const mins = M.daySlots(d).filter((m) => m >= from && m + d.slot <= to);
  for (const x of d.dates) setDateTimes(d, x, mins);
  refreshCount();
  refreshTimes();
}

function selectGroup(list: string[]): void {
  const d = draft();
  selectDates(d, list, M.groupState(d.dates, list) !== 'all');
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
  const re = rangeError(d.start, d.end, d.mode);
  if (re) return fail(tx(`err.${re}`), control(form, 'start'));
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
      setView(view);
      toast(t('saved'));
      closeSub();
    } else {
      const res = await api<M.Created>('POST', '/events', { body: { event: r.event, email: em.email } });
      store.put(res.id, { name: r.event.name, admin: res.token });
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

const heat = (g: M.Tally, n: number): string => (n ? ((g.yes.length + g.maybe.length * 0.5) / n).toFixed(3) : '0');
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
  paint(`
    ${flashHtml()}
    ${noticesHtml(v, stored)}
    ${headHtml(v)}
    ${actionsHtml(v)}
    ${v.role === 'admin' ? shareHtml(v) : ''}
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
        ${add ? `<button type="button" class="btn primary" data-act="answer">${icon('plus')}${esc(t('addAnswers'))}</button>` : ''}
        <button type="button" class="btn" data-act="edit-event">${icon('edit')}${esc(t('editEvent'))}</button>
        <button type="button" class="btn" data-act="toggle-closed">${icon('lock')}${esc(t(ev.settings.closed ? 'reopen' : 'close'))}</button>
        <button type="button" class="btn" data-act="admin-more" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('dots')}</button>
      </div>
    </section>`;
  }
  if (v.role === 'participant') {
    const me = v.people.find((p) => p.id === v.me);
    return `<section class="card role">
      <div class="role-text"><b>${esc(t('hiName', { name: me?.name ?? '' }))}</b><p class="muted">${esc(t('personalHint'))}</p></div>
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
    ${linkBox(eventUrl(id), { share: true, qr: true, label: t('eventLink'), title: v.event.name })}
    <h3>${icon('key')}${esc(t('adminLinkTitle'))}</h3>
    <p class="muted">${esc(t('adminLinkHint'))}</p>
    ${linkBox(linkUrl(id, token), { label: t('adminLinkTitle') })}
  </details>`;
}

function bestHtml(v: M.View): string {
  const ev = v.event;
  const n = v.people.length;
  if (!n) return '';
  const best: (M.Tally | M.TimeWindow)[] = ev.mode === 'dates' ? M.bestOptions(ev, v.people, 3) : M.bestWindows(ev, v.people, 3);
  if (!best.length) return `<p class="muted">${esc(t('noneAvailable'))}</p>`;
  return `<ol class="best">${best
    .map(
      (b, i) => `<li><button type="button" class="best-item${app.pick?.k === b.key ? ' sel' : ''}" data-act="pick" data-k="${b.key}" ${ev.mode === 'times' ? 'data-win="1"' : ''}>
        <span class="rank">${i + 1}</span>
        <span class="bl">${esc(cap('date' in b ? windowLabel(b) : fmtDate(b.key, 'long')))}</span>
        <span class="bn">${esc(t('nOfM', { n: M.available(b), m: n }))}${b.maybe.length ? ` · ${esc(t('nMaybe', { n: b.maybe.length }))}` : ''}</span>
      </button></li>`,
    )
    .join('')}</ol>`;
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
      <span class="rn">${M.available(g)}/${n}</span>
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
      <tfoot><tr><th scope="row" class="name">${esc(t('sum'))}</th>${ev.options.map((k) => `<td>${M.available(at(k))}</td>`).join('')}</tr></tfoot>
    </table></div>`;
  }

  const opts = new Set(ev.options);
  const ds = M.optionDates(ev);
  const top = new Set(M.bestOptions(ev, v.people, 1).map((b) => b.key));
  return calendarHtml({
    start: ev.start,
    end: ev.end,
    months: M.monthsBetween(ds[0], ds[ds.length - 1]),
    dayHtml: (x) => {
      if (!opts.has(x)) return `<span class="cal-day off">${Number(x.slice(8))}</span>`;
      const g = at(x);
      const a = M.available(g);
      const h = heat(g, n);
      return `<button type="button" class="cal-day res${hi(h)}${top.has(x) ? ' top' : ''}${app.pick?.k === x ? ' sel' : ''}" style="--h:${h}" data-act="pick" data-k="${x}" aria-label="${esc(fmtDate(x, 'long'))}: ${esc(t('nOfM', { n: a, m: n }))}"><span class="dn">${Number(x.slice(8))}</span><span class="dc">${a || ''}</span></button>`;
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
  </div>`;
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
  const topKeys = new Set(M.bestWindows(ev, v.people, 1)[0]?.keys ?? []);
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
      const a = M.available(g);
      const h = heat(g, n);
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
    <section class="card">
      <form id="answer-form" novalidate>
        ${field('name', `${t('yourName')} *`, `<input name="name" required maxlength="${M.LIMITS.person}" value="${esc(a.name)}" autocomplete="name">`)}
        ${own ? field('email', t('emailOptional'), `<input type="email" name="email" maxlength="${M.LIMITS.email}" value="${esc(a.email)}" autocomplete="email" inputmode="email">`, t('emailHint')) : ''}
        ${field('comment', t('commentOptional'), `<input name="comment" maxlength="${M.LIMITS.comment}" value="${esc(a.comment)}" placeholder="${esc(t('commentPh'))}">`)}
      </form>
    </section>
    <section class="card picker">
      <h2>${esc(t(ev.mode === 'dates' ? 'whichDays' : 'whichTimes'))}</h2>
      <p class="muted">${esc(t(hint))}</p>
      <div class="toolbar" id="pick-tools">${pickerToolbar(v)}</div>
      <div id="pick-area"></div>
      <p id="pick-sum" class="count-line" aria-live="polite"></p>
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
  parts.push('<span class="grow"></span>');
  parts.push(`<button type="button" class="btn small" data-act="ans-all">${esc(t('yesToAll'))}</button>`);
  parts.push(`<button type="button" class="btn small" data-act="ans-clear">${esc(t('clearAll'))}</button>`);
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
    area.innerHTML = calendarHtml({
      start: ev.start,
      end: ev.end,
      months: M.monthsBetween(ds[0], ds[ds.length - 1]),
      dayHtml: (x) => {
        if (!opts.has(x)) return `<span class="cal-day off">${Number(x.slice(8))}</span>`;
        const val = a.answers[x] || 0;
        return `<button type="button" class="cal-day ans a${val}" data-d="${x}" aria-label="${esc(label(x, val))}">${Number(x.slice(8))}</button>`;
      },
    });
    bindPaint(area, '.cal-day[data-d]', {
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

// data-act="<name>" -> what a click on it does.
const actions: Record<string, (b: HTMLElement) => unknown> = {
  lang: () => {
    const next: Lang = getLang() === 'nb' ? 'en' : 'nb';
    setLang(next);
    store.setLang(next);
    render();
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
  'close-sub': () => closeSub(),

  // Event form
  'sel-all': () => {
    selectDates(draft(), rangeDays(), true);
    refreshDays();
    refreshTimes();
  },
  'sel-none': () => {
    selectDates(draft(), rangeDays(), false);
    refreshDays();
    refreshTimes();
  },
  'sel-group': (b) => selectGroup(groupDays(data(b, 'g'))),
  'sel-wd': (b) => selectGroup(rangeDays().filter((x) => M.weekday(x) === Number(b.dataset.wd))),
  week: (b) => {
    const d = draft();
    selectGroup([0, 1, 2, 3, 4, 5, 6].map((i) => M.addDays(data(b, 'mon'), i)).filter((x) => x >= d.start && x <= d.end));
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
    go(a.getAttribute('href') ?? '/');
    return;
  }
  const b = target.closest<HTMLElement>('[data-act]');
  if (!b || (b as HTMLButtonElement).disabled) return;
  const fn = actions[data(b, 'act')];
  if (!fn) return;
  e.preventDefault();
  fn(b);
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
  if ($opt('dialog[open]')) return;
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

function detectLang(): Lang {
  const host = location.hostname;
  if (host.startsWith('whenever.')) return 'en';
  if (host.startsWith('finn-tid.')) return 'nb';
  const langs = navigator.languages ?? [navigator.language];
  return langs.some((l) => /^(nb|nn|no)\b/i.test(l ?? '')) ? 'nb' : 'en';
}

setLang(store.getLang() ?? detectLang());
render();
