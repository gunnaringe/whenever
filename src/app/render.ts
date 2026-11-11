// Which view to draw for the address, loading the event first if needed.

import * as M from '../shared/model.ts';
import { t, getLang } from './i18n.ts';
import { api, ApiError } from './api.ts';
import * as live from './live.ts';
import * as store from './store.ts';
import { $opt, esc, hideToast } from './ui.ts';
import { app, here, current, unsaved, errText } from './state.ts';
import { moveToken, parseRoute, subView, closeSub } from './route.ts';
import { paint } from './shell.ts';
import { renderHome, renderFind } from './home.ts';
import { renderForm } from './form.ts';
import { renderOverview } from './overview.ts';
import { renderAnswer } from './answer.ts';
import { onLive } from './sync.ts';

export async function render(): Promise<void> {
  const n = ++app.renders;
  moveToken();
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
    app.bestOpen = false;
    app.flashShown = null;
    app.toldChanged = false;
    // A toast's action (like the form's Undo) belongs to the view it came from.
    if ($opt('#toast .toast-act')) hideToast();
    window.scrollTo(0, 0);
  }
  app.formGrid = null;
  app.resGrid = null;
  app.refreshResGrid = null;
  app.stale = false;

  if (r.page !== 'event') live.follow(null);
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
      live.follow(null);
      return renderLoadError(e);
    }
  }
  live.follow(r.id, r.token, onLive);
  const v = current();
  if (s.kind === 'edit') {
    if (v.role !== 'admin') return closeSub();
    return renderForm(v);
  }
  if (s.kind === 'answer') return renderAnswer(v, s.pid);
  return renderOverview(v);
}

export function setView(view: M.View, id = here().id, token = here().token): void {
  app.view = view;
  app.viewKey = `${id}/${token ?? ''}`;
  app.viewJson = JSON.stringify(view);
  // A Poll object still on the code from before sends settings without the
  // newer ones: they read as their defaults.
  view.event.settings = M.settingsOf(view.event.settings);
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

export function renderLoadError(e: unknown): void {
  document.title = t('appName');
  if (e instanceof ApiError && e.status === 404) {
    const { id } = here();
    if (store.get(id)) store.forget(id);
    return paint(`<section class="card notice warn"><h1>${esc(t('eventNotFound'))}</h1><p>${esc(t('eventNotFoundText'))}</p><p><a class="btn" href="/" data-link>${esc(t('toHome'))}</a></p></section>`);
  }
  paint(`<section class="card notice warn"><p>${esc(errText(e))}</p><p><button type="button" class="btn" data-act="retry">${esc(t('retry'))}</button></p></section>`);
}
