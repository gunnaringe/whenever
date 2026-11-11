// The answer editor: adding your answers, or changing an entry.

import * as M from '../shared/model.ts';
import { t, fmtDate, durationLabel, cap } from './i18n.ts';
import type { Key } from './i18n.ts';
import { api, ApiError } from './api.ts';
import * as store from './store.ts';
import { $, $opt, $$, esc, icon, toast, menu } from './ui.ts';
import type { MenuItem } from './ui.ts';
import { calendarHtml, bindPaint } from './calendar.ts';
import { TimeGrid } from './timegrid.ts';
import { type AnswerDraft, app, here, current, answer, data, touch, waitingOf, entryOf, hasDraft, errText } from './state.ts';
import { eventPath, subUrl, go, closeSub, linkUrl } from './route.ts';
import { paint, field, setBusy } from './shell.ts';
import { render, setView } from './render.ts';
import { rowHeight } from './form.ts';
import { rowsFor } from './overview.ts';
import { linkDialog } from './actions.ts';

export function renderAnswer(v: M.View, sub: string | null): void {
  const ev = v.event;
  const who = { role: v.role, me: v.me };
  // 'new': the admin adds answers for someone else.
  // ('new' is from before: the admin's "for someone else".)
  const pid = sub === 'new' ? null : sub;
  const found = entryOf(v, pid ?? v.me);
  if (pid && !found) {
    toast(t('err.person'));
    return closeSub();
  }
  // A waiting name tapped in the Svar card by someone with the event link:
  // a new answer as that name, unless they may change its entry anyway.
  const tapped = pid && found?.waiting && M.canClaim(who, ev.settings) && !M.canEdit(who, ev.settings, pid) ? found : undefined;
  const target = tapped ? undefined : found;
  // A new answer: under a new name, or as a listed one.
  const claimable = target ? [] : v.role === 'admin' || M.canClaim(who, ev.settings) ? waitingOf(v) : [];
  if (target ? !M.canEdit(who, ev.settings, target.id) : !M.canAdd(who, ev.settings) && !claimable.length) {
    toast(t(ev.settings.closed ? 'err.closed' : 'err.forbidden'));
    return closeSub();
  }
  // The admin link's entries are never its own: they get no email.
  const own = v.role !== 'admin' && (target ? target.id === v.me : true);
  if (!app.answer) {
    app.answer = {
      pid: target?.id ?? null,
      claim: tapped?.id ?? null,
      claimTyped: false,
      loaded: null,
      // Never answered: someone answering for them mustn't overwrite what
      // they answer meanwhile (a draft of theirs is theirs to see).
      waiting: Boolean(target?.waiting),
      counted: true,
      own,
      // Tapped: the name's draft, but never its email (poll.ts).
      name: target?.name ?? tapped?.name ?? '',
      comment: target?.comment ?? tapped?.comment ?? '',
      email: target?.email ?? '',
      answers: { ...(target?.answers ?? tapped?.answers ?? {}) },
      brush: M.YES,
      view: 'cal',
      dirty: false,
    };
    if (tapped && hasDraft(tapped)) app.answer.loaded = { pid: tapped.id, was: formSnap(app.answer) };
  }
  const a = answer();
  const fresh = (target ?? tapped)?.waiting && !hasDraft(target ?? tapped);
  const title = target
    ? own
      ? t(fresh ? 'addYourAnswers' : 'editYourAnswers')
      : t(target.waiting ? 'answerFor' : 'editAnswersOf', { name: target.name })
    : t(!own ? 'addAnswers' : fresh === false ? 'editYourAnswers' : 'addYourAnswers');
  // A new answer can be one of the listed names still waiting: the admin
  // answers for them, someone with the event link says it's them (as the
  // settings let, see poll.ts), and must when only those may answer.
  const listOnly = !target && !M.canAdd(who, ev.settings);
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
    <a class="back" href="${esc(subUrl(''))}" data-act="cancel-answer">${icon('back')}${esc(t('back'))}</a>
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
        ${field('name', `${t(own ? 'yourName' : 'personName')} *`, `<input name="name" required maxlength="${M.LIMITS.person}" value="${esc(a.name)}"${own ? ' autocomplete="name"' : ' autocomplete="off"'}${nameFixed(v, a) ? ' readonly' : ''}>`, nameFixed(v, a) ? t('nameFixed') : '')}
        ${claimable.length ? claimHtml(claimable, v.role === 'admin' ? 'admin' : listOnly ? 'list' : 'claim', a.claim) : ''}
        ${field('comment', t('commentOptional'), `<input name="comment" maxlength="${M.LIMITS.comment}" value="${esc(a.comment)}" placeholder="${esc(t('commentPh'))}">`)}
        ${
          a.own
            ? `<details class="fold" ${a.email ? 'open' : ''}>
                <summary>${esc(t('addEmail'))}</summary>
                ${field('email', t('emailOptional'), `<input type="email" name="email" maxlength="${M.LIMITS.email}" value="${esc(a.email)}" autocomplete="email" inputmode="email">`, t('emailHint'))}
              </details>`
            : ''
        }
        <label class="check counted">
          <input type="checkbox" name="counted" ${a.counted ? 'checked' : ''}>
          <span><b>${esc(t('showAnswered'))}</b></span>
        </label>
        <p id="draft-note" class="muted small" ${a.counted ? 'hidden' : ''}>${esc(t(own ? 'draftNoteOwn' : 'draftNote'))}</p>
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
    if (n === 'counted') {
      a.counted = el.checked;
      a.dirty = true;
      $('#draft-note').hidden = a.counted;
    }
    // Typing a listed name picks it, and typing on ("Ola" to "Olav")
    // unpicks it again. A name tapped stays picked ("Kari N.").
    if (n === 'name' && (!a.claim || a.claimTyped)) {
      const w = claimable.find((x) => M.nameKey(x.name) === M.nameKey(el.value));
      if ((w?.id ?? null) !== a.claim) setClaim(w?.id ?? null, true);
    }
    if (n === 'name') filterClaims();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveAnswer();
  });
  mountPicker(v);
  if (claimable.length) {
    lockClaims();
    filterClaims();
  }
}

