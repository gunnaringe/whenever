// Whenever / Finn tid: the UI's entry. Plain ES modules, no framework. Each
// view is an HTML string painted into #app (render.ts picks the view); clicks
// are delegated through data-act to the `actions` map here.
//
//   state.ts     what the app holds while it runs, small helpers
//   route.ts     addresses and moving between pages
//   shell.ts     the header, the footer, shared pieces of HTML
//   render.ts    which view to draw
//   home.ts      the start page and /find
//   form.ts      the event form
//   overview.ts  the event page
//   answer.ts    the answer editor
//   actions.ts   what the event page's buttons do
//   sync.ts      live updates and the refresh

import * as M from '../shared/model.ts';
import { t, getLang, setLang, LANGS, LANG_NAMES } from './i18n.ts';
import type { Lang } from './i18n.ts';
import * as store from './store.ts';
import { $, $opt, esc, ask, menu, dialog, copyText, shareUrl, qrSvg, toast, hideToast } from './ui.ts';
import { type Tab, type AnswerDraft, app, current, draft, answer, unsaved, leaveOk, data } from './state.ts';
import { go, openSub, closeSub } from './route.ts';
import { pickEvent, menuOpen } from './shell.ts';
import { render } from './render.ts';
import { find, renderFind, askCode, useLink } from './home.ts';
import { type Preset, moreHours, addEmail, removeEmail, selectDates, changed, refreshDays, scopeDays, groupDays, type Period, periodDays, refreshTimes, applyPreset, repeatWeek, selectGroup, commit, travel } from './form.ts';
import { bestHtml, updateDetail, addNames, editDetails, copyReminder } from './overview.ts';
import { lockClaims, fitClaims, setClaim, pickerToolbar, setAns, updatePickSum, saveAnswer } from './answer.ts';
import { deleteEntry, personLink, decide, downloadIcs, toggleClosed, adminMore, leave, meMore, pickTheme, setTheme, switchLang } from './actions.ts';

// data-act="<name>" -> what a click on it does.
// The event just taken off the home page's list, until Undo or the next one.
let forgotten: { id: string; e: store.Raw } | null = null;

const actions: Record<string, (b: HTMLElement) => unknown> = {
  lang: (b) => {
    $opt('#lang-menu')?.hidePopover();
    switchLang(data(b, 'lang'));
  },
  'lang-pick': async () => switchLang(await menu(t('language'), LANGS.map((l) => ({ id: l, label: LANG_NAMES[l], on: l === getLang() })))),
  theme: () => pickTheme(),
  'events-pick': () => pickEvent(),
  // Times in this device's time zone or the event's.
  zone: (b) => {
    store.setZone(b.dataset.zone === 'event' ? 'event' : 'mine');
    render();
  },
  'best-more': () => {
    app.bestOpen = !app.bestOpen;
    const el = $opt('#best');
    if (!el || !app.view) return;
    el.innerHTML = bestHtml(app.view);
    $opt<HTMLElement>('#best [data-act="best-more"]')?.focus();
  },
  'find-again': () => askCode(find.email, true),
  'find-link': () => useLink(),
  'find-link-cancel': () => {
    find.link = '';
    renderFind();
  },
  'find-other': () => {
    find.sent = false;
    renderFind();
  },
  'theme-set': (b) => {
    $opt('#theme-menu')?.hidePopover();
    setTheme(data(b, 'theme'));
  },
  reload: async () => {
    if (await leaveOk()) location.reload();
  },
  retry: () => {
    app.viewKey = null;
    render();
  },
  copy: (b) => copyText(data(b, 'url')),
  share: (b) => shareUrl(data(b, 'url'), b.dataset.title || app.view?.event.name || t('appName')),
  qr: (b) =>
    dialog(`<h3>${esc(t('qrTitle'))}</h3>${qrSvg(data(b, 'url'))}<p class="muted small center">${esc(b.dataset.url)}</p><div class="row end"><button value="" class="btn primary">${esc(t('done'))}</button></div>`),
  // Off the list on the home page at once, with Undo in the message (no
  // question first). What was stored is kept only here, in memory.
  forget: (b) => {
    const id = data(b, 'id');
    const ids = store.events().map((e) => e.id);
    const i = ids.indexOf(id);
    const gone = store.forget(id);
    render();
    const next = ids[i + 1] ?? ids[i - 1];
    (next ? $opt(`[data-act="forget"][data-id="${next}"]`) : $opt('.hero .find-link a'))?.focus();
    if (!gone) return;
    forgotten = { id, e: gone };
    toast(t('forgotToast', { name: typeof gone.name === 'string' && gone.name ? gone.name : '–' }), { label: t('undo'), act: 'unforget' });
  },
  unforget: () => {
    if (!forgotten) return;
    const { id, e } = forgotten;
    forgotten = null;
    store.restore(id, e);
    hideToast();
    render();
    $opt(`[data-act="forget"][data-id="${id}"]`)?.focus();
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
    commit(true);
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
    commit(true);
  },
  'sel-group': (b) => selectGroup(groupDays(data(b, 'g'))),
  'sel-wd': (b) => selectGroup(scopeDays().filter((x) => M.weekday(x) === Number(b.dataset.wd))),
  week: (b) => {
    const scope = new Set(scopeDays());
    selectGroup([0, 1, 2, 3, 4, 5, 6].map((i) => M.addDays(data(b, 'mon'), i)).filter((x) => scope.has(x)));
  },
  preset: (b) => applyPreset(data(b, 'p') as Preset),
  'repeat-week': () => repeatWeek(),
  hours: (b) => moreHours(b),
  undo: (b) => travel(true, b),
  redo: (b) => travel(false, b),

  // Event page
  answer: () => openSub('answer'),
  leave: () => leave(),
  'edit-event': () => openSub('edit'),
  'email-add': () => addEmail(),
  'email-remove': (b) => removeEmail(b),
  'edit-entry': (b) => openSub(`answer=${b.dataset.pid}`),
  'delete-entry': (b) => deleteEntry(data(b, 'pid')),
  'person-link': (b) => personLink(data(b, 'pid')),
  'add-names': () => addNames(),
  'edit-details': () => editDetails(),
  'copy-reminder': () => copyReminder(),
  claim: (b) => setClaim(answer().claim === b.dataset.pid ? null : data(b, 'pid')),
  'claim-more': () => {
    $('.claim-box').classList.toggle('open');
    lockClaims();
    fitClaims();
  },
  'wait-more': () => {
    app.waitOpen = !app.waitOpen;
    render();
  },
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

// Undo and redo in the event form: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y.
// Not in its fields (they have the browser's own undo), a dialog or a menu.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !app.draft || !$opt('#ev-form')) return;
  const k = e.key.toLowerCase();
  const redo = (k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey && !e.shiftKey);
  if (k !== 'z' && !redo) return;
  if ((e.target as Element).closest?.('input, textarea, select, [contenteditable]')) return;
  if ($<HTMLDialogElement>('#dlg').open || menuOpen()) return;
  e.preventDefault();
  travel(!redo);
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
