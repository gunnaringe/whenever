// Small DOM helpers: escaping, icons, toast, dialogs, copy/share, QR codes.

import qrcodegen from './vendor/qrcodegen.js';
import { t } from './i18n.ts';

// An element the current view always has (use $opt when it may be missing).
export const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T => r.querySelector<T>(s) as T;
export const $opt = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T | null => r.querySelector<T>(s);
export const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T[] => [...r.querySelectorAll<T>(s)];

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const icon = (name: string, cls = ''): string => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string): void {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2800);
}

// A modal built from HTML. Resolves with the value of the button that closed
// it ('' for Escape or a tap on the backdrop).
export function dialog(html: string, { onOpen }: { onOpen?: (dlg: HTMLDialogElement) => void } = {}): Promise<string> {
  const dlg = $<HTMLDialogElement>('#dlg');
  if (dlg.open) dlg.close('');
  dlg.innerHTML = `<form method="dialog">${html}</form>`;
  dlg.returnValue = '';
  dlg.showModal();
  onOpen?.(dlg);
  const backdrop = (e: MouseEvent) => {
    if (e.target === dlg) dlg.close('');
  };
  dlg.addEventListener('click', backdrop);
  return new Promise<string>((resolve) =>
    dlg.addEventListener(
      'close',
      () => {
        dlg.removeEventListener('click', backdrop);
        resolve(dlg.returnValue);
      },
      { once: true },
    ),
  );
}

export async function ask(text: string, { ok = t('ok'), cancel = t('cancel'), danger = false, title = '' } = {}): Promise<boolean> {
  const r = await dialog(`
    ${title ? `<h3>${esc(title)}</h3>` : ''}
    <p>${esc(text)}</p>
    <div class="row end">
      <button value="no" class="btn">${esc(cancel)}</button>
      <button value="yes" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button>
    </div>`);
  return r === 'yes';
}

export interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  hint?: string;
  // The current choice, when the menu picks one of several.
  on?: boolean;
}

// Resolves with the picked item's id ('' for none).
export function menu(title: string, items: MenuItem[]): Promise<string> {
  return dialog(`
    <h3>${esc(title)}</h3>
    <div class="menu-list">
      ${items.map((i) => `<button value="${esc(i.id)}" class="menu-item${i.danger ? ' danger' : ''}${i.on ? ' on' : ''}"${i.on ? ' aria-current="true"' : ''}><span>${i.on ? icon('check') : ''}${esc(i.label)}</span>${i.hint ? `<small>${esc(i.hint)}</small>` : ''}</button>`).join('')}
    </div>
    <div class="row end"><button value="" class="btn">${esc(t('cancel'))}</button></div>`);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(t('copied'));
}

export async function shareUrl(url: string, title: string): Promise<void> {
  if ('share' in navigator) {
    try {
      await navigator.share({ title, url });
    } catch {
      // Cancelled.
    }
    return;
  }
  await copyText(url);
}

export function qrSvg(text: string): string {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const n = qr.size;
  const b = 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.getModule(x, y)) d += `M${x + b},${y + b}h1v1h-1z`;
  return `<svg class="qr" viewBox="0 0 ${n + 2 * b} ${n + 2 * b}" role="img" aria-label="QR"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