// "Er du en av disse?": the listed names still waiting, to answer as one,
// under the name field. At most three rows (a fade and «Vis alle» for the
// rest); typing filters them (filterClaims) in a box that never shrinks
// meanwhile (lockClaims), so nothing under it moves.
function claimHtml(list: M.Waiting[], kind: 'admin' | 'list' | 'claim', on: string | null): string {
  const admin = kind === 'admin';
  return `<fieldset class="claim">
    <legend>${esc(t(admin ? 'claimAdmin' : kind === 'list' ? 'claimWho' : 'claimQ'))}</legend>
    <div class="claim-box">
      <div class="chip-row">${list.map((w) => `<button type="button" class="chip${w.id === on ? ' on' : ''}" data-act="claim" data-pid="${w.id}" aria-pressed="${w.id === on}">${esc(w.name)}</button>`).join('')}</div>
      <p class="claim-none muted small" hidden>${esc(t('claimNone'))}</p>
    </div>
    <p class="best-more claim-more" hidden><button type="button" class="linkish small" data-act="claim-more" aria-expanded="false"></button></p>
    <p id="claim-status" class="vh" aria-live="polite"></p>
    <p class="muted small">${esc(t(admin ? 'claimAdminHint' : kind === 'list' ? 'claimListHint' : 'claimHint'))}</p>
  </fieldset>`;
}

// Show the names that fit what is typed: the start of any word, without
// case ("ka" finds Kari and Anne Karlsen). The picked one always shows.
function filterClaims(): void {
  const box = $opt('.claim-box');
  if (!box) return;
  const a = answer();
  const q = M.nameKey(a.name);
  let n = 0;
  for (const c of $$<HTMLButtonElement>('.claim-box .chip')) {
    const show = !q || c.dataset.pid === a.claim || ` ${M.nameKey(c.textContent ?? '')}`.includes(` ${q}`);
    c.hidden = !show;
    if (show) n += 1;
  }
  $('.claim-none').hidden = n > 0;
  $('#claim-status').textContent = q ? (n ? t('claimMatches', { n }) : t('claimNone')) : '';
  fitClaims();
}

// The box's height with every name, cut at three rows unless opened, or
// with only the no-match line if that is taller (a short list): it keeps
// that while the names are filtered, so nothing under it moves.
export function lockClaims(): void {
  const box = $opt('.claim-box');
  if (!box) return;
  const chips = $$<HTMLButtonElement>('.claim-box .chip');
  const none = $('.claim-none');
  const was = chips.map((c) => c.hidden);
  const noneWas = none.hidden;
  box.style.minHeight = '';
  for (const c of chips) c.hidden = false;
  none.hidden = true;
  const all = box.offsetHeight;
  // A list longer than three rows keeps the «Vis alle» line, also while
  // filtered down to a few (fitClaims).
  if (!box.classList.contains('open')) box.dataset.long = String(box.scrollHeight > box.clientHeight + 1);
  for (const c of chips) c.hidden = true;
  none.hidden = false;
  box.style.minHeight = `${Math.max(all, box.offsetHeight)}px`;
  chips.forEach((c, i) => (c.hidden = was[i]));
  none.hidden = noneWas;
}

// Names below the three rows: cut off with a fade, out of reach of Tab
// until «Vis alle» opens the box.
export function fitClaims(): void {
  const box = $opt('.claim-box');
  if (!box) return;
  const open = box.classList.contains('open');
  const chips = $$<HTMLButtonElement>('.claim-box .chip');
  let cut = 0;
  for (const c of chips) {
    const out = !open && !c.hidden && c.offsetTop + c.offsetHeight > box.clientHeight + 1;
    c.inert = out;
    if (out) cut += 1;
  }
  box.classList.toggle('cut', cut > 0);
  const more = $('.claim-more');
  more.hidden = box.dataset.long !== 'true';
  const b = $('button', more);
  b.style.visibility = open || cut ? '' : 'hidden';
  b.textContent = open ? t('showFewer') : t('showAllNames', { n: chips.length });
  b.setAttribute('aria-expanded', String(open));
}
window.addEventListener('resize', () => {
  if (!$opt('.claim-box')) return;
  lockClaims();
  fitClaims();
});

