// What the app holds while it runs (the route, the event's view, an open
// form's draft) and the small helpers every view uses. Nothing here draws.

import * as M from '../shared/model.ts';
import { t, tx } from './i18n.ts';
import { ApiError } from './api.ts';
import { ask } from './ui.ts';
import { TimeGrid } from './timegrid.ts';
import { History } from './history.ts';
import { getZone } from './store.ts';
import { sameClock, type Layout, layout } from './zone.ts';

export type Route = { page: 'home' } | { page: 'new' } | { page: 'find' } | { page: 'missing' } | { page: 'event'; id: string; token: string | null };
export type Sub = { kind: 'overview' } | { kind: 'edit' } | { kind: 'answer'; pid: string | null };
export type Tab = 'cal' | 'list' | 'table' | 'grid';
type Flash = { kind: 'created' } | { kind: 'savedNew'; name: string; draft?: boolean };

// The event form's state while it is open.
export interface Draft extends M.DayWindow {
  name: string;
  description: string;
  location: string;
  mode: M.Mode;
  duration: number;
  tz: string;
  settings: M.Settings;
  holidays: M.HolidayCalendar; // which holidays the calendar marks
  emails: string[]; // the organisers' addresses, one per field (at least one, maybe empty)
  dates: Set<string>;
  times: Set<string>;
  until: string; // the calendar shows months up to this day
  decided: string | null; // kept when the event is edited, if it still fits
  dirty: boolean; // changed since it was opened or saved
  hist: History; // undo and redo for the picked days and times
}

// The answer editor's state while it is open.
export interface AnswerDraft {
  pid: string | null;
  // A new answer as one of the listed names still waiting (its id), and
  // whether typing the name picked it (then typing on can unpick it).
  claim: string | null;
  claimTyped: boolean;
  // The draft of the name picked, put in the form (its id, and the form as
  // it was then): picking another name takes it out again if unchanged.
  loaded: { pid: string; was: string } | null;
  // Opened on a listed name still waiting: saving mustn't overwrite the
  // answers if they answer themselves meanwhile (poll.ts).
  waiting: boolean;
  // «Vis som besvart»: off saves a draft (not counted). On whenever the
  // form opens, so Lagre always counts unless someone untick it.
  counted: boolean;
  own: boolean;
  name: string;
  comment: string;
  email: string;
  answers: M.Answers;
  brush: M.Answer;
  view: 'cal' | 'list';
  dirty: boolean;
}

export const app: {
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
  // The best list shows every option tied for first, not just SHOW_BEST.
  bestOpen: boolean;
  // The Svar card shows every waiting name, not just WAIT_SHOWN.
  waitOpen: boolean;
  // An unsaved form left with the browser's back button, given back when
  // its page is opened again.
  kept: { where: string; draft: Draft | null; answer: AnswerDraft | null } | null;
  // Live updates (see applyLive): the latest one not yet applied, and the
  // socket it came from; whether the page waits to be drawn again; the
  // one-off notice this page showed, kept when it is drawn again; whether
  // this form has said that someone else changed the event.
  liveMsg: { m: M.LiveMessage; key: string } | null;
  stale: boolean;
  flashShown: Flash | null;
  toldChanged: boolean;
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
  bestOpen: false,
  waitOpen: false,
  kept: null,
  liveMsg: null,
  stale: false,
  flashShown: null,
  toldChanged: false,
};

// The current event page, view, form and answer. Code that uses them only
// runs while they exist.
export function here(): { id: string; token: string | null } {
  const r = app.route;
  if (r?.page !== 'event') throw new Error('not on an event page');
  return r;
}
export function current(): M.View {
  if (!app.view) throw new Error('no event loaded');
  return app.view;
}
export function draft(): Draft {
  if (!app.draft) throw new Error('no event form');
  return app.draft;
}
export function answer(): AnswerDraft {
  if (!app.answer) throw new Error('no answer editor');
  return app.answer;
}

// An open event form or answer editor with changes that aren't saved.
export function unsaved(): boolean {
  return Boolean(app.draft?.dirty || app.answer?.dirty);
}

// Before leaving a page with unsaved changes. True = go ahead (and drop them).
export async function leaveOk(): Promise<boolean> {
  if (!unsaved()) return true;
  if (!(await ask(t('discardQ'), { ok: t('discard'), danger: true }))) return false;
  app.draft = null;
  app.answer = null;
  app.kept = null;
  return true;
}

// el.dataset[k], '' if missing.
export const data = (el: HTMLElement, k: string): string => el.dataset[k] ?? '';
// A form control by name (form.elements.namedItem).
export const control = <T = HTMLInputElement>(form: HTMLFormElement, name: string): T => form.elements.namedItem(name) as T;

// A finger is the main pointer (phones, tablets): painting starts with a hold.
export const touch = () => matchMedia('(pointer: coarse)').matches;

// The names the organisers listed that haven't answered (none from a Poll
// object still on the code from before them).
export const waitingOf = (v: M.View): M.Waiting[] => v.waiting ?? [];

// An entry by id: one who answered, or a listed name still waiting (as an
// entry with no answers).
type Entry = M.Person & { waiting?: true };
export function entryOf(v: M.View, pid: string | null): Entry | undefined {
  if (!pid) return undefined;
  const p = v.people.find((x) => x.id === pid);
  if (p) return p;
  const w = waitingOf(v).find((x) => x.id === pid);
  return w && { id: w.id, name: w.name, comment: w.comment ?? '', answers: w.answers ?? {}, updated: 0, waiting: true, ...(w.email === undefined ? {} : { email: w.email }) };
}
// A waiting entry with a draft (only those who may change it get one).
export const hasDraft = (e: Entry | undefined): boolean => Boolean(e?.waiting && (Object.keys(e.answers).length || e.comment));

// A new event's holiday calendar: where the browser's clock is, else its
// languages, else none (a foreign calendar would be worse than none).
export function guessHolidays(): M.HolidayCalendar {
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

// Which zone an event's times are shown in: this device's, unless the
// viewer asked for the event's or the two read the same.
export function shownTz(ev: M.PollEvent): string {
  if (ev.mode !== 'times') return '';
  const mine = browserTz();
  return getZone() === 'event' || sameClock(ev, mine) ? ev.tz : mine;
}

// For the labels: from the event's zone to the one shown (none: the same).
export function zoneMove(ev: M.PollEvent): { from: string; to: string } | undefined {
  const to = shownTz(ev);
  return ev.mode === 'times' && to !== ev.tz ? { from: ev.tz, to } : undefined;
}

// The grid of an event's times, in the zone shown.
export function gridLayout(ev: M.TimesEvent): Layout {
  return layout(ev, shownTz(ev));
}

export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Oslo';
  } catch {
    return 'Europe/Oslo';
  }
}

export function errText(e: unknown): string {
  const k = `err.${e instanceof ApiError ? e.code : 'server'}`;
  const s = tx(k);
  return s === k ? t('err.server') : s;
}
