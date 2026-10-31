// Month calendars (Monday first, ISO week numbers) and drag-to-paint for
// buttons in them.

import { pad, weekday, isoWeek, addDays, monthsBetween } from '../shared/model.ts';
import { monthTitle, weekdayShort, t } from './i18n.ts';

// One block per month. Days inside [start, end] are rendered by dayHtml(date);
// weekHtml(monday, weekNumber) renders the week-number cell.
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

// Tap (or click) toggles one element; with a mouse, dragging over several
// paints them all with the value the first one got. Touch keeps scrolling
// the page, so on phones it's tap only.
//   next(el)        value a tap on el gives
//   apply(el, v)    store v and update el
//   done()          after a tap or a finished drag
export function bindPaint<V>(
  root: HTMLElement,
  selector: string,
  { next, apply, done }: { next: (el: HTMLButtonElement) => V; apply: (el: HTMLButtonElement, v: V) => void; done?: () => void },
): void {
  let drag: { value: V; seen: Set<HTMLButtonElement> } | null = null;
  let fromMouse = false;
  const usable = (el: HTMLButtonElement | null): el is HTMLButtonElement => Boolean(el && root.contains(el) && !el.disabled);
  const target = (e: Event) => (e.target as Element).closest<HTMLButtonElement>(selector);

  root.addEventListener('pointerdown', (e) => {
    const el = target(e);
    if (!usable(el) || e.pointerType !== 'mouse' || e.button !== 0) return;
    e.preventDefault();
    drag = { value: next(el), seen: new Set([el]) };
    apply(el, drag.value);
    fromMouse = true;
    window.addEventListener(
      'pointerup',
      () => {
        drag = null;
        done?.();
        setTimeout(() => (fromMouse = false), 0);
      },
      { once: true },
    );
  });

  root.addEventListener('pointerover', (e) => {
    if (!drag) return;
    const el = target(e);
    if (!usable(el) || drag.seen.has(el)) return;
    drag.seen.add(el);
    apply(el, drag.value);
  });

  root.addEventListener('click', (e) => {
    const el = target(e);
    if (!usable(el)) return;
    if (fromMouse) return;
    apply(el, next(el));
    done?.();
  });
}
