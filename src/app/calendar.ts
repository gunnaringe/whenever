// Month calendars (Monday first, ISO week numbers) and drag-to-paint for
// buttons in them.

import { pad, weekday, isoWeek, addDays, monthsBetween } from '../shared/model.ts';
import { monthTitle, weekdayShort, t } from './i18n.ts';

// One block per month. Days inside [start, end] are rendered by dayHtml(date);
// weekHtml(monday, weekNumber) renders the week-number cell. Weeks with no
// day in [start, end] are left out.
export function calendarHtml({
  start,
  end,
  dayHtml,
  weekHtml,
  months = monthsBetween(start, end),
}: {
  start: string;
  end: string;
  dayHtml: (date: string) => string;
  weekHtml?: (monday: string, week: number) => string;
  months?: [number, number][];
}): string {
  const names = weekdayShort();
  const blocks = months.map(([y, m]) => {
    const first = `${y}-${pad(m + 1)}-01`;
    const last = `${y}-${pad(m + 1)}-${pad(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}`;
    let html = `<section class="cal-month"><h4>${monthTitle(y, m)}</h4><div class="cal-grid">`;
    html += `<span class="cal-h wk" aria-hidden="true">${t('weekShort')}</span>`;
    html += names.map((n, i) => `<span class="cal-h${i >= 5 ? ' we' : ''}">${n}</span>`).join('');
    for (let mon = addDays(first, -weekday(first)); mon <= last; mon = addDays(mon, 7)) {
      if (addDays(mon, 6) < start || mon > end) continue;
      html += weekHtml ? weekHtml(mon, isoWeek(mon)) : `<span class="cal-wk">${isoWeek(mon)}</span>`;
      for (let i = 0; i < 7; i++) {
        const d = addDays(mon, i);
        if (d < first || d > last) html += '<span class="cal-pad"></span>';
        else if (d < start || d > end) html += `<span class="cal-day out">${Number(d.slice(8))}</span>`;
        else html += dayHtml(d);
      }
    }
    return `${html}</div></section>`;
  });
  return `<div class="cal">${blocks.join('')}</div>`;
}

// Picking days in a calendar of buttons (data-d = the date):
// - a tap or click sets one day to next(el);
// - dragging from one day to another gives every day in between, in date
//   order across weeks and months, the value the first one got. It's shown
//   as it goes, and days the drag leaves again get their old value back;
// - Shift-click (or Shift+Enter/Space) fills from the last day clicked or
//   dragged from to this one, with that day's value.
// A mouse drags at once. A finger has to hold a day for HOLD_MS first (then
// touchmove is cancelled so the page stays put), so a swipe still scrolls
// and a tap still toggles, as in the time grid.
//   get(el)         el's current value
//   next(el)        the value a tap on el gives
//   apply(el, v)    store v and update el
//   done()          after a tap, a Shift-click or a finished drag
const HOLD_MS = 300;
const SLOP = 10; // px a finger may move before a hold becomes a scroll

