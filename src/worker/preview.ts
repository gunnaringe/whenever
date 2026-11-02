// Link previews: Messenger, Signal, iMessage, Slack and the like fetch a
// link's HTML and show its Open Graph tags (they never run the app). The
// Worker serves the app's pages (/, /new, /find, /e/...) and fills these
// tags into index.html: the host's language and, on an event link, the
// event's name and description. Pure, so it is tested in Node. pageText()
// is the page's text for AI assistants and for people without JavaScript.
//
// Never put the requested URL (an event link may carry a token) into a
// tag: there is no og:url, and the image URL is built from the origin.

import { EN_HOST } from './mail.ts';

export type PreviewLang = 'nb' | 'en';

// What an event link's preview shows, from Poll.preview(): no more than any
// visitor with the public link sees.
export interface EventPreview {
  name: string;
  description: string;
  mode: 'dates' | 'times';
  closed: boolean;
}

export interface PageMeta {
  lang: PreviewLang;
  title: string;
  // Content for meta[name=…] ("description") and meta[property=…] (og:…).
  tags: Record<string, string>;
}

const TEXT = {
  nb: {
    app: 'Finn tid',
    locale: 'nb_NO',
    about: 'Finn dagen eller tiden som passer for flest. Del én lenke, så krysser alle av for når de kan.',
    dates: 'Kryss av for dagene som passer for deg.',
    times: 'Kryss av for tidene som passer for deg.',
    closed: 'Avstemningen er stengt. Se hva som passet best.',
  },
  en: {
    app: 'Whenever',
    locale: 'en_US',
    about: 'Find the day or time that suits most people. Share one link and everyone marks when they can.',
    dates: 'Mark the days that suit you.',
    times: 'Mark the times that suit you.',
    closed: 'This poll is closed. See what suited most people.',
  },
} satisfies Record<PreviewLang, Record<string, string>>;

// The longest description we send; apps cut it shorter anyway.
export const DESCRIPTION_MAX = 200;

// whenever.apphub.casa is English; finn-tid.apphub.casa and anything else
// (wrangler dev rewrites the host to the first route) Norwegian.
export const previewLang = (host: string): PreviewLang => (host === EN_HOST ? 'en' : 'nb');

// One line, at most `max` characters, cut at a word where there is one.
export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?–-]+$/, '')}…`;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The page's text for those who don't run the app, as HTML:
//   agents:   for programs and AI assistants, which read a page as text and
//             never run it (#for-agents in index.html, inside #app, hidden by
//             the stylesheet: the app replaces it when it starts). Facts and
//             where the API is (public/llms.txt), in English on both hosts.
//             Only the event's name from its texts: the description sits in
//             the preview tags, not next to the API.
//   noscript: what a person without JavaScript sees.
// The id is the event's (checked against ID_RE); a link's token never gets
// here.
export interface PageText {
  agents: string;
  noscript: string;
}

export function pageText(host: string, origin: string, id: string, ev: EventPreview | null): PageText {
  const lang = previewLang(host);
  const llms = `${origin}/llms.txt`;
  const a = (url: string) => `<a href="${url}">${url}</a>`;
  if (!ev) {
    return {
      agents:
        `<h1>Finn tid (Whenever)</h1>` +
        `<p>A web app for finding the day or time that suits most people: someone makes a poll, shares one link, and everyone marks when they can. This page is the app and needs JavaScript.</p>` +
        `<p>Programs and AI assistants can use its JSON API instead, described at ${a(llms)}</p>`,
      noscript: `<p class="page">${lang === 'en' ? 'Whenever needs JavaScript.' : 'Finn tid trenger JavaScript.'}</p>`,
    };
  }
  const name = escapeHtml(clip(ev.name, 120));
  const json = `${origin}/api/events/${id}`;
  const closed = ev.closed ? ' It is closed: only its organiser can change answers now.' : '';
  return {
    agents:
      `<h1>${name}</h1>` +
      `<p>A poll on Finn tid (Whenever) for finding the ${ev.mode === 'times' ? 'time' : 'day'} that suits most people.${closed} This page is the app and needs JavaScript.</p>` +
      `<p>The same poll as JSON: ${a(json)}</p>` +
      `<p>A link of the form /e/${id}/&lt;token&gt; carries a personal or admin token in its last part. Send it as the header "Authorization: Bearer &lt;token&gt;" to see and change what that link may. How to read, answer and organise polls with the API: ${a(llms)}</p>`,
    noscript: `<p class="page"><strong>${name}</strong><br>${lang === 'en' ? 'Whenever needs JavaScript to show the poll.' : 'Finn tid trenger JavaScript for å vise avstemningen.'}</p>`,
  };
}

export function pageMeta(host: string, origin: string, ev: EventPreview | null): PageMeta {
  const lang = previewLang(host);
  const x = TEXT[lang];
  const name = ev ? clip(ev.name, 120) : '';
  const title = name || x.app;
  const lead = ev ? x[ev.closed ? 'closed' : ev.mode] : x.about;
  const description = clip(ev?.description ? `${lead} ${ev.description}` : lead, DESCRIPTION_MAX);
  return {
    lang,
    title: name ? `${name} · ${x.app}` : x.app,
    tags: {
      description,
      'og:title': title,
      'og:description': description,
      'og:site_name': x.app,
      'og:locale': x.locale,
      'og:image': `${origin}/og-${lang}.png`,
      'og:image:alt': x.app,
    },
  };
}
