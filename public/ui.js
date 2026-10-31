// Small DOM helpers: escaping, icons, toast, dialogs, copy/share, QR codes.

import qrcodegen from './qrcodegen.js';
import { t } from './i18n.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const icon = (name, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2800);
}

// A modal built from HTML. Resolves with the value of the button that closed
// it ('' for Escape or a tap on the backdrop).
export function dialog(html, { onOpen } = {}) {
  const dlg = $('#dlg');
  if (dlg.open) dlg.close('');
  dlg.innerHTML = `<form method="dialog">${html}</form>`;
  dlg.returnValue = '';
  dlg.showModal();
  onOpen?.(dlg);
  const backdrop = (e) => {
    if (e.target === dlg) dlg.close('');
  };
  dlg.addEventListener('click', backdrop);
  return new Promise((resolve) =>
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

export async function ask(text, { ok = t('ok'), cancel = t('cancel'), danger = false, title = '' } = {}) {
  const r = await dialog(`
    ${title ? `<h3>${esc(title)}</h3>` : ''}
    <p>${esc(text)}</p>
    <div class="row end">
      <button value="no" class="btn">${esc(cancel)}</button>
      <button value="yes" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button>
    </div>`);
  return r === 'yes';
}

// items: [{ id, label, danger?, hint? }]
export function menu(title, items) {
  return dialog(`
    <h3>${esc(title)}</h3>
    <div class="menu-list">
      ${items.map((i) => `<button value="${esc(i.id)}" class="menu-item${i.danger ? ' danger' : ''}"><span>${esc(i.label)}</span>${i.hint ? `<small>${esc(i.hint)}</small>` : ''}</button>`).join('')}
    </div>
    <div class="row end"><button value="" class="btn">${esc(t('cancel'))}</button></div>`);
}

export async function copyText(text) {
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

export async function shareUrl(url, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
    } catch {
      // Cancelled.
    }
    return;
  }
  await copyText(url);
}

export function qrSvg(text) {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const n = qr.size;
  const b = 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.getModule(x, y)) d += `M${x + b},${y + b}h1v1h-1z`;
  return `<svg class="qr" viewBox="0 0 ${n + 2 * b} ${n + 2 * b}" role="img" aria-label="QR"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
