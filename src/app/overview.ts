// The event page: its head, sharing, what suits best, the results and the
// answers.

import * as M from '../shared/model.ts';
import { t, fmtDate, fmtRange, slotLabel, windowLabel, weekdayShort, durationLabel, cap, joinAnd } from './i18n.ts';
import { api } from './api.ts';
import * as store from './store.ts';
import type { Stored } from './store.ts';
import { $, $opt, $$, esc, icon, toast, dialog, copyText } from './ui.ts';
import { calendarHtml } from './calendar.ts';
import { TimeGrid } from './timegrid.ts';
import { type Tab, app, here, current, waitingOf, entryOf, hasDraft, browserTz, errText, shownTz, gridLayout, zoneMove } from './state.ts';
import { eventPath, eventUrl, linkUrl } from './route.ts';
import { paint, field, linkBox } from './shell.ts';
import { render, setView } from './render.ts';
import { rowHeight } from './form.ts';
import { sameClock } from './zone.ts';

const heat = (g: M.Tally, n: number, s: M.Settings): string => M.heat(g, n, s).toFixed(3);
// Dark cells get light text.
const hi = (h: string) => (Number(h) > 0.55 ? ' hi' : '');

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

export function renderOverview(v: M.View): void {
  const ev = v.event;
  const { id } = here();
  document.title = `${ev.name} · ${t('appName')}`;
  const stored = store.get(id);
  // Just created: sharing the link is the next thing to do.
  const created = app.flash?.kind === 'created';
  const share = v.role === 'admin' ? shareHtml(v) : '';
  // Its last whole day: the server's word (it keeps an event a week after
  // any change), else worked out from the last day, unless that is gone by.
  const lastDay = v.deletes ? M.addDays(M.fromTime(v.deletes), -1) : M.addDays(ev.end, M.RETENTION_DAYS);
  const expires = lastDay >= M.localToday() ? lastDay : '';
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
    ${expires ? `<p class="muted small center">${esc(t('expiresNote', { date: fmtDate(expires, 'full') }))}</p>` : ''}`);
  mountResults(v);
  if (app.flash) app.flashShown = app.flash;
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
      <h2>${icon('check')}${esc(t(f.draft ? 'savedDraftTitle' : 'savedNewTitle', { name: f.name }))}</h2>
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
    if (stored.admin && stored.admin !== token) btns.push(`<a class="btn small" href="${eventPath(id, stored.admin)}" data-link>${esc(t('openAdmin'))}</a>`);
    if (stored.me && stored.me !== token) btns.push(`<a class="btn small" href="${eventPath(id, stored.me)}" data-link>${esc(t('openMine'))}</a>`);
    if (btns.length) out.push(`<section class="card notice info"><p>${esc(t(stored.admin ? 'storedAdmin' : 'storedMine'))}</p><div class="row wrap">${btns.join('')}</div></section>`);
  }
  if (v.event.settings.closed) out.push(`<section class="card notice">${icon('lock')}<p>${esc(t(v.role === 'admin' ? 'closedAdmin' : 'closedInfo'))}</p></section>`);
  return out.join('');
}

const zoneName = (tz: string) => tz.replace(/_/g, ' ');

// Which time zone the times are in, and a button to show them in the other
// one when the viewer's clock reads differently from the event's.
function zoneParts(ev: M.TimesEvent): { text: string; button: string } {
  const mine = browserTz();
  if (sameClock(ev, mine)) return { text: `${t('timesIn', { tz: zoneName(ev.tz) })}${mine !== ev.tz ? ` ${t('yourTz', { tz: zoneName(mine) })}` : ''}`, button: '' };
  const own = shownTz(ev) === mine;
  const text = own ? t('timesYours', { tz: zoneName(mine) }) : `${t('timesIn', { tz: zoneName(ev.tz) })} ${t('yourTz', { tz: zoneName(mine) })}`;
  const label = own ? t('showEventTz', { tz: zoneName(ev.tz) }) : t('showMyTz');
  return { text, button: `<button type="button" class="linkish small" data-act="zone" data-zone="${own ? 'event' : 'mine'}">${esc(label)}</button>` };
}

// The same as a line of its own (the answer form).
export function zoneHtml(ev: M.TimesEvent): string {
  const z = zoneParts(ev);
  return `<p class="zone-line muted small">${icon('globe')}<span>${esc(z.text)}${z.button ? ` ${z.button}` : ''}</span></p>`;
}

function headHtml(v: M.View): string {
  const ev = v.event;
  // Times mode: the first and last day as shown, in the viewer's zone.
  const days = ev.mode === 'times' ? gridLayout(ev).dates : [];
  const meta: [string, string, string?][] = [[icon('cal'), days.length ? fmtRange(days[0], days[days.length - 1]) : fmtRange(ev.start, ev.end)]];
  if (ev.mode === 'dates') meta.push([icon('grid'), t('metaDates', { n: ev.options.length })]);
  else {
    meta.push([icon('clock'), t('metaTimes', { dur: durationLabel(ev.duration) })]);
    const z = zoneParts(ev);
    meta.push([icon('globe'), z.text, z.button]);
  }
  if (ev.location) meta.push([icon('pin'), ev.location]);
  const s = ev.settings;
  if (s.hidden) meta.push([icon('eye-off'), t('metaHidden')]);
  if (s.openEdit && !s.hidden) meta.push([icon('users'), t('metaOpenEdit')]);
  if (!s.newNames) meta.push([icon('users'), t('metaListOnly')]);
  if (s.decide && !s.hidden && !s.closed) meta.push([icon('check'), t('metaDecide')]);
  // The admin changes it all in the event form.
  const details = v.role !== 'admin' && M.canChangeDetails(v, s);
  return `<section class="card head">
    <h1>${esc(ev.name)}</h1>
    <ul class="meta">${meta.map(([i, s, more]) => `<li>${i}<span>${esc(s)}${more ? ` ${more}` : ''}</span></li>`).join('')}</ul>
    ${ev.description ? `<p class="desc">${esc(ev.description)}</p>` : ''}
    ${details ? `<p class="head-edit"><button type="button" class="linkish small" data-act="edit-details">${icon('edit')}${esc(t('editDetails'))}</button></p>` : ''}
  </section>`;
}

function actionsHtml(v: M.View): string {
  const ev = v.event;
  const { id, token } = here();
  const who = { role: v.role, me: v.me };
  const add = M.canAdd(who, ev.settings);
  const shareBtn = `<button type="button" class="btn" data-act="share" data-url="${esc(eventUrl(id))}" data-title="${esc(ev.name)}">${icon('share')}${esc(t('shareEvent'))}</button>`;
  if (v.role === 'admin') {
    // The admin link is no person (poll.ts): it adds and changes anyone's
    // answers, an organiser's own too.
    const quiet = app.flash?.kind === 'created';
    return `<section class="card role">
      <div class="role-text"><div class="role-head"><b>${esc(t('youAreAdmin'))}</b><button type="button" class="linkish small leave" data-act="leave">${icon('logout')}${esc(t('leave'))}</button></div><p class="muted">${esc(t('adminHint'))}</p></div>
      <div class="row wrap">
        <button type="button" class="btn${quiet ? '' : ' primary'}" data-act="answer">${icon('plus')}${esc(t('addAnswers'))}</button>
        <button type="button" class="btn" data-act="edit-event">${icon('edit')}${esc(t('editEvent'))}</button>
        <button type="button" class="btn" data-act="toggle-closed">${icon('lock')}${esc(t(ev.settings.closed ? 'reopen' : 'close'))}</button>
        <button type="button" class="btn" data-act="admin-more" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('dots')}</button>
      </div>
    </section>`;
  }
  if (v.role === 'participant') {
    const me = entryOf(v, v.me);
    const draft = hasDraft(me);
    const hint = me?.waiting ? t(draft ? 'youHaveDraft' : 'youNotAnswered') : app.flash?.kind === 'savedNew' ? '' : t('personalHint');
    return `<section class="card role">
      <div class="role-text"><div class="role-head"><b>${esc(t('hiName', { name: me?.name ?? '' }))}</b><button type="button" class="linkish small leave" data-act="leave">${icon('logout')}${esc(t('leave'))}</button></div>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}</div>
      <div class="row wrap">
        ${M.canEdit(who, ev.settings, v.me) ? `<button type="button" class="btn primary" data-act="answer">${icon(me?.waiting && !draft ? 'plus' : 'edit')}${esc(t(me?.waiting && !draft ? 'addYourAnswers' : 'editYourAnswers'))}</button>` : ''}
        <button type="button" class="btn" data-act="copy" data-url="${esc(linkUrl(id, token))}">${icon('copy')}${esc(t('copyMyLink'))}</button>
        ${shareBtn}
        <button type="button" class="btn" data-act="me-more" aria-label="${esc(t('more'))}" title="${esc(t('more'))}">${icon('dots')}</button>
      </div>
    </section>`;
  }
  // Only the listed names may answer: by tapping one, if they may.
  const claim = M.canClaim(who, ev.settings) && waitingOf(v).length > 0;
  const listOnly = !add && !ev.settings.closed;
  return `<section class="card role cta">
    ${add || claim ? `<button type="button" class="btn primary big" data-act="answer">${icon('plus')}${esc(t('addYourAnswers'))}</button>` : ''}
    ${shareBtn}
    ${listOnly ? `<p class="muted small">${esc(t(claim ? 'listOnlyClaim' : 'listOnlyInfo'))}</p>` : ''}
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

