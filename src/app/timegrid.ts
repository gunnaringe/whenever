// The time grid: one column per date (7 per page), one row per slot.
//
// paint mode: press a cell and drag to cover a rectangle. If the first cell
// already has the brush value the rectangle is erased, otherwise painted.
// A tap toggles one cell. Cells have touch-action: none so a finger paints;
// the time column, the headers and the margins still scroll the page.
// view mode: read-only heat map; a tap (or mouse hover) picks a cell.
//
import { hhmm, slotKey, weekday } from '../shared/model.ts';
import { weekdayShort, shortDate, t, fmtDate } from './i18n.ts';
import { esc } from './ui.ts';

interface Common {
  dates: string[];
  mins: number[]; // row start minutes
  rowh?: number; // row height in px
  allowed?: (key: string) => boolean;
  onDay?: (date: string) => void; // a tap on a column header
  page?: number;
  onPage?: (page: number) => void;
  empty?: string; // text when there are no dates or rows
}
export interface PaintOptions extends Common {
  mode: 'paint';
  value: (key: string) => number; // 0 none, 1 yes, 2 maybe
  brush: () => number;
  onPaint: (keys: string[], value: number) => void;
}
export interface ViewOptions extends Common {
  mode: 'view';
  decorate: (key: string) => { cls: string; h: string; text?: string };
  onPick?: (key: string, hover: boolean) => void;
}
export type GridOptions = PaintOptions | ViewOptions;

interface Drag {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  v: number;
  id: number;
  x: number;
  y: number;
  moved: boolean;
}

const PER_PAGE = 7;

export class TimeGrid {
  el: HTMLElement;
  o: GridOptions;
  page: number;
  drag: Drag | null = null;
  cur: { c: number; r: number } | null = null;
  cells: HTMLElement[][] = [];
  cols: string[] = [];
  grid: HTMLElement | null = null;
  hover: Element | null = null;

