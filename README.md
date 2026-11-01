# Whenever · Finn tid

Find the day or time that suits most people. Make an event, share one link,
and everyone marks when they can. At
[finn-tid.apphub.casa](https://finn-tid.apphub.casa) (nb) and
[whenever.apphub.casa](https://whenever.apphub.casa) (en).

- **Dates or times.** Tap possible days in a calendar (drag, Shift-click or
  hold and drag for a range), or days plus times of day. Quick buttons (next 2 or 4 weeks, next month, weekdays, weekends,
  holidays, single weekdays, week numbers) only change the selection, so any
  single day can still be added or removed afterwards.
- **Public holidays** of Norway, Sweden or Denmark (or none), per event,
  are marked in the calendar, including Christmas Eve and New Year's Eve.
  A new event guesses the country from the browser's time zone.
- **One link to share.** Participants answer yes / maybe per day or drag
  across a time grid, and get a personal link to change their answers later
  from any device. The organiser gets an admin link.
- **No accounts, no cookies.** Each admin or personal link carries a random
  secret stored with the event. Email is optional (stored for magic links;
  none are sent yet).
- **Pick the date.** The organiser picks the final day or time from the
  results. Everyone then sees it at the top and can download it as a
  calendar file (`.ics`).
- **Clear results.** The best days or times come first, ranked by most
  yes, unless the organiser chooses to count "maybe" too. Options with as
  many able to come share a rank ("maybe" only orders them), and a
  calendar shades and numbers every day.
- **Settings:** allow "maybe" (and whether it counts as able to come), let
  everyone edit or delete entries, hide answers from other participants,
  close the event.
- **Themes:** automatic (follows the device), light, dark and hacker.
- **Languages:** Norwegian (bokmål and nynorsk), Swedish, Danish, Icelandic
  and English, from the language menu in the header.
- Everything is deleted 30 days after the event's last date.

## Running locally

TypeScript, bundled with esbuild; needs Node 22.18 or newer.

```sh
npm install
npm run dev      # wrangler dev at http://127.0.0.1:8787 (builds dist/ first)
npm run check    # type-check
npm test         # unit tests
npm run build    # dist/: public/ plus the hashed app and stylesheet
```

`npm run smoke` is a browser end-to-end test against `npm run dev`
(see `CLAUDE.md`).

## Deploy

Cloudflare Worker `whenever` with static assets and one SQLite-backed Durable
Object per event, deployed by Workers Builds on push to `main` (branch builds
are off). The Build command is `npm run build`. There are no secrets to set.

## Licence

QR codes by [Project Nayuki's QR Code generator](https://www.nayuki.io/page/qr-code-generator-library)
(MIT), in `src/app/vendor/qrcodegen.js`. Fonts: Fredoka and VT323 (both SIL OFL), in `public/fonts/`.