export function bestHtml(v: M.View): string {
  const ev = v.event;
  const s = ev.settings;
  const n = v.people.length;
  if (!n) return '';
  const all = ranked(ev, v.people);
  if (!all.length) return `<p class="muted">${esc(t('noneAvailable'))}</p>`;
  const rank = M.ranks(all, s);
  // Never leave out one that is as good as the first: a button shows them all.
  const more = rank.slice(SHOW_BEST).filter((r) => r === 1).length;
  const shown = app.bestOpen ? SHOW_BEST + more : SHOW_BEST;
  // The hidden bits make it read (and copy) as "1. Friday 4 December – 1 of 1 can".
  return `<ol class="best">${all
    .slice(0, shown)
    .map(
      (b, i) => `<li><button type="button" class="best-item${rank[i] === 1 ? ' first' : ''}${app.pick?.k === b.key ? ' sel' : ''}" data-act="pick" data-k="${b.key}" ${ev.mode === 'times' ? 'data-win="1"' : ''}>
        <span class="rank">${rank[i]}</span><span class="vh">. </span>
        <span class="bl">${esc(cap('date' in b ? windowLabel(b, zoneMove(ev)) : fmtDate(b.key, 'long')))}${ev.decided === b.key ? ` <span class="tag">${icon('check')}${esc(t('decidedTag'))}</span>` : ''}</span><span class="vh"> – </span>
        <span class="bn">${esc(countText(b, n, s))}</span>
      </button></li>`,
    )
    .join('')}</ol>
    ${more ? `<p class="best-more"><button type="button" class="linkish small" data-act="best-more" aria-expanded="${app.bestOpen}">${esc(app.bestOpen ? t('showFewer') : t('moreTied', { n: more }))}<span class="chev" aria-hidden="true">${app.bestOpen ? '▴' : '▾'}</span></button></p>` : ''}
    ${s.maybe ? `<p class="best-how muted small">${esc(t(s.maybeCounts ? 'rankMaybeCounts' : 'rankYesFirst'))}</p>` : ''}`;
}

