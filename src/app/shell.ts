// The page's frame (the header with its menus, the footer) and the small
// pieces of HTML the views share.

import { t, getLang, LANGS, LANG_NAMES } from './i18n.ts';
import * as store from './store.ts';
import { $, $opt, $$, esc, icon, menu } from './ui.ts';
import { THEMES } from './theme.ts';
import { app, leaveOk } from './state.ts';
import { eventPath, go } from './route.ts';

// The header's menus (your events, theme, language) are popovers (see the
// handlers near the end). Browsers from before 2024 (Safari 16, Firefox 124) have
// none: there the buttons open the dialog menu instead. Never put data-act
// on a popover's button: the click delegation's preventDefault() would
// stop it opening.
const canPopover = 'popover' in HTMLElement.prototype;

// An item is a button (attrs: data-act and its data) or an in-app link
// (href). The current one is ticked and gets the focus, else the first.
interface DropItem {
  attrs?: string;
  href?: string;
  label: string;
  hint?: string;
  on: boolean;
}
const dropItems = (items: DropItem[]) => {
  const focus = Math.max(0, items.findIndex((i) => i.on));
  return items
    .map((i, n) => {
      const inner = `<span>${i.on ? icon('check') : ''}${esc(i.label)}</span>${i.hint ? `<small>${esc(i.hint)}</small>` : ''}`;
      const attrs = `class="menu-item${i.on ? ' on' : ''}"${i.on ? ' aria-current="true"' : ''}${n === focus ? ' autofocus' : ''}`;
      return i.href ? `<a ${attrs} href="${esc(i.href)}" data-link>${inner}</a>` : `<button type="button" ${attrs} ${i.attrs ?? ''}>${inner}</button>`;
    })
    .join('');
};

// The button that opens a header menu: a popover, or the dialog without.
const menuButton = (cls: string, menuId: string, fallbackAct: string, label: string, title: string, face: string) =>
  `<button type="button" class="btn ghost small menu-btn ${cls}" ${canPopover ? `popovertarget="${menuId}"` : `data-act="${fallbackAct}"`} aria-label="${esc(label)}" title="${esc(title)}">${face}<span class="chev" aria-hidden="true">▾</span></button>`;

export const themeItems = () => {
  const cur = store.getTheme();
  return dropItems(THEMES.map((x) => ({ attrs: `data-act="theme-set" data-theme="${x}"`, label: t(`theme.${x}`), hint: x === 'auto' ? t('theme.autoHint') : undefined, on: x === cur })));
};
export const themeLabel = () => `${t('theme')}: ${t(`theme.${store.getTheme()}`)}`;

// Your events on this device, to jump between them: the most recently
// opened first, each by its admin link, else your personal link.
const EVENTS_SHOWN = 8;
function eventItems(): DropItem[] {
  const cur = app.route?.page === 'event' ? app.route.id : null;
  const all = store.events();
  const items: DropItem[] = all.slice(0, EVENTS_SHOWN).map((e) => ({
    href: eventPath(e.id, e.admin || e.me || null),
    label: e.name || '–',
    hint: [e.admin ? t('tagAdmin') : '', e.me ? t('tagAnswered') : ''].filter(Boolean).join(' · ') || undefined,
    on: e.id === cur,
  }));
  if (all.length > EVENTS_SHOWN) items.push({ href: '/', label: t('showAllEvents', { n: all.length }), on: false });
  return items;
}

export async function pickEvent(): Promise<void> {
  const items = eventItems();
  const href = await menu(
    t('yourEvents'),
    items.map((i) => ({ id: i.href ?? '', label: i.label, hint: i.hint, on: i.on })),
  );
  if (href && (await leaveOk())) go(href);
}

export function paint(inner: string): void {
  const cur = getLang();
  const events = eventItems();
  $('#app').innerHTML = `
    <header class="bar">
      <a class="brand" href="/" data-link><img src="/icons/icon.svg" alt="" width="28" height="28"><span>${esc(t('appName'))}</span></a>
      <span class="grow"></span>
      ${events.length ? menuButton('events-btn', 'events-menu', 'events-pick', t('yourEvents'), t('yourEvents'), icon('cal')) : ''}
      ${menuButton('theme-btn', 'theme-menu', 'theme', themeLabel(), t('theme'), icon('theme'))}
      ${menuButton('lang-btn', 'lang-menu', 'lang-pick', `${t('language')}: ${LANG_NAMES[cur]}`, t('language'), cur.toUpperCase())}
      ${
        canPopover
          ? `${events.length ? `<div id="events-menu" class="dropdown" popover>${dropItems(events)}</div>` : ''}
      <div id="theme-menu" class="dropdown" popover>${themeItems()}</div>
      <div id="lang-menu" class="dropdown" popover>${dropItems(LANGS.map((l) => ({ attrs: `data-act="lang" data-lang="${l}" lang="${l}"`, label: LANG_NAMES[l], on: l === cur })))}</div>`
          : ''
      }
    </header>
    <main class="page">${inner}</main>
    <footer class="foot">
      <a href="/privacy">${icon('lock')}${esc(t('privacy'))}</a>
      <a href="https://github.com/gunnaringe/whenever" rel="noopener">${icon('code')}${esc(t('sourceCode'))}</a>
      <a href="https://apphub.casa">${icon('grid')}apphub.casa</a>
    </footer>`;
}

export const field = (name: string, label: string, control: string, hint = '') =>
  `<label class="field" data-field="${name}"><span class="label">${esc(label)}</span>${control}${hint ? `<small class="hint">${esc(hint)}</small>` : ''}</label>`;

export const linkBox = (url: string, { share = false, qr = false, label = t('link'), title = '', primary = false } = {}) => `
  <div class="linkbox">
    <input readonly value="${esc(url)}" aria-label="${esc(label)}" data-select>
    <button type="button" class="btn small" data-act="copy" data-url="${esc(url)}">${icon('copy')}${esc(t('copy'))}</button>
    ${share ? `<button type="button" class="btn small${primary ? ' primary' : ''}" data-act="share" data-url="${esc(url)}" data-title="${esc(title)}">${icon('share')}${esc(t('share'))}</button>` : ''}
    ${qr ? `<button type="button" class="btn small" data-act="qr" data-url="${esc(url)}" aria-label="${esc(t('qrTitle'))}">${icon('qr')}</button>` : ''}
  </div>`;

export function setBusy(on: boolean): void {
  app.busy = on;
  for (const b of $$<HTMLButtonElement>('button[type="submit"], [data-act="save-answer"]')) b.disabled = on;
}

export const menuOpen = () => {
  try {
    return Boolean($opt('.dropdown:popover-open'));
  } catch {
    return false;
  }
};
