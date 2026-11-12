// An iCalendar file (RFC 5545) for the organiser's pick, so people can add
// it to their calendar. Dates mode: an all-day event. Times mode: the
// window, converted from wall-clock time in the event's time zone to UTC.
// No DOM here: the tests run it in Node.

import { addDays, decision } from '../shared/model.ts';
import type { PollEvent } from '../shared/model.ts';
import { zonedUtc } from './zone.ts';

// Re-exported for the tests and callers from before zone.ts.
export { zonedUtc };

const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const day = (d: string) => d.replace(/-/g, '');
const text = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 octets are folded: CRLF and a space.
function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > 73) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// null if nothing is picked. url is the public event link (never a
// personal or admin link: those carry a secret).
export function icsFor(ev: PollEvent, id: string, url: string, now = Date.now()): string | null {
  const pick = decision(ev, []);
  if (!pick || !ev.decided) return null;
  let when: string[];
  if ('date' in pick && ev.mode === 'times') {
    when = [`DTSTART:${stamp(zonedUtc(pick.date, pick.start, ev.tz))}`, `DTEND:${stamp(zonedUtc(pick.date, pick.end, ev.tz))}`];
  } else {
    when = [`DTSTART;VALUE=DATE:${day(ev.decided)}`, `DTEND;VALUE=DATE:${day(addDays(ev.decided, 1))}`];
  }
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//apphub.casa//Whenever//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${id}-${ev.decided.replace(/[^0-9T]/g, '')}@whenever.apphub.casa`,
    `DTSTAMP:${stamp(now)}`,
    ...when,
    `SUMMARY:${text(ev.name)}`,
    ...(ev.location ? [`LOCATION:${text(ev.location)}`] : []),
    `DESCRIPTION:${text([ev.description, url].filter(Boolean).join('\n\n'))}`,
    `URL:${url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// A file name from the event name: "Julebord 2026" -> "julebord-2026.ics".
export function icsName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'event'}.ics`;
}
