// Keeping the open event page current: live updates from its socket
// (live.ts), the 30 s refresh without one, and noticing a new version of the
// app.

import * as M from '../shared/model.ts';
import { t } from './i18n.ts';
import { api, ApiError, writing } from './api.ts';
import * as live from './live.ts';
import { $opt, esc, toast } from './ui.ts';
import { app } from './state.ts';
import { subUrl, subView } from './route.ts';
import { menuOpen } from './shell.ts';
import { render, setView, renderLoadError } from './render.ts';

// The version of this app: the hash in its file name (scripts/build.mjs).
const APP = /\/app-([A-Za-z0-9]+)\.js/.exec(import.meta.url)?.[1] ?? '';

// Nothing that a redraw would disturb: the overview, with no dialog or menu open.
const idle = () => app.route?.page === 'event' && subView().kind === 'overview' && !$opt('dialog[open]') && !menuOpen();

// A message on the event's live socket (live.ts). Only the latest counts.
export function onLive(m: M.LiveMessage, key: string): void {
  if (m.type === 'view' && m.app && APP && m.app !== APP) void checkVersion(m.app);
  app.liveMsg = { m, key };
  applyLive();
}

// Apply the latest live message, once nothing of ours is in flight (its
// reply is newer or the same) and it is about the page we are on and is
// newer than what we have. The data always goes in at once (forms and
// dialogs read current() and keep their own drafts); the page is drawn
// again only when idle, or later (app.stale).
function applyLive(): void {
  const held = app.liveMsg;
  const r = app.route;
  if (!held || writing()) return;
  app.liveMsg = null;
  if (r?.page !== 'event' || held.key !== `${r.id}/${r.token ?? ''}`) return;
  const { m } = held;
  if (m.type === 'gone') {
    live.follow(null);
    app.view = null;
    app.viewKey = null;
    if (subView().kind !== 'overview') history.replaceState(null, '', subUrl(''));
    $opt<HTMLDialogElement>('dialog[open]')?.close('');
    return renderLoadError(new ApiError(404, 'notFound'));
  }
  const before = app.view;
  if (before && m.view.rev < before.rev) return;
  if (JSON.stringify(m.view) === app.viewJson) return;
  setView(m.view, r.id, r.token);
  if (idle()) return redraw(before);
  app.stale = true;
  // In a form: say once that the event itself changed under it.
  if (subView().kind !== 'overview' && before && JSON.stringify(before.event) !== JSON.stringify(m.view.event) && !app.toldChanged) {
    app.toldChanged = true;
    toast(t('changedMeanwhile'));
  }
}
window.addEventListener('api-idle', applyLive);

// Draw the overview again with new data, where the reader is: the same
// scroll position and focus, the one-off notice still there, and the people
// whose answers changed briefly marked.
function redraw(before: M.View | null): void {
  const y = window.scrollY;
  const a = document.activeElement as HTMLElement | null;
  const focus = a?.dataset.act ? `[data-act="${a.dataset.act}"]${a.dataset.pid ? `[data-pid="${a.dataset.pid}"]` : ''}${a.dataset.d ? `[data-d="${a.dataset.d}"]` : ''}` : a?.id ? `#${a.id}` : '';
  app.stale = false;
  app.flash = app.flashShown;
  render();
  window.scrollTo(0, y);
  if (focus) $opt(focus)?.focus({ preventScroll: true });
  const v = app.view;
  if (!before || !v) return;
  for (const p of v.people) {
    const old = before.people.find((x) => x.id === p.id);
    if (!old || old.updated !== p.updated) $opt(`.plist li[data-pid="${p.id}"]`)?.classList.add('fresh');
  }
}

// Draw a page that waited (a dialog or menu was open) once it is idle.
setInterval(() => {
  if (app.stale && idle()) redraw(null);
}, 1000);

// The event's Poll object runs a different app version than ours. Right
// after a deploy it can still be the old one (Durable Objects take new code
// later), so ask the page itself which app is live now (the HTML is never
// cached) and only offer a reload if that one isn't ours either. Once per
// version the socket names (again after a failed check).
let versionAsked = '';
async function checkVersion(other: string): Promise<void> {
  if (versionAsked === other || $opt('#update')) return;
  versionAsked = other;
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const now = /\/app-([A-Za-z0-9]+)\.js/.exec(html)?.[1];
    if (now && now !== APP) newVersion();
  } catch {
    versionAsked = '';
  }
}

// A new version of the app is live: say so once, above the header, with a button to reload.
function newVersion(): void {
  if ($opt('#update')) return;
  const el = document.createElement('div');
  el.id = 'update';
  el.className = 'update';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(t('newVersion'))}</span><button type="button" class="btn small" data-act="reload">${esc(t('reload'))}</button>`;
  document.body.prepend(el);
}

// Without the live socket (not yet open, or blocked), keep the results
// fresh the old way: every 30 s and on tab focus, while idle.
async function refreshIfIdle(): Promise<void> {
  const r = app.route;
  if (live.isOpen() || r?.page !== 'event' || !app.view || document.visibilityState !== 'visible' || !idle()) return;
  try {
    const { view } = await api<{ view: M.View }>('GET', `/events/${r.id}`, { token: r.token });
    if (app.route !== r || !idle() || (app.view && view.rev < app.view.rev)) return;
    if (JSON.stringify(view) !== app.viewJson) {
      const before = app.view;
      setView(view, r.id, r.token);
      redraw(before);
    }
  } catch {
    // Offline or gone: keep what we have.
  }
}
setInterval(refreshIfIdle, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  live.wake();
  refreshIfIdle();
});
