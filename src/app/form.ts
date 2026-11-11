// The event form: making an event and changing it. Days are picked in a
// calendar and, in times mode, each day's times in a grid, with undo and
// redo.

import * as M from '../shared/model.ts';
import { t, tx, holidayNames, fmtDate, fmtRange, monthName, weekdayShort, weekdayLong, durationLabel, cap } from './i18n.ts';
import { api } from './api.ts';
import * as store from './store.ts';
import { $, $opt, $$, esc, icon, toast, hideToast, ask, menu } from './ui.ts';
import { calendarHtml, bindPaint } from './calendar.ts';
import { TimeGrid, weekPages } from './timegrid.ts';
import { History } from './history.ts';
import type { Snap } from './history.ts';
import { type Draft, app, here, draft, data, control, touch, guessHolidays, browserTz, errText } from './state.ts';
import { eventPath, subUrl, go, closeSub } from './route.ts';
import { paint, field, setBusy } from './shell.ts';
import { setView } from './render.ts';

export type Preset = 'all' | 'work' | 'evening' | 'clear';
const PRESETS: Record<Preset, [number, number]> = { all: [0, 1440], work: [540, 1020], evening: [1020, 1320], clear: [0, 0] };
const DURATIONS = [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720];
export const rowHeight = (slot: number) => (slot === 15 ? 14 : slot === 30 ? 20 : 30);

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
    emails: [''],
    dates: new Set(),
    times: new Set(),
    // At least six weeks ahead, to the end of that month.
    until: M.monthEnd(M.addDays(M.localToday(), 42)),
    decided: null,
    dirty: false,
    hist: new History({ dates: [], times: [] }),
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
    emails: v.adminEmails?.length ? [...v.adminEmails] : [''],
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

// Times mode: the days with times, in order. There the times are all there
// is: a day is offered when it has some (`dates` is the days mode's pick).
function timeDays(d: Draft): string[] {
  const days = new Set<string>();
  for (const k of d.times) days.add(k.slice(0, 10));
  return [...days].sort();
}

// The days the event offers.
function offeredDays(d: Draft): string[] {
  return d.mode === 'times' ? timeDays(d) : [...d.dates].sort();
}

// What the form would send (sanitizeEvent checks it like the server does).
// The event's period is its first to its last offered day.
// The organisers' addresses in the event form: one field each, up to
// LIMITS.adminEmails, with a link that adds one and an × on each (when
// there is more than one). The fields are the truth; syncEmails() copies
// them into the draft.
const emailRow = (v: string) =>
  `<div class="email-row"><input type="email" name="email" maxlength="${M.LIMITS.email}" value="${esc(v)}" autocomplete="email" inputmode="email" aria-labelledby="f-email-label"><button type="button" class="icon-btn" data-act="email-remove" aria-label="${esc(t('removeEmail'))}" title="${esc(t('removeEmail'))}">${icon('x')}</button></div>`;

function emailsField(d: Draft, editing: boolean): string {
  const n = d.emails.length;
  return `<div class="field emails" data-field="email" role="group" aria-labelledby="f-email-label"${n === 1 ? ' data-one' : ''}>
    <span class="label" id="f-email-label">${esc(t(editing ? 'adminEmailsOptional' : 'yourEmailOptional'))}</span>
    <div class="email-rows">${d.emails.map(emailRow).join('')}</div>
    <button type="button" class="linkish small" data-act="email-add"${n >= M.LIMITS.adminEmails ? ' hidden' : ''}>${icon('plus')}${esc(t('addEmailRow'))}</button>
    <small class="hint">${esc(t('adminEmailHint'))}</small>
  </div>`;
}

const emailInputs = () => [...document.querySelectorAll<HTMLInputElement>('#ev-form input[name=email]')];

function syncEmails(): void {
  const inputs = emailInputs();
  draft().emails = inputs.map((i) => i.value);
  const box = $('#ev-form [data-field=email]');
  box.toggleAttribute('data-one', inputs.length === 1);
  $('#ev-form [data-act=email-add]').hidden = inputs.length >= M.LIMITS.adminEmails;
}