function resultsHtml(v: M.View): string {
  const ev = v.event;
  const title = `<h2>${esc(t('resultsTitle'))}</h2>`;
  if (v.hidden) return `<section class="card results">${title}<p class="muted">${esc(t('hiddenInfo'))}</p></section>`;
  const tabs: Tab[] = ev.mode === 'dates' ? ['cal', 'list', 'table'] : ['grid', 'list'];
  if (!app.tab || !tabs.includes(app.tab)) app.tab = tabs[0];
  return `<section class="card results">
    ${title}
    ${v.people.length ? '' : `<p class="muted">${esc(t('noAnswersYet'))}</p>`}
    <div id="best">${bestHtml(v)}</div>
    <div class="seg" role="tablist">${tabs.map((x) => `<button type="button" role="tab" class="${x === app.tab ? 'on' : ''}" aria-selected="${x === app.tab}" data-act="tab" data-tab="${x}">${esc(t(`tab.${x}`))}</button>`).join('')}</div>
    <div id="res-body">${resultsBody(v)}</div>
    ${app.tab === 'table' ? '' : legendHtml(v)}
    <div id="detail" aria-live="polite">${detailHtml(v)}</div>
  </section>`;
}

// The heat ramp, plus what marks a day in the calendar or grid: a ring for
// the ones most can make, a badge for the picked date.
function legendHtml(v: M.View): string {
  const ev = v.event;
  const marks = app.tab === 'cal' || app.tab === 'grid';
  const top = marks && v.people.length ? `<span class="lg"><i class="sw top ${ev.mode}"></i>${esc(t('legendTop'))}</span>` : '';
  const dec = marks && ev.decided ? `<span class="lg"><i class="dk">${icon('check')}</i>${esc(t('decidedTag'))}</span>` : '';
  return `<div class="legend" aria-hidden="true"><span class="lg"><span>${esc(t('legendFew'))}</span><span class="ramp"></span><span>${esc(t('legendMany'))}</span></span>${top}${dec}</div>`;
}

