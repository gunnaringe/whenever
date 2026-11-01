// Link previews: Messenger, Signal, iMessage, Slack and the like fetch a
// link's HTML and show its Open Graph tags (they never run the app). The
// Worker serves the app's pages (/, /new, /find, /e/...) and fills these
// tags into index.html: the host's language and, on an event link, the
// event's name and description. Pure, so it is tested in Node.
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
