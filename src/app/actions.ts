// What the event page's buttons do that isn't a view of its own (links,
// deleting, picking the date, closing, leaving), and the theme and language
// choices.

import * as M from '../shared/model.ts';
import { t, getLang, setLang, isLang } from './i18n.ts';
import { api } from './api.ts';
import * as store from './store.ts';
import type { Stored } from './store.ts';
import { $opt, esc, icon, toast, ask, menu, dialog } from './ui.ts';
import { THEMES, isTheme, applyTheme } from './theme.ts';
import { icsFor, icsName } from './ics.ts';
import { app, here, current, entryOf, errText } from './state.ts';
import { eventPath, go, eventUrl, linkUrl } from './route.ts';
import { themeItems, themeLabel, linkBox } from './shell.ts';
import { render, setView } from './render.ts';
import { whenLabel } from './overview.ts';

export function linkDialog(title: string, text: string, url: string): Promise<string> {
  return dialog(`
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    ${linkBox(url, { share: true })}
    <div class="row end"><button value="" class="btn primary">${esc(t('done'))}</button></div>`);
}

export async function deleteEntry(pid: string): Promise<void> {
  const v = current();
  const { id, token } = here();
  const p = entryOf(v, pid);
  if (!p) return;
  const own = pid === v.me;
  const q = own ? t('deleteMineQ') : t(p.waiting ? 'removeNameQ' : 'deleteEntryQ', { name: p.name });
  if (!(await ask(q, { ok: t(p.waiting && !own ? 'remove' : 'delete'), danger: true }))) return;
  try {
    const { view } = await api<{ view: M.View }>('DELETE', `/events/${id}/people/${pid}`, { token });
    if (store.get(id)?.pid === pid) store.forgetMe(id);
    toast(t('deleted'));
    if (own && v.role !== 'admin') {
      setView(view, id, null);
      go(eventPath(id, null), true);
    } else {
      setView(view);
      render();
    }
  } catch (e) {
    toast(errText(e));
  }
}

export async function personLink(pid: string): Promise<void> {
  const { id, token } = here();
  const p = entryOf(current(), pid);
  try {
    const r = await api<{ token: string }>('POST', `/events/${id}/people/${pid}/link`, { token, body: { reset: false } });
    linkDialog(t('personLinkTitle', { name: p?.name ?? '' }), t('personLinkText'), linkUrl(id, r.token));
  } catch (e) {
    toast(errText(e));
  }
}

// Picking the final date or time (key), or undoing it (null). The admin's
// pick also closes the event for new answers; anyone else's (with
// `decide`) leaves it open, as only the organisers close it.
export async function decide(key: string | null): Promise<void> {
  const v = current();
  const ev = v.event;
  const { id, token } = here();
  const admin = v.role === 'admin';
  const q = key ? t(admin ? 'decideQ' : 'decideQOpen', { when: whenLabel(ev, key) }) : t(admin ? 'undecideQ' : 'undecideQOpen');
  if (!(await ask(q, { ok: t(key ? 'decideOk' : 'undoDecision') }))) return;
  try {
    const settings = key ? { ...ev.settings, closed: true } : ev.settings;
    const body = { event: { ...ev, settings, decided: key ?? undefined } };
    const { view } = admin
      ? await api<{ view: M.View }>('PUT', `/events/${id}`, { token, body })
      : await api<{ view: M.View }>('POST', `/events/${id}/decide`, { token, body: { decided: key } });
    setView(view);
    render();
    toast(t(key ? 'decidedToast' : 'undecidedToast'));
    if (key) window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    toast(errText(e));
  }
}

export function downloadIcs(): void {
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

export async function toggleClosed(): Promise<void> {
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
    history.replaceState(null, '', eventPath(id, r.token));
    render();
    linkDialog(title, text, linkUrl(id, r.token));
  } catch (e) {
    toast(errText(e));
  }
}

export async function adminMore(): Promise<void> {
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

// No accounts: being "signed in" is having the link on this device. Signing
// out forgets the event here (both links) after showing the link once more,
// and leaves for the home page, replacing the token URL in the history.
export async function leave(): Promise<void> {
  const v = current();
  const { id, token } = here();
  if (!token) return;
  const admin = v.role === 'admin';
  const email = admin ? v.adminEmails?.length : v.people.find((p) => p.id === v.me)?.email;
  const r = await dialog(`
    <h3>${esc(t('leaveQ'))}</h3>
    <p>${esc(t(admin ? 'leaveTextAdmin' : 'leaveTextMine'))}</p>
    ${linkBox(linkUrl(id, token), { label: t(admin ? 'adminLinkTitle' : 'yourLink') })}
    ${email ? `<p class="muted small">${esc(t('leaveEmail'))}</p>` : ''}
    <div class="row end">
      <button value="" class="btn">${esc(t('cancel'))}</button>
      <button value="yes" class="btn primary">${icon('logout')}${esc(t('leave'))}</button>
    </div>`);
  if (r !== 'yes') return;
  store.forget(id);
  app.view = null;
  app.viewKey = null;
  go('/', true);
  toast(t('leftToast'));
}

export async function meMore(): Promise<void> {
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
export async function pickTheme(): Promise<void> {
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
export function setTheme(x: string): void {
  if (!isTheme(x)) return;
  store.setTheme(x);
  applyTheme(x);
  const m = $opt('#theme-menu');
  if (m) m.innerHTML = themeItems();
  $opt('.theme-btn')?.setAttribute('aria-label', themeLabel());
}

export function switchLang(l: string): void {
  if (!isLang(l) || l === getLang()) return;
  setLang(l);
  store.setLang(l);
  render();
}