function resultsBody(v: M.View): string {
  const ev = v.event;
  const n = v.people.length;
  const T = M.tally(ev, v.people);
  // tally() has every option.
  const at = (k: string): M.Tally => T.get(k) ?? { key: k, yes: [], maybe: [], no: [] };
  const pct = (x: number) => (n ? (100 * x) / n : 0).toFixed(1);
  const row = (key: string, label: string, g: M.Tally, win: boolean) => `
    <button type="button" class="res-row${app.pick?.k === key ? ' sel' : ''}${ev.decided === key ? ' decided' : ''}" data-act="pick" data-k="${key}" ${win ? 'data-win="1"' : ''}>
      <span class="rl">${esc(cap(label))}${ev.decided === key ? ` <span class="tag">${icon('check')}${esc(t('decidedTag'))}</span>` : ''}</span>
      <span class="meter"><i class="y" style="width:${pct(g.yes.length)}%"></i><i class="m" style="width:${pct(g.maybe.length)}%"></i></span>
      <span class="rn">${M.score(g, ev.settings)}/${n}</span>
    </button>`;

  if (ev.mode === 'times') {
    if (app.tab === 'grid') return '<div id="res-grid"></div>';
    const ws = M.bestWindows(ev, v.people, 15);
    if (!ws.length) return `<p class="muted">${esc(t('noneAvailable'))}</p>`;
    return `<div class="res-list">${ws.map((w) => row(w.key, windowLabel(w, zoneMove(ev)), w, true)).join('')}</div>`;
  }

  if (app.tab === 'list') return `<div class="res-list">${ev.options.map((k) => row(k, fmtDate(k, 'long'), at(k), false)).join('')}</div>`;

  if (app.tab === 'table') {
    if (!n) return `<p class="muted">${esc(t('noAnswersYet'))}</p>`;
    const wd = weekdayShort();
    const cell = (a: M.Answer | undefined) =>
      a === M.YES ? `<td class="y" title="${esc(t('yes'))}">✓</td>` : a === M.MAYBE ? `<td class="m" title="${esc(t('maybe'))}">(✓)</td>` : `<td class="n" title="${esc(t('no'))}"></td>`;
    return `<div class="table-scroll"><table class="ptable">
      <thead><tr><th scope="col" class="name">${esc(t('name'))}</th>${ev.options.map((k) => `<th scope="col"${ev.decided === k ? ` class="decided" title="${esc(t('decidedTag'))}"` : ''}><span>${wd[M.weekday(k)]}</span><b>${Number(k.slice(8))}</b><small>${esc(fmtDate(k, 'monthShort'))}</small>${ev.decided === k ? `<i class="dk">${icon('check')}</i>` : ''}</th>`).join('')}</tr></thead>
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
      const dec = ev.decided === x;
      return `<button type="button" class="cal-day res${hi(h)}${top.has(x) ? ' top' : ''}${app.pick?.k === x ? ' sel' : ''}${dec ? ' decided' : ''}" style="--h:${h}" data-act="pick" data-k="${x}" aria-label="${esc(fmtDate(x, 'long'))}: ${esc(countText(g, n, ev.settings))}${dec ? ` (${esc(t('decidedTag'))})` : ''}"><span class="dn">${Number(x.slice(8))}</span><span class="dc">${a || ''}</span>${dec ? `<i class="dk">${icon('check')}</i>` : ''}</button>`;
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
    label = windowLabel(w, zoneMove(ev));
  } else {
    g = M.tally(ev, v.people).get(p.k);
    if (!g) return '';
    label = ev.mode === 'dates' ? fmtDate(p.k, 'long') : slotLabel(p.k, ev.slot, zoneMove(ev));
  }
  const byId = new Map(v.people.map((x) => [x.id, x.name]));
  const wait = waitingOf(v);
  const names = (ids: string[]) => (ids.length ? ids.map((x) => `<span class="pn">${esc(byId.get(x))}</span>`).join('') : '<span class="muted">–</span>');
  return `<div class="detail">
    <h3>${esc(cap(label))}</h3>
    <div class="dg yes"><b>${icon('check')}${esc(t('canCome'))} (${g.yes.length})</b><div>${names(g.yes)}</div></div>
    ${g.maybe.length || ev.settings.maybe ? `<div class="dg maybe"><b>${icon('maybe')}${esc(t('ifNeedBe'))} (${g.maybe.length})</b><div>${names(g.maybe)}</div></div>` : ''}
    <div class="dg no"><b>${icon('x')}${esc(t('cannot'))} (${g.no.length})</b><div>${names(g.no)}</div></div>
    ${wait.length ? `<div class="dg wait"><b>${icon('clock')}${esc(t('noAnswer'))} (${wait.length})</b><div>${wait.map((w) => `<span class="pn">${esc(w.name)}</span>`).join('')}</div></div>` : ''}
    ${decideHtml(v, p.k)}
  </div>`;
}

// What the picked date or time is called: "fredag 27. november" or
// "onsdag 18. november, 10:00–11:00" (times mode: the whole window).
export function whenLabel(ev: M.PollEvent, key: string): string {
  if (ev.mode === 'dates') return fmtDate(key, 'long');
  const w = M.windows(ev, []).find((x) => x.key === key);
  return w ? windowLabel(w, zoneMove(ev)) : slotLabel(key, ev.slot, zoneMove(ev));
}

// Under the details of an option: pick it as the final date (the admin, or
// anyone the settings let).
function decideHtml(v: M.View, key: string): string {
  const ev = v.event;
  if (!M.canDecide(v, ev.settings) || !M.decisionKeys(ev).has(key)) return '';
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
      ${M.canDecide(v, ev.settings) ? `<button type="button" class="btn" data-act="undecide">${esc(t('undoDecision'))}</button>` : ''}
    </div>
  </section>`;
}

export function updateDetail(): void {
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
  const decidedKeys = M.windows(ev, v.people).find((w) => w.key === ev.decided)?.keys ?? [];
  const decided = new Set(decidedKeys);
  const selKeys = (): Set<string> => {
    const p = app.pick;
    if (!p) return new Set();
    if (p.win) return new Set(M.windows(ev, v.people).find((w) => w.key === p.k)?.keys ?? []);
    return new Set([p.k]);
  };
  let sel = selKeys();
  app.resGrid = new TimeGrid(el, {
    mode: 'view',
    ...gridLayout(ev),
    rowh: rowHeight(ev.slot),
    page: app.gridPage,
    allowed: (k) => opts.has(k),
    decorate: (k) => {
      const g = T.get(k) ?? { key: k, yes: [], maybe: [], no: [] };
      const a = M.score(g, ev.settings);
      const h = heat(g, n, ev.settings);
      const dec = decided.has(k) ? ` decided${k === decidedKeys[0] ? ' dstart' : ''}${k === decidedKeys[decidedKeys.length - 1] ? ' dend' : ''}` : '';
      return { cls: `heat${hi(h)}${topKeys.has(k) ? ' top' : ''}${sel.has(k) ? ' sel' : ''}${dec}`, h, text: n && a ? String(a) : '' };
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
  // Your own entry: your personal link's (v.me), or the one this device has
  // the personal link to.
  const mine = (p: M.Person) => p.id === v.me || Boolean(stored?.pid && p.id === stored.pid);
  const rows = v.people
    .map((p) => {
      const edit = M.canEdit(who, ev.settings, p.id);
      const btn = (act: string, ic: string, label: string) => `<button type="button" class="icon-btn" data-act="${act}" data-pid="${p.id}" title="${esc(label)}" aria-label="${esc(label)}">${icon(ic)}</button>`;
      return `<li class="${mine(p) ? 'mine' : ''}" data-pid="${p.id}">
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
  // "6 av 15": everyone listed or answered. With hidden answers only the
  // admin gets the numbers (poll.ts), so the others see none.
  const n = v.count;
  const total = (n ?? 0) + (v.waitingCount ?? 0);
  const listed = n !== undefined && total > n;
  const pct = total ? (100 * (n ?? 0)) / total : 0;
  return `<section class="card people">
    <h2>${esc(t('responses'))}${n === undefined ? '' : ` <span class="count">${listed ? esc(t('nOfTotal', { n, m: total })) : n}</span>`}</h2>
    ${listed ? `<div class="progress" role="img" aria-label="${esc(t('answeredOf', { n, m: total }))}"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
    ${v.hidden ? `<p class="muted small">${esc(t('hiddenPeople'))}</p>` : ''}
    ${rows ? `<ul class="plist">${rows}</ul>` : v.hidden ? '' : `<p class="muted">${esc(t('noAnswersYet'))}</p>`}
    ${waitingHtml(v, stored)}
  </section>`;
}

// Who the organisers listed and hasn't answered yet: for the admin with
// their links and a reminder to copy, for others just the names (not with
// hidden answers: the server sends only your own then).
function waitingHtml(v: M.View, stored: Stored | null): string {
  const list = waitingOf(v);
  const admin = v.role === 'admin';
  const addBtn = admin ? `<button type="button" class="btn small" data-act="add-names">${icon('plus')}${esc(t('addNames'))}</button>` : '';
  if (!list.length || (v.hidden && !admin)) return addBtn ? `<div class="row wrap people-tools">${addBtn}</div>` : '';
  const ev = v.event;
  const who = { role: v.role, me: v.me };
  const mine = (id: string) => id === v.me || id === stored?.pid;
  const you = (id: string) => (mine(id) ? ` <span class="tag">${esc(t('you'))}</span>` : '');
  const head = `<h3 class="wait-head">${esc(t('notAnswered'))} <span class="count">${list.length}</span></h3>`;
  // Rows with buttons: the admin's, and everyone's when anyone may change
  // the answers (then "Svar for Kari" for all; the list stays the admin's).
  const rows = M.canEdit(who, ev.settings, null);
  if (!rows) {
    // Someone with the event link taps their name to answer as it.
    const tap = M.canClaim(who, ev.settings);
    const names = list
      .map((w) =>
        tap
          ? `<button type="button" class="pn tap" data-act="edit-entry" data-pid="${w.id}" title="${esc(t('answerAs', { name: w.name }))}">${esc(w.name)}</button>`
          : `<span class="pn${mine(w.id) ? ' mine' : ''}">${esc(w.name)}${you(w.id)}</span>`,
      )
      .join('');
    return `${head}<div class="wait-names">${names}</div>`;
  }
  const btn = (act: string, ic: string, label: string, pid: string) => `<button type="button" class="icon-btn" data-act="${act}" data-pid="${pid}" title="${esc(label)}" aria-label="${esc(label)}">${icon(ic)}</button>`;
  // A long list shows the first WAIT_SHOWN.
  const shown = app.waitOpen ? list : list.slice(0, WAIT_SHOWN);
  const items = shown
    .map(
      (w) => `<li class="wait${mine(w.id) ? ' mine' : ''}" data-pid="${w.id}">
        <span class="avatar" style="--hue:${hue(w.name)}" aria-hidden="true">${esc(initials(w.name))}</span>
        <div class="pinfo"><b>${esc(w.name)}${you(w.id)}</b><span class="psum">${esc(t('notAnswered'))}</span></div>
        <div class="pact">
          ${admin ? btn('person-link', 'link', t('copyPersonLink', { name: w.name }), w.id) : ''}
          ${M.canEdit(who, ev.settings, w.id) ? btn('edit-entry', 'edit', t(w.id === v.me ? 'editYourAnswers' : 'answerFor', { name: w.name }), w.id) : ''}
          ${admin || w.id === v.me ? btn('delete-entry', 'trash', admin ? t('removeName', { name: w.name }) : t('deleteMine'), w.id) : ''}
        </div>
      </li>`,
    )
    .join('');
  const more =
    list.length > WAIT_SHOWN
      ? `<p class="best-more wait-more"><button type="button" class="linkish small" data-act="wait-more" aria-expanded="${app.waitOpen}">${esc(app.waitOpen ? t('showFewer') : t('showAllNames', { n: list.length }))}<span class="chev" aria-hidden="true">${app.waitOpen ? '▴' : '▾'}</span></button></p>`
      : '';
  const tools = admin ? `<div class="row wrap people-tools">${addBtn}<button type="button" class="btn small" data-act="copy-reminder">${icon('copy')}${esc(t('copyReminder'))}</button></div>` : '';
  return `${head}<ul class="plist">${items}</ul>${more}${tools}`;
}
const WAIT_SHOWN = 10;

// The organisers list who they expect: names, one per line.
export async function addNames(): Promise<void> {
  const { id, token } = here();
  let text = '';
  const r = await dialog(
    `<h3>${esc(t('addNamesTitle'))}</h3>
    <p>${esc(t('addNamesText'))}</p>
    <textarea id="names" rows="8" maxlength="${M.LIMITS.people * (M.LIMITS.person + 1)}" aria-label="${esc(t('addNamesTitle'))}" placeholder="${esc(t('addNamesPh'))}"></textarea>
    <div class="row end">
      <button value="" class="btn">${esc(t('cancel'))}</button>
      <button value="add" class="btn primary">${icon('plus')}${esc(t('addNamesOk'))}</button>
    </div>`,
    {
      onOpen: (dlg) => {
        const ta = $<HTMLTextAreaElement>('#names', dlg);
        ta.addEventListener('input', () => (text = ta.value));
        ta.focus();
      },
    },
  );
  if (r !== 'add') return;
  const names = M.cleanNames(text);
  if (!names.length) return toast(t('err.names'));
  try {
    const res = await api<{ view: M.View; added: number; skipped: number }>('POST', `/events/${id}/invite`, { token, body: { names } });
    setView(res.view);
    render();
    toast([res.added ? t('namesAdded', { n: res.added }) : '', res.skipped ? t('namesSkipped', { n: res.skipped }) : ''].filter(Boolean).join(' '));
  } catch (e) {
    toast(errText(e));
  }
}

// Anyone the settings let (`details`) changes the event's name, location
// and description; the admin does it in the event form.
export async function editDetails(): Promise<void> {
  const { id, token } = here();
  const ev = current().event;
  const d = { name: ev.name, location: ev.location, description: ev.description };
  const r = await dialog(
    `<h3>${esc(t('editDetails'))}</h3>
    <div id="details-form" class="stack">
      ${field('name', `${t('eventName')} *`, `<input name="name" maxlength="${M.LIMITS.name}" required value="${esc(d.name)}" autocomplete="off">`)}
      ${field('location', t('locationOptional'), `<input name="location" maxlength="${M.LIMITS.location}" value="${esc(d.location)}" autocomplete="off">`)}
      ${field('description', t('descriptionOptional'), `<textarea name="description" rows="3" maxlength="${M.LIMITS.description}">${esc(d.description)}</textarea>`)}
      <p class="muted small">${esc(t('editDetailsHint'))}</p>
    </div>
    <div class="row end">
      <button value="" class="btn">${esc(t('cancel'))}</button>
      <button value="save" class="btn primary">${icon('check')}${esc(t('save'))}</button>
    </div>`,
    {
      onOpen: (dlg) => {
        // In the dialog's own form (ui.ts): a form inside it would be dropped.
        const box = $('#details-form', dlg);
        box.addEventListener('input', (e) => {
          const el = e.target as HTMLInputElement;
          if (el.name === 'name' || el.name === 'location' || el.name === 'description') d[el.name] = el.value;
        });
        // Enter in a field saves (the form's first button is Cancel).
        box.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || !(e.target as Element).matches('input')) return;
          e.preventDefault();
          $<HTMLButtonElement>('button[value="save"]', dlg).click();
        });
      },
    },
  );
  if (r !== 'save') return;
  if (!d.name.trim()) return toast(t('err.name'));
  try {
    const { view } = await api<{ view: M.View }>('PUT', `/events/${id}/details`, { token, body: d });
    setView(view);
    render();
    toast(t('detailsSaved'));
  } catch (e) {
    toast(errText(e));
  }
}

// For the group chat: "Ola, Per og Kari: husk å svare på «Sommerfest»! <link>".
export function copyReminder(): void {
  const v = current();
  const names = waitingOf(v).map((w) => w.name);
  if (names.length) copyText(t('reminderText', { names: joinAnd(names), name: v.event.name, url: eventUrl(here().id) }));
}