export function addEmail(): void {
  $('#ev-form .email-rows').insertAdjacentHTML('beforeend', emailRow(''));
  draft().dirty = true;
  syncEmails();
  emailInputs().at(-1)?.focus();
}

export function removeEmail(b: HTMLElement): void {
  const row = b.closest('.email-row');
  if (!row) return;
  const near = (row.nextElementSibling ?? row.previousElementSibling)?.querySelector('input');
  row.remove();
  draft().dirty = true;
  syncEmails();
  near?.focus();
}

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
    options: [...d.times].sort(),
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
  for (const m of presetMins(d, 'work')) d.times.add(M.slotKey(date, m));
}

// Every way of picking days (days mode) goes through here.
export function selectDates(d: Draft, dates: Iterable<string>, on: boolean): void {
  for (const date of dates) {
    if (!on) d.dates.delete(date);
    else d.dates.add(date);
  }
}

// New window or slot length: keep what was selected (resampled to the new
// slots); rows new to the window start empty.
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
      if (oldMins.has(src) && old.has(M.slotKey(date, src))) next.add(M.slotKey(date, m));
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

export function renderForm(v: M.View | null): void {
  if (!app.draft) {
    app.draft = v ? draftFromView(v) : newDraft();
    app.draft.hist.reset(snap(app.draft));
  }
  const d = app.draft;
  const editing = Boolean(v);
  document.title = `${t(editing ? 'editEvent' : 'newEvent')} · ${t('appName')}`;
  const modeCard = (mode: M.Mode) => `
    <label class="opt-card">
      <input type="radio" name="mode" value="${mode}" ${d.mode === mode ? 'checked' : ''}>
      ${icon(mode === 'dates' ? 'cal' : 'clock')}
      <span><b>${esc(t(`mode.${mode}`))}</b><small>${esc(t(`mode.${mode}Hint`))}</small></span>
    </label>`;
  const check = (key: keyof M.Settings) => {
    const on = shownOn(d.settings, key);
    return `
    <label class="check${key === 'maybeCounts' ? ' sub' : ''}">
      <input type="checkbox" name="s-${key}" ${on ? 'checked' : ''} ${blocked(d.settings, key) ? 'disabled' : ''}>
      <span><b>${esc(t(`set.${key}`))}</b><small>${esc(t(`set.${key}Hint`))}</small></span>
    </label>`;
  };
  paint(`
    <form id="ev-form" class="stack" novalidate>
      ${editing ? `<a class="back" href="${esc(subUrl(''))}" data-act="close-sub">${icon('back')}${esc(t('back'))}</a>` : ''}
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
            ${field('slot', t('slotLength'), `<select name="slot">${M.SLOTS.map((s) => `<option value="${s}" ${s === d.slot ? 'selected' : ''}>${s} min</option>`).join('')}</select>`)}
            ${field('duration', t('meetingLength'), `<select name="duration">${durationOptions(d)}</select>`)}
          </div>
          <details class="fold">
            <summary>${esc(t('timeZone'))}: <span id="tz-now">${esc(d.tz.replace(/_/g, ' '))}</span></summary>
            ${field('tz', t('timeZone'), `<select name="tz">${tzOptions(d.tz)}</select>`, t('timeZoneHint'))}
          </details>
        </div>
      </section>
      <section class="card" id="days-card" ${d.mode === 'times' ? 'hidden' : ''}>
        <h2>${esc(t('possibleDays'))}</h2>
        <p class="muted">${esc(t('possibleDaysHint'))}</p>
        <div id="f-chips"></div>
        <div id="f-cal"></div>
        <p class="cal-tip muted small">${esc(t(touch() ? 'rangeHintTouch' : 'rangeHint'))}</p>
        <button type="button" class="btn small" id="more-months" data-act="more-months">${icon('plus')}${esc(t('moreMonths'))}</button>
        <div class="count-row"><p id="f-count" class="count-line" aria-live="polite"></p>${undoButtons(d)}</div>
        <p class="err" id="range-err" hidden></p>
      </section>
      <section class="card" id="times-card" ${d.mode === 'times' ? '' : 'hidden'}>
        <h2>${esc(t('possibleTimes'))}</h2>
        <p class="muted">${esc(t(touch() ? 'possibleTimesHintTouch' : 'possibleTimesHint'))}</p>
        <div class="hours-row">
          <span class="label">${esc(t('hoursShown'))}</span>
          <span class="hours">
            <select name="dayStart" aria-label="${esc(t('fromHour'))}">${hourOptions(0, 23, d.dayStart)}</select>
            <span aria-hidden="true">–</span>
            <select name="dayEnd" aria-label="${esc(t('toHour'))}">${hourOptions(1, 24, d.dayEnd)}</select>
          </span>
        </div>
        <div id="f-grid"></div>
        <p class="muted small preset-label" id="preset-label"></p>
        <div class="chip-row">${(Object.keys(PRESETS) as Preset[]).map((p) => `<button type="button" class="btn small" data-act="preset" data-p="${p}">${esc(t(`preset.${p}`))}</button>`).join('')}</div>
        <button type="button" class="btn small" id="repeat-week" data-act="repeat-week" title="${esc(t('repeatWeekHint'))}">${icon('plus')}${esc(t('repeatWeek'))}</button>
        <div class="count-row"><p id="f-count-t" class="count-line" aria-live="polite"></p>${undoButtons(d)}</div>
        <p class="err" id="range-err-t" hidden></p>
        <p id="f-warn" class="note warn" hidden></p>
      </section>
      <section class="card">
        <h2>${esc(t('settings'))}</h2>
        ${check('maybe')}${check('maybeCounts')}
        <fieldset class="perms">
          <legend>${esc(t('permsTitle'))}</legend>
          ${M.PERMISSIONS.map(check).join('')}
        </fieldset>
        ${editing ? check('closed') : ''}
        ${field('holidays', t('holidayCal'), `<select name="holidays">${M.HOLIDAY_CALENDARS.map((c) => `<option value="${c}"${d.holidays === c ? ' selected' : ''}>${esc(t(`holidayCal.${c}`))}</option>`).join('')}</select>`, t('holidayCalHint'))}
        ${emailsField(d, editing)}
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

// The event form's settings: «se svarene» is `hidden` the other way round;
// what needs the others' answers can't be on while they are hidden, and
// counting maybes needs maybes.
const blocked = (s: M.Settings, key: keyof M.Settings): boolean =>
  ((key === 'openEdit' || key === 'claims' || key === 'decide') && s.hidden) || (key === 'maybeCounts' && !s.maybe);
const shownOn = (s: M.Settings, key: keyof M.Settings): boolean => !blocked(s, key) && (key === 'hidden' ? !s.hidden : s[key]);

function bindForm(): void {
  const form = $<HTMLFormElement>('#ev-form');
  const d = draft();
  form.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const n = el.name;
    if (n === 'name' || n === 'description' || n === 'location') d[n] = el.value;
    else if (n === 'email') syncEmails();
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
    // Both change the times in ways the earlier steps can't be laid over.
    if (n === 'mode') {
      setMode(el.value as M.Mode);
      resetHistory();
    } else if (n === 'dayStart' || n === 'dayEnd' || n === 'slot') {
      changeWindow(n);
      resetHistory();
    }
    else if (n === 'duration') d.duration = Number(el.value);
    else if (n === 'tz') {
      d.tz = el.value;
      $('#tz-now').textContent = el.value.replace(/_/g, ' ');
    }
    else if (n === 'holidays' && M.isHolidayCalendar(el.value)) {
      // Only the dots and the Helligdager button change, never the picked days.
      d.holidays = el.value;
      refreshDays();
      refreshTimes();
    }
    else if (n.startsWith('s-')) {
      const key = n.slice(2) as keyof M.Settings;
      // «se svarene» is `hidden`, ticked when it is off.
      d.settings[key] = key === 'hidden' ? !el.checked : el.checked;
      // The ones that hang on it: unticked and greyed while it is off, and
      // back as they were when it is on again (they stay stored, unused).
      for (const k of Object.keys(d.settings) as (keyof M.Settings)[]) {
        const box = form.querySelector<HTMLInputElement>(`[name="s-${k}"]`);
        if (!box || k === key) continue;
        box.disabled = blocked(d.settings, k);
        box.checked = shownOn(d.settings, k);
      }
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
      commit();
    },
  });
}

// The organiser changed days or times by hand.
export function changed(): void {
  draft().dirty = true;
}

// Days picked in days mode start with working hours in times mode; back in
// days mode, the days with times are the ones picked.
function setMode(mode: M.Mode): void {
  const d = draft();
  if (mode === d.mode) return;
  if (mode === 'times') {
    for (const date of d.dates) if (!hasTimes(d, date)) fillDate(d, date);
  } else d.dates = new Set(timeDays(d));
  d.mode = mode;
  $('#times-opts').hidden = mode !== 'times';
  $('#times-card').hidden = mode !== 'times';
  $('#days-card').hidden = mode === 'times';
  if (mode === 'dates') refreshDays();
  refreshCount();
  refreshTimes();
  if (mode === 'times') app.formGrid?.show(openDay(d));
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
export function refreshDays(): void {
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
export function scopeDays(): string[] {
  return M.dateRange(M.localToday(), draft().until);
}

export function groupDays(g: string): string[] {
  const days = scopeDays();
  if (g === 'weekdays') return days.filter((x) => !M.isWeekend(x));
  if (g === 'weekends') return days.filter(M.isWeekend);
  if (g === 'holidays') {
    const hol = M.holidaysIn(days[0], days[days.length - 1], draft().holidays);
    return days.filter((x) => hol.has(x));
  }
  return days;
}

export type Period = '2w' | '4w' | 'month';
// The days a period button picks.
export function periodDays(p: Period): string[] {
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
  const times = d.mode === 'times';
  const offered = offeredDays(d);
  let s = t(times ? 'nDaysTimes' : 'nDays', { n: offered.length });
  if (times) s += ` · ${t('nSlots', { n: d.times.size })}`;
  if (offered.length) s += ` · ${fmtRange(offered[0], offered[offered.length - 1])}`;
  $(times ? '#f-count-t' : '#f-count').textContent = s;
  const err = spanError(d) ?? (times && d.times.size > M.LIMITS.options ? 'tooMany' : null);
  const errEl = $(times ? '#range-err-t' : '#range-err');
  errEl.hidden = !err;
  errEl.textContent = err ? tx(`err.${err}`) : '';
  // Participants answer one week at a time on a phone (see TimeGrid).
  const weeks = times ? weekPages(offered).length : 0;
  const warn = $('#f-warn');
  // Two weeks from a Saturday already touch three calendar weeks.
  warn.hidden = weeks <= 3;
  warn.textContent = weeks > 3 ? t('manyWeeks', { n: weeks }) : '';
  $<HTMLButtonElement>('#repeat-week').disabled = !lastWeek(d);
}

// The form's time grid has every week from this one (or the first offered
// day's, when an older event is changed) to the last the calendar reaches.
function gridDays(d: Draft): string[] {
  const today = M.localToday();
  const first = timeDays(d)[0];
  return M.dateRange(M.weekStart(first && first < today ? first : today), M.addDays(M.weekStart(M.monthEnd(today, MAX_MONTHS)), 6));
}

// The day the grid opens on: the first offered day still to come, else this
// week (the next one at a weekend, when little is left of this one).
function openDay(d: Draft): string {
  const today = M.localToday();
  const days = timeDays(d);
  return days.find((x) => x >= today) ?? days[0] ?? (M.weekday(today) >= 5 ? M.addDays(M.weekStart(today), 7) : today);
}

// Times mode: the grid is where the times are picked, any day from today.
// A day gone by can only lose the times it has.
export function refreshTimes(): void {
  const d = draft();
  if (d.mode !== 'times') return;
  const opts = { dates: gridDays(d), mins: M.daySlots(d), rowh: rowHeight(d.slot) };
  if (app.formGrid?.el.isConnected) app.formGrid.set(opts);
  else {
    app.formGrid = new TimeGrid($('#f-grid'), {
      ...opts,
      mode: 'paint',
      nav: 'steps',
      open: openDay(d),
      allowed: (k) => k.slice(0, 10) >= M.localToday() || draft().times.has(k),
      marks: () => new Set(timeDays(draft())),
      dayNote: (date) => {
        const h = M.holidaysIn(date, date, draft().holidays).get(date);
        return h ? holidayNames(h) : '';
      },
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
        commit();
      },
      onDay: (date) => dayMenu(date),
    });
  }
  $('#preset-label').textContent = t('presetsFor', { n: app.formGrid.cols.length > 7 ? 2 : 1 });
}

// The slots of a preset within the hours shown.
function presetMins(d: Draft, p: Preset): number[] {
  const [from, to] = PRESETS[p];
  return M.daySlots(d).filter((m) => m >= from && m + d.slot <= to);
}

async function dayMenu(date: string): Promise<void> {
  const d = draft();
  const r = await menu(cap(fmtDate(date, 'long')), [
    { id: 'all', label: t('dayAll') },
    { id: 'work', label: t('preset.work') },
    { id: 'week', label: t('dayCopyWeek') },
    { id: 'copy', label: t('dayCopy') },
    { id: 'clear', label: t('dayClear') },
  ]);
  if (r === '') return;
  changed();
  const today = M.localToday();
  const mins = M.daySlots(d);
  const own = mins.filter((m) => d.times.has(M.slotKey(date, m)));
  if (r === 'all') setDateTimes(d, date, mins);
  else if (r === 'work') setDateTimes(d, date, presetMins(d, 'work'));
  else if (r === 'clear') setDateTimes(d, date, []);
  else if (r === 'week') {
    // Monday to Friday of this day's week, as far as they are still to come.
    const mon = M.weekStart(date);
    for (const x of M.dateRange(mon, M.addDays(mon, 4))) if (x >= today) setDateTimes(d, x, own);
  } else if (r === 'copy') {
    for (const x of timeDays(d)) if (x >= today) setDateTimes(d, x, own);
  } else return;
  refreshCount();
  refreshTimes();
  commit(r === 'clear');
}

// A preset fills the week (or two) shown, from today on: working hours on
// its weekdays, the others on every day.
export function applyPreset(p: Preset): void {
  changed();
  const d = draft();
  const today = M.localToday();
  const shown = (app.formGrid?.cols ?? []).filter((x) => x >= today);
  const mins = presetMins(d, p);
  for (const x of p === 'work' ? shown.filter((x) => !M.isWeekend(x)) : shown) setDateTimes(d, x, mins);
  refreshCount();
  refreshTimes();
  commit(p === 'clear');
}

// The Monday of the last week with times, when the week after it is still
// within what the grid shows.
function lastWeek(d: Draft): string | null {
  const days = timeDays(d);
  if (!days.length) return null;
  const mon = M.weekStart(days[days.length - 1]);
  return M.addDays(mon, 7) <= M.monthEnd(M.localToday(), MAX_MONTHS) ? mon : null;
}

// «One more week, same times»: the last week with times, once more in the
// week after it, which the grid then shows.
export function repeatWeek(): void {
  const d = draft();
  const mon = lastWeek(d);
  if (!mon) return;
  changed();
  const today = M.localToday();
  for (const k of [...d.times]) {
    if (k.slice(0, 10) < mon) continue;
    const next = M.addDays(k.slice(0, 10), 7);
    if (next >= today) d.times.add(next + k.slice(10));
  }
  app.formGrid?.show(M.addDays(mon, 7));
  refreshCount();
  refreshTimes();
  commit();
}

// A quick button: if any of its days are picked it drops them, otherwise it
// picks them all.
export function selectGroup(list: string[]): void {
  changed();
  const d = draft();
  selectDates(d, list, !list.some((x) => d.dates.has(x)));
  refreshDays();
  refreshTimes();
  commit();
}

// --- Undo and redo in the picker (history.ts) ---------------------------------------------
// Every change to the picked days or times ends with commit(). Switching
// mode or the day's hours resets the history, as both rework the times. The
// history lives on the draft, so it goes with it (save, cancel, leaving)
// and survives a language switch.

const snap = (d: Draft): Snap => ({
  dates: [...d.dates].sort(),
  times: [...d.times].sort(),
});

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function undoButtons(d: Draft): string {
  const b = (act: 'undo' | 'redo', keys: string, aria: string, on: boolean) =>
    `<button type="button" class="btn small ghost" data-act="${act}" title="${esc(`${t(act)} (${keys})`)}" aria-keyshortcuts="${aria}"${on ? '' : ' disabled'}>${icon(act)}${esc(t(act))}</button>`;
  return `<span class="undo-btns">${b('undo', MAC ? '⌘Z' : 'Ctrl+Z', 'Control+Z Meta+Z', d.hist.undo.length > 0)}${b('redo', MAC ? '⇧⌘Z' : 'Ctrl+Y', 'Control+Shift+Z Meta+Shift+Z Control+Y', d.hist.redo.length > 0)}</span>`;
}

function refreshUndo(): void {
  const h = app.draft?.hist;
  if (!h) return;
  for (const b of $$<HTMLButtonElement>('#ev-form .undo-btns [data-act="undo"]')) b.disabled = !h.undo.length;
  for (const b of $$<HTMLButtonElement>('#ev-form .undo-btns [data-act="redo"]')) b.disabled = !h.redo.length;
}

// After a change: one step, if anything changed. With `tell`, a toast says
// what went (days, else times) and offers to undo it.
export function commit(tell = false): void {
  const d = draft();
  const before = d.hist.base;
  if (!d.hist.commit(snap(d))) return;
  d.dirty = true;
  refreshUndo();
  if (!tell) return;
  const gone = d.mode === 'dates' ? before.dates.filter((x) => !d.dates.has(x)).length : 0;
  const undo = { label: t('undo'), act: 'undo' };
  if (gone) toast(t('removedDays', { n: gone }), undo);
  else if (d.times.size < before.times.length) toast(t('timesCleared'), undo);
}

function resetHistory(): void {
  const d = draft();
  d.hist.reset(snap(d));
  refreshUndo();
}

export function travel(back: boolean, from?: HTMLElement): void {
  const d = app.draft;
  if (!d || !$opt('#ev-form')) return;
  const s = back ? d.hist.back(snap(d)) : d.hist.forward(snap(d));
  if (!s) return;
  // New Sets: the snapshot stays as it is in the history.
  d.dates = new Set(s.dates);
  d.times = new Set(s.times);
  const last = s.dates[s.dates.length - 1];
  if (last && last > d.until) d.until = M.monthEnd(last);
  d.dirty = true;
  hideToast();
  refreshDays();
  refreshTimes();
  refreshUndo();
  // A button that just went disabled (or the toast's, now gone) would drop
  // the focus: hand it to the other one in the same place.
  if (from && (from.matches(':disabled') || !from.checkVisibility?.())) {
    const group = from.closest('.undo-btns') ?? $opt('#ev-form section:not([hidden]) .count-row .undo-btns');
    group?.querySelector<HTMLButtonElement>(`[data-act="${back ? 'redo' : 'undo'}"]:not(:disabled)`)?.focus({ preventScroll: true });
  }
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
  const em = M.cleanEmails(d.emails);
  if (!em.ok) return fail(t(`err.${em.error}`), emailInputs().find((i) => !M.cleanEmail(i.value).ok));
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
      const { view } = await api<{ view: M.View }>('PUT', `/events/${id}`, { token, body: { event: r.event, emails: em.emails } });
      d.dirty = false;
      setView(view);
      toast(t('saved'));
      closeSub();
    } else {
      const res = await api<M.Created>('POST', '/events', { body: { event: r.event, emails: em.emails } });
      store.put(res.id, { name: r.event.name, admin: res.token });
      d.dirty = false;
      app.flash = { kind: 'created' };
      setView(res.view, res.id, res.token);
      go(eventPath(res.id, res.token), true);
    }
  } catch (e) {
    fail(errText(e));
  } finally {
    setBusy(false);
  }
}