export function bindPaint<V>(
  root: HTMLElement,
  selector: string,
  {
    get,
    next,
    apply,
    done,
  }: { get: (el: HTMLButtonElement) => V; next: (el: HTMLButtonElement) => V; apply: (el: HTMLButtonElement, v: V) => void; done?: () => void },
): void {
  type Drag = { from: string; to: string; value: V; orig: Map<string, V>; id: number; x: number; y: number; moved: boolean; stop: AbortController };
  let drag: Drag | null = null;
  let hold: { id: number; timer: ReturnType<typeof setTimeout>; stop: AbortController } | null = null;
  let anchor: { d: string; value: V } | null = null;
  // A press we handled ourselves is followed by a click to ignore. A new
  // press clears this, so a quick Shift-click right after still counts;
  // the deadline covers a drag that no click follows.
  let skipClickUntil = 0;

  const date = (el: HTMLButtonElement) => el.dataset.d ?? '';
  const usable = (el: HTMLButtonElement | null | undefined): el is HTMLButtonElement => Boolean(el && root.contains(el) && !el.disabled && el.dataset.d);
  const target = (e: Event) => (e.target as Element).closest<HTMLButtonElement>(selector);
  const at = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLButtonElement>(selector);
    return usable(el) ? el : null;
  };

  // Every usable day from a to b gets v. With orig, what they had is kept,
  // and the days outside a..b that have an entry get it back.
  function fill(a: string, b: string, v: V, orig?: Map<string, V>): void {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (const el of root.querySelectorAll<HTMLButtonElement>(selector)) {
      if (!usable(el)) continue;
      const d = date(el);
      if (d >= lo && d <= hi) {
        if (orig && !orig.has(d)) orig.set(d, get(el));
        if (get(el) !== v) apply(el, v);
      } else if (orig?.has(d)) {
        const old = orig.get(d) as V;
        if (get(el) !== old) apply(el, old);
        orig.delete(d);
      }
    }
  }

  function start(el: HTMLButtonElement, id: number, x: number, y: number): void {
    const value = next(el);
    const stop = new AbortController();
    const d: Drag = { from: date(el), to: date(el), value, orig: new Map(), id, x, y, moved: false, stop };
    drag = d;
    anchor = { d: d.from, value };
    fill(d.from, d.to, value, d.orig);
    const opts = { signal: stop.signal };
    window.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== d.id) return;
        d.x = e.clientX;
        d.y = e.clientY;
        d.moved = true;
        track();
      },
      opts,
    );
    window.addEventListener('pointerup', (e) => e.pointerId === d.id && finish(), opts);
    window.addEventListener('pointercancel', (e) => e.pointerId === d.id && finish(), opts);
    requestAnimationFrame(autoScroll);
  }

  function track(): void {
    if (!drag) return;
    const el = at(drag.x, drag.y);
    if (el && date(el) !== drag.to) {
      drag.to = date(el);
      fill(drag.from, drag.to, drag.value, drag.orig);
    }
  }

  function finish(): void {
    if (!drag) return;
    drag.stop.abort();
    drag = null;
    skipClickUntil = performance.now() + 1000;
    done?.();
  }

  // Dragging near the top or bottom of the window scrolls it, so a range can
  // reach a month further down (the bottom margin clears the save bar).
  function autoScroll(): void {
    if (!drag) return;
    if (drag.moved) {
      const top = 60;
      const bottom = window.innerHeight - 90;
      const dy = drag.y < top ? -Math.ceil((top - drag.y) / 3) : drag.y > bottom ? Math.ceil((drag.y - bottom) / 3) : 0;
      if (dy) {
        window.scrollBy(0, Math.max(-24, Math.min(24, dy)));
        track();
      }
    }
    requestAnimationFrame(autoScroll);
  }

  function endHold(): void {
    if (!hold) return;
    clearTimeout(hold.timer);
    hold.stop.abort();
    hold = null;
  }

  root.addEventListener('pointerdown', (e) => {
    const el = target(e);
    if (!usable(el) || e.button > 0 || drag) return;
    skipClickUntil = 0;
    if (e.pointerType === 'mouse') {
      e.preventDefault();
      // Shift-click: the click handler fills the range.
      if (e.shiftKey && anchor) return;
      start(el, e.pointerId, e.clientX, e.clientY);
      return;
    }
    // A finger: wait. A swipe is a scroll, a tap is a click, a hold drags.
    endHold();
    const { pointerId: id, clientX: x, clientY: y } = e;
    const stop = new AbortController();
    const opts = { signal: stop.signal };
    hold = {
      id,
      stop,
      timer: setTimeout(() => {
        endHold();
        start(el, id, x, y);
      }, HOLD_MS),
    };
    window.addEventListener('pointermove', (m) => m.pointerId === id && Math.hypot(m.clientX - x, m.clientY - y) > SLOP && endHold(), opts);
    window.addEventListener('pointerup', (m) => m.pointerId === id && endHold(), opts);
    window.addEventListener('pointercancel', (m) => m.pointerId === id && endHold(), opts);
  });

  // Once a hold has started a drag, the finger mustn't scroll the page.
  root.addEventListener('touchmove', (e) => drag && e.cancelable && e.preventDefault(), { passive: false });
  root.addEventListener('contextmenu', (e) => {
    if (drag || hold) e.preventDefault();
  });

  root.addEventListener('click', (e) => {
    const el = target(e);
    if (!usable(el)) return;
    if (performance.now() < skipClickUntil) {
      skipClickUntil = 0;
      return;
    }
    if (e.shiftKey && anchor) {
      fill(anchor.d, date(el), anchor.value);
    } else {
      const value = next(el);
      apply(el, value);
      anchor = { d: date(el), value };
    }
    done?.();
  });
}
