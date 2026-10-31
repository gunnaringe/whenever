// The time grid: one column per date (7 per page), one row per slot.
//
// paint mode: press a cell and drag to cover a rectangle. If the first cell
// already has the brush value the rectangle is erased, otherwise painted.
// A tap toggles one cell. Cells have touch-action: none so a finger paints;
// the time column, the headers and the margins still scroll the page.
// view mode: read-only heat map; a tap (or mouse hover) picks a cell.
//
// Options: dates, mins, mode, rowh, value(key) -> 0|1|2, allowed(key),
// brush() -> 1|2, onPaint(keys, v), decorate(key) -> { cls, h, text },
// onPick(key, hover), onDay(date), page, onPage(page), empty (text).

import { hhmm, slotKey, weekday } from '../shared/model.ts';
import { weekdayShort, shortDate, t, fmtDate } from './i18n.ts';
import { esc } from './ui.ts';

const PER_PAGE = 7;

export class TimeGrid {
  constructor(el, o) {
    this.el = el;
    this.o = o;
    this.page = o.page ?? 0;
    this.drag = null;
    this.cur = null;
    this.cells = [];
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => this.cancel());
    el.addEventListener('click', (e) => this.click(e));
    el.addEventListener('keydown', (e) => this.key(e));
    this.render();
  }

  set(patch) {
    Object.assign(this.o, patch);
    this.render();
  }

  get pages() {
    return Math.max(1, Math.ceil(this.o.dates.length / PER_PAGE));
  }

  render() {
    const { dates, mins, mode } = this.o;
    if (!dates.length || !mins.length) {
      this.el.innerHTML = `<p class="muted tg-empty">${esc(this.o.empty ?? '')}</p>`;
      this.cells = [];
      this.grid = null;
      return;
    }
    this.page = Math.max(0, Math.min(this.page, this.pages - 1));
    const cols = dates.slice(this.page * PER_PAGE, this.page * PER_PAGE + PER_PAGE);
    this.cols = cols;
    const wd = weekdayShort();
    let html = '';
    if (this.pages > 1) {
      html += `<div class="tg-nav">
        <button type="button" class="btn small" data-nav="-1" ${this.page === 0 ? 'disabled' : ''} aria-label="${esc(t('prevDays'))}">‹</button>
        <span>${esc(shortDate(cols[0]))} – ${esc(shortDate(cols[cols.length - 1]))} <small>(${this.page + 1}/${this.pages})</small></span>
        <button type="button" class="btn small" data-nav="1" ${this.page >= this.pages - 1 ? 'disabled' : ''} aria-label="${esc(t('nextDays'))}">›</button>
      </div>`;
    }
    html += `<div class="tg ${mode}" role="grid" tabindex="0" aria-label="${esc(t(mode === 'paint' ? 'gridPaintLabel' : 'gridViewLabel'))}" style="--cols:${cols.length};--rowh:${this.o.rowh ?? 20}px">`;
    html += '<div class="tg-corner"></div>';
    for (const d of cols) {
      const inner = `<b>${wd[weekday(d)]}</b><small>${esc(shortDate(d))}</small>`;
      html += this.o.onDay
        ? `<div class="tg-day" role="columnheader"><button type="button" data-day="${d}" aria-label="${esc(fmtDate(d, 'long'))}">${inner}</button></div>`
        : `<div class="tg-day" role="columnheader" aria-label="${esc(fmtDate(d, 'long'))}"><span>${inner}</span></div>`;
    }
    mins.forEach((m, r) => {
      const hour = m % 60 === 0;
      html += `<div class="tg-time${hour ? ' hour' : ''}" role="rowheader">${hour || r === 0 ? hhmm(m) : ''}</div>`;
      cols.forEach((d, c) => {
        html += `<div class="tg-cell" role="gridcell" data-k="${slotKey(d, m)}" data-c="${c}" data-r="${r}"></div>`;
      });
    });
    html += '</div>';
    this.el.innerHTML = html;
    this.grid = this.el.querySelector('.tg');
    this.cells = cols.map(() => []);
    for (const cell of this.el.querySelectorAll('.tg-cell')) this.cells[+cell.dataset.c][+cell.dataset.r] = cell;
    this.refresh();
  }

  refresh() {
    const { mode, value, allowed, decorate, mins } = this.o;
    this.cells.forEach((col, c) =>
      col.forEach((cell, r) => {
        const k = cell.dataset.k;
        let cls = 'tg-cell';
        if (mins[r] % 60 === 0) cls += ' hour';
        let text = '';
        if (allowed && !allowed(k)) cls += ' na';
        else if (mode === 'view') {
          const dec = decorate(k);
          cls += ` ${dec.cls}`;
          cell.style.setProperty('--h', dec.h);
          text = dec.text ?? '';
        } else {
          const v = value(k);
          cls += ` v${v || 0}`;
          cell.setAttribute('aria-selected', v ? 'true' : 'false');
        }
        if (this.cur && this.cur.c === c && this.cur.r === r) cls += ' cur';
        cell.className = cls;
        if (cell.textContent !== text) cell.textContent = text;
      }),
    );
  }

  ok(k) {
    return !this.o.allowed || this.o.allowed(k);
  }

  down(e) {
    const cell = e.target.closest?.('.tg-cell');
    if (!cell || this.o.mode !== 'paint' || e.button > 0 || !this.ok(cell.dataset.k)) return;
    e.preventDefault();
    try {
      this.grid.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (synthetic events): moves still bubble here.
    }
    const c = +cell.dataset.c;
    const r = +cell.dataset.r;
    const b = this.o.brush();
    this.drag = { c0: c, r0: r, c1: c, r1: r, v: this.o.value(cell.dataset.k) === b ? 0 : b, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    this.cur = { c, r };
    this.preview();
    requestAnimationFrame(() => this.autoScroll());
  }

  // The cell under the pointer, from the grid's geometry rather than
  // elementFromPoint: works over the sticky save bar, outside the grid
  // (clamped to the edge) and while the page scrolls.
  track() {
    const d = this.drag;
    if (!d) return;
    const a = this.cells[0][0].getBoundingClientRect();
    const px = this.cells.length > 1 ? this.cells[1][0].getBoundingClientRect().left - a.left : a.width;
    const py = this.cells[0].length > 1 ? this.cells[0][1].getBoundingClientRect().top - a.top : a.height;
    const c = Math.max(0, Math.min(this.cells.length - 1, Math.floor((d.x - a.left) / px)));
    const r = Math.max(0, Math.min(this.cells[0].length - 1, Math.floor((d.y - a.top) / py)));
    if (c !== d.c1 || r !== d.r1) {
      d.c1 = c;
      d.r1 = r;
      this.preview();
    }
  }

  // Dragging near the top or bottom of the window scrolls it, so a tall grid
  // can be painted in one go on a phone.
  autoScroll() {
    const d = this.drag;
    if (!d) return;
    if (d.moved) {
      const top = 60;
      const bottom = window.innerHeight - 90;
      const dy = d.y < top ? -Math.ceil((top - d.y) / 3) : d.y > bottom ? Math.ceil((d.y - bottom) / 3) : 0;
      if (dy) {
        window.scrollBy(0, Math.max(-24, Math.min(24, dy)));
        this.track();
      }
    }
    requestAnimationFrame(() => this.autoScroll());
  }

  move(e) {
    if (!this.drag) {
      if (this.o.mode === 'view' && e.pointerType === 'mouse') {
        const cell = e.target.closest?.('.tg-cell');
        if (cell && cell !== this.hover && this.ok(cell.dataset.k)) {
          this.hover = cell;
          this.o.onPick?.(cell.dataset.k, true);
        }
      }
      return;
    }
    if (e.pointerId !== this.drag.id) return;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    this.drag.moved = true;
    this.track();
  }

  up(e) {
    if (this.drag && e.pointerId === this.drag.id) this.commit();
  }

  cancel() {
    this.drag = null;
    this.refresh();
  }

  rect() {
    const d = this.drag;
    return {
      c0: Math.min(d.c0, d.c1),
      c1: Math.max(d.c0, d.c1),
      r0: Math.min(d.r0, d.r1),
      r1: Math.max(d.r0, d.r1),
    };
  }

  preview() {
    const R = this.rect();
    this.cells.forEach((col, c) =>
      col.forEach((cell, r) => {
        const inside = c >= R.c0 && c <= R.c1 && r >= R.r0 && r <= R.r1 && this.ok(cell.dataset.k);
        cell.classList.toggle('pv', inside);
        cell.classList.toggle(`pv${this.drag.v}`, inside);
      }),
    );
  }

  commit() {
    const R = this.rect();
    const keys = [];
    for (let c = R.c0; c <= R.c1; c++) {
      for (let r = R.r0; r <= R.r1; r++) {
        const k = this.cells[c][r].dataset.k;
        if (this.ok(k)) keys.push(k);
      }
    }
    const v = this.drag.v;
    this.drag = null;
    this.o.onPaint(keys, v);
    this.refresh();
  }

  click(e) {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      this.page += Number(nav.dataset.nav);
      this.o.onPage?.(this.page);
      this.render();
      return;
    }
    const day = e.target.closest('[data-day]');
    if (day) {
      this.o.onDay?.(day.dataset.day);
      return;
    }
    if (this.o.mode === 'view') {
      const cell = e.target.closest('.tg-cell');
      if (cell && this.ok(cell.dataset.k)) this.o.onPick?.(cell.dataset.k, false);
    }
  }

  // Arrow keys move a cursor, Space/Enter paints (or picks) the cell under it.
  key(e) {
    if (!this.grid || !this.cells.length) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const cur = this.cur ?? { c: 0, r: 0 };
    if (moves[e.key]) {
      e.preventDefault();
      const [dc, dr] = moves[e.key];
      this.cur = {
        c: Math.max(0, Math.min(this.cells.length - 1, cur.c + dc)),
        r: Math.max(0, Math.min(this.cells[0].length - 1, cur.r + dr)),
      };
      this.refresh();
      this.cells[this.cur.c][this.cur.r].scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      this.cur = cur;
      const k = this.cells[cur.c][cur.r].dataset.k;
      if (!this.ok(k)) return;
      if (this.o.mode === 'paint') {
        const b = this.o.brush();
        this.o.onPaint([k], this.o.value(k) === b ? 0 : b);
        this.refresh();
      } else this.o.onPick?.(k, false);
    }
  }
}
