# Whenever · Finn tid

Find the day or time that suits most people. Make an event, share one link,
and everyone marks when they can. At
[finn-tid.apphub.casa](https://finn-tid.apphub.casa) (nb) and
[whenever.apphub.casa](https://whenever.apphub.casa) (en).

- **Dates or times.** Tap possible days in a calendar, or days plus times
  of day. Quick buttons (next 2 or 4 weeks, next month, weekdays, weekends,
  holidays, single weekdays, week numbers) only change the selection, so any
  single day can still be added or removed afterwards.
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
  yes; "maybe" only breaks ties, unless the organiser chooses to count it
  as yes. Equally good options share a rank, and a calendar shades and
  numbers every day.
- **Settings:** allow "maybe" (and whether it counts as able to come), let
  everyone edit or delete entries, hide answers from other participants,
  close the event.
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
(MIT), in `src/app/vendor/qrcodegen.js`. Font: Fredoka (SIL OFL), in `public/fonts/`.