  constructor(el: HTMLElement, o: GridOptions) {
    this.el = el;
    this.o = o;
    this.page = o.page ?? 0;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => this.cancel());
    el.addEventListener('click', (e) => this.click(e));
    el.addEventListener('keydown', (e) => this.key(e));
    this.render();
  }

  set(patch: Partial<Common>): void {
    Object.assign(this.o, patch);
    this.render();
  }

  get pages(): number {
    return Math.max(1, Math.ceil(this.o.dates.length / PER_PAGE));
  }

  render(): void {
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
    this.grid = this.el.querySelector<HTMLElement>('.tg');
    this.cells = cols.map(() => []);
    for (const cell of this.el.querySelectorAll<HTMLElement>('.tg-cell')) this.cells[Number(cell.dataset.c)][Number(cell.dataset.r)] = cell;
    this.refresh();
  }

  refresh(): void {
    const o = this.o;
    this.cells.forEach((col, c) =>
      col.forEach((cell, r) => {
        const k = cell.dataset.k ?? '';
        let cls = 'tg-cell';
        if (o.mins[r] % 60 === 0) cls += ' hour';
        let text = '';
        if (o.allowed && !o.allowed(k)) cls += ' na';
        else if (o.mode === 'view') {
          const dec = o.decorate(k);
          cls += ` ${dec.cls}`;
          cell.style.setProperty('--h', dec.h);
          text = dec.text ?? '';
        } else {
          const v = o.value(k);
          cls += ` v${v || 0}`;
          cell.setAttribute('aria-selected', v ? 'true' : 'false');
        }
        if (this.cur && this.cur.c === c && this.cur.r === r) cls += ' cur';
        cell.className = cls;
        if (cell.textContent !== text) cell.textContent = text;
      }),
    );
  }

  ok(k: string | undefined): k is string {
    return k !== undefined && (!this.o.allowed || this.o.allowed(k));
  }

  down(e: PointerEvent): void {
    const o = this.o;
    const cell = (e.target as Element).closest?.<HTMLElement>('.tg-cell');
    if (!cell || o.mode !== 'paint' || e.button > 0 || !this.ok(cell.dataset.k)) return;
    e.preventDefault();
    try {
      this.grid?.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (synthetic events): moves still bubble here.
    }
    const c = Number(cell.dataset.c);
    const r = Number(cell.dataset.r);
    const b = o.brush();
    this.drag = { c0: c, r0: r, c1: c, r1: r, v: o.value(cell.dataset.k) === b ? 0 : b, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    this.cur = { c, r };
    this.preview();
    requestAnimationFrame(() => this.autoScroll());
  }

  // The cell under the pointer, from the grid's geometry rather than
  // elementFromPoint: works over the sticky save bar, outside the grid
  // (clamped to the edge) and while the page scrolls.
  track(): void {
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
  autoScroll(): void {
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

  move(e: PointerEvent): void {
    const o = this.o;
    if (!this.drag) {
      if (o.mode === 'view' && e.pointerType === 'mouse') {
        const cell = (e.target as Element).closest?.<HTMLElement>('.tg-cell');
        if (cell && cell !== this.hover && this.ok(cell.dataset.k)) {
          this.hover = cell;
          o.onPick?.(cell.dataset.k, true);
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

  up(e: PointerEvent): void {
    if (this.drag && e.pointerId === this.drag.id) this.commit();
  }

  cancel(): void {
    this.drag = null;
    this.refresh();
  }

  rect(): { c0: number; c1: number; r0: number; r1: number } {
    const d = this.drag;
    if (!d) return { c0: 0, c1: -1, r0: 0, r1: -1 };
    return {
      c0: Math.min(d.c0, d.c1),
      c1: Math.max(d.c0, d.c1),
      r0: Math.min(d.r0, d.r1),
      r1: Math.max(d.r0, d.r1),
    };
  }

  preview(): void {
    const d = this.drag;
    if (!d) return;
    const R = this.rect();
    this.cells.forEach((col, c) =>
      col.forEach((cell, r) => {
        const inside = c >= R.c0 && c <= R.c1 && r >= R.r0 && r <= R.r1 && this.ok(cell.dataset.k);
        cell.classList.toggle('pv', inside);
        cell.classList.toggle(`pv${d.v}`, inside);
      }),
    );
  }

  commit(): void {
    const d = this.drag;
    const o = this.o;
    if (!d) return;
    const R = this.rect();
    const keys: string[] = [];
    for (let c = R.c0; c <= R.c1; c++) {
      for (let r = R.r0; r <= R.r1; r++) {
        const k = this.cells[c][r].dataset.k;
        if (this.ok(k)) keys.push(k);
      }
    }
    this.drag = null;
    if (o.mode === 'paint') o.onPaint(keys, d.v);
    this.refresh();
  }

  click(e: MouseEvent): void {
    const o = this.o;
    const target = e.target as Element;
    const nav = target.closest<HTMLElement>('[data-nav]');
    if (nav) {
      this.page += Number(nav.dataset.nav);
      this.o.onPage?.(this.page);
      this.render();
      return;
    }
    const day = target.closest<HTMLElement>('[data-day]');
    if (day) {
      o.onDay?.(day.dataset.day ?? '');
      return;
    }
    if (o.mode === 'view') {
      const cell = target.closest<HTMLElement>('.tg-cell');
      if (cell && this.ok(cell.dataset.k)) o.onPick?.(cell.dataset.k, false);
    }
  }

  // Arrow keys move a cursor, Space/Enter paints (or picks) the cell under it.
  key(e: KeyboardEvent): void {
    const o = this.o;
    if (!this.grid || !this.cells.length) return;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
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
      if (o.mode === 'paint') {
        const b = o.brush();
        o.onPaint([k], o.value(k) === b ? 0 : b);
        this.refresh();
      } else o.onPick?.(k, false);
    }
  }
}