// Pick a listed name to answer as (again: unpick), and fill in the name.
export function setClaim(pid: string | null, typed = false): void {
  const a = answer();
  const before = formSnap(a);
  // The draft of the name picked before goes out again, unless changed.
  if (a.loaded && a.loaded.pid !== pid) {
    if (before === a.loaded.was) Object.assign(a, { answers: {}, comment: '' });
    a.loaded = null;
  }
  a.claim = pid;
  a.claimTyped = typed && pid !== null;
  a.dirty = true;
  const w = pid ? waitingOf(current()).find((x) => x.id === pid) : null;
  const input = $opt<HTMLInputElement>('#answer-form [name="name"]');
  if (w && input && M.nameKey(input.value) !== M.nameKey(w.name)) {
    input.value = w.name;
    a.name = w.name;
  }
  // A name with a draft: it fills a form with nothing in it yet, so nobody
  // saves over a draft they haven't seen.
  if (w && !a.loaded && formSnap(a) === EMPTY_FORM && (Object.keys(w.answers ?? {}).length || w.comment)) {
    Object.assign(a, { answers: { ...w.answers }, comment: w.comment ?? '' });
    a.loaded = { pid: w.id, was: formSnap(a) };
  }
  if (formSnap(a) !== before) {
    // The calendar and the comment change: draw the form again, and go on
    // typing the name where you were.
    const typing = document.activeElement === input;
    render();
    const again = $opt<HTMLInputElement>('#answer-form [name="name"]');
    if (typing && again) {
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }
    return;
  }
  for (const b of $$('[data-act="claim"]')) {
    b.classList.toggle('on', b.dataset.pid === pid);
    b.setAttribute('aria-pressed', String(b.dataset.pid === pid));
  }
  if (input && input.readOnly !== nameFixed(current(), a)) {
    render();
    return;
  }
  filterClaims();
}

// The name can't be changed (without `rename`): on an entry, or a listed
// name tapped (a name typed is the listed one anyway; typing on unpicks it).
function nameFixed(v: M.View, a: AnswerDraft): boolean {
  if (M.canRename(v, v.event.settings)) return false;
  return Boolean(a.pid || (a.claim && !a.claimTyped));
}

// The answers and comment in the form, to compare (key order aside).
const formSnap = (a: AnswerDraft): string => JSON.stringify([Object.entries(a.answers).sort(), a.comment]);
const EMPTY_FORM = JSON.stringify([[], '']);

export function pickerToolbar(v: M.View): string {
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
export function setAns(k: string, val: number): void {
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

export function updatePickSum(): void {
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

export async function saveAnswer(): Promise<void> {
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
  if (!a.pid && !a.claim && !M.canAdd(v, v.event.settings)) {
    toast(t('err.listOnly'));
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
  // The admin answers for a listed name by changing its entry.
  const pid = a.pid ?? (v.role === 'admin' ? a.claim : null);
  if (a.claim && !pid) Object.assign(body, { claim: a.claim });
  if (pid && (a.waiting || pid === a.claim)) Object.assign(body, { waiting: true });
  if (!a.counted) Object.assign(body, { draft: true });
  setBusy(true);
  try {
    if (pid) {
      const { view } = await api<{ view: M.View }>('PUT', `/events/${id}/people/${pid}`, { token, body });
      setView(view);
      app.answer = null;
      toast(t(a.counted ? 'saved' : 'draftSaved'));
      closeSub();
    } else {
      const r = await api<M.Added>('POST', `/events/${id}/people`, { token, body });
      app.answer = null;
      if (v.role === 'admin') {
        setView(r.view);
        closeSub();
        linkDialog(t('personLinkTitle', { name }), t('addedByAdminText'), linkUrl(id, r.token));
      } else {
        store.put(id, { name: v.event.name, me: r.token, pid: r.pid });
        app.flash = { kind: 'savedNew', name, draft: !a.counted };
        setView(r.view, id, r.token);
        go(eventPath(id, r.token), true);
      }
    }
  } catch (e) {
    toast(errText(e));
    // They answered themselves while the admin was answering for them:
    // their answers stay, and so does the page with them.
    if (e instanceof ApiError && e.code === 'answered') {
      app.answer = null;
      try {
        setView((await api<{ view: M.View }>('GET', `/events/${id}`, { token })).view);
      } catch {
        // The live update brings it.
      }
      closeSub();
      return;
    }
    // Someone else answered as that name meanwhile: show what's left (and
    // take its draft out of the form, unless changed: it isn't yours).
    if (e instanceof ApiError && (e.code === 'taken' || e.code === 'person') && a.claim) {
      setClaim(null);
      try {
        setView((await api<{ view: M.View }>('GET', `/events/${id}`, { token })).view);
        render();
      } catch {
        // The live update brings it.
      }
    }
  } finally {
    setBusy(false);
  }
}
