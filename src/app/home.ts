// The start page, and finding your events by email (/find).

import * as M from '../shared/model.ts';
import { t, getLang } from './i18n.ts';
import { api } from './api.ts';
import * as store from './store.ts';
import type { Stored } from './store.ts';
import { $, $opt, esc, icon, toast } from './ui.ts';
import { app, errText } from './state.ts';
import { eventPath, go } from './route.ts';
import { paint, field, setBusy } from './shell.ts';

export function renderHome(): void {
  document.title = `${t('appName')} · ${t('tagline')}`;
  const mine = store.events();
  const row = (e: Stored & { id: string }) => {
    const links = [];
    if (e.admin) links.push(`<a class="btn small" href="${eventPath(e.id, e.admin)}" data-link>${esc(t('openAdmin'))}</a>`);
    if (e.me) links.push(`<a class="btn small" href="${eventPath(e.id, e.me)}" data-link>${esc(t('openMine'))}</a>`);
    if (!links.length) links.push(`<a class="btn small" href="${eventPath(e.id, null)}" data-link>${esc(t('open'))}</a>`);
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
// whether or not the address is known. The mail also has a one-tap link,
// /find#t=<token>: the token goes into memory and out of the address bar at
// once, and is only used when the button is tapped (a mail scanner that opens
// links must not use it up).

export const find = { email: '', sent: false, link: '' };
const LINK_HASH_RE = /^#t=([A-Za-z0-9_-]{32})$/;

interface Found {
  id: string;
  name: string;
  admin?: string;
  me?: string;
  pid?: string;
}

export function renderFind(): void {
  document.title = `${t('findTitle')} · ${t('appName')}`;
  const m = LINK_HASH_RE.exec(location.hash);
  if (m) {
    find.link = m[1];
    history.replaceState(null, '', '/find');
  }
  if (find.link) {
    paint(`
      <section class="card find">
        <h1>${esc(t('findTitle'))}</h1>
        <p class="muted">${esc(t('findLinkLead'))}</p>
        <div class="row wrap">
          <button type="button" class="btn primary big" data-act="find-link">${esc(t('findShow'))}</button>
          <button type="button" class="btn ghost" data-act="find-link-cancel">${esc(t('cancel'))}</button>
        </div>
      </section>`);
    return;
  }
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

export async function askCode(email: string, again = false): Promise<void> {
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
    found(r.events);
  } catch (err) {
    toast(errText(err));
    $opt<HTMLInputElement>('#find-form [name="code"]')?.select();
  } finally {
    setBusy(false);
  }
}

export async function useLink(): Promise<void> {
  if (app.busy || !find.link) return;
  setBusy(true);
  try {
    const r = await api<{ events: Found[] }>('POST', '/lookup/link', { body: { token: find.link } });
    found(r.events);
  } catch (err) {
    // Used or expired: back to asking for a code.
    find.link = '';
    toast(errText(err));
    renderFind();
  } finally {
    setBusy(false);
  }
}

// A code or link worked: these events' links are now on this device.
function found(events: Found[]): void {
  for (const e of events) {
    const patch: Partial<Stored> = { name: e.name };
    if (e.admin) patch.admin = e.admin;
    if (e.me) Object.assign(patch, { me: e.me, pid: e.pid });
    store.put(e.id, patch);
  }
  Object.assign(find, { email: '', sent: false, link: '' });
  toast(events.length ? t('findFound', { n: events.length }) : t('findNone'));
  go('/');
}
