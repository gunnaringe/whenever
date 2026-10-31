# Whenever · Finn tid

Find the day or time that suits most people. Make an event, share one link,
and everyone marks when they can. At
[finn-tid.apphub.casa](https://finn-tid.apphub.casa) (nb) and
[whenever.apphub.casa](https://whenever.apphub.casa) (en).

- **Dates or times.** Pick possible days in a calendar, or days plus times
  of day. Quick buttons (weekdays, weekends, holidays, single weekdays, week
  numbers) only change the selection, so any single day can still be added
  or removed afterwards.
- **One link to share.** Participants answer yes / maybe per day or drag
  across a time grid, and get a personal link to change their answers later
  from any device. The organiser gets an admin link.
- **No accounts, no cookies.** Links are encrypted, so the server stores no
  login state. Email is optional (stored for magic links; none are sent yet).
- **Settings:** allow "maybe", let everyone edit or delete entries, hide
  answers from other participants, close the event.
- Everything is deleted 30 days after the event's last date.

## Running locally

```sh
npm install
echo "LINK_SECRET=$(openssl rand -base64 32)" > .dev.vars
npx wrangler dev
npm test
```

`scripts/smoke.mjs` is a browser end-to-end test against `wrangler dev`
(see `CLAUDE.md`).

## Deploy

Cloudflare Worker `whenever` with static assets and one SQLite-backed Durable
Object per event, deployed by Workers Builds on push to `main`. Branches get a
Preview.

The link key is a secret that must be set once, for production and for
Previews. Keep it: changing it breaks every link handed out so far.

```sh
openssl rand -base64 32 | npx wrangler secret put LINK_SECRET
# Previews created from now on:
openssl rand -base64 32 | npx wrangler preview base-config secret put LINK_SECRET
# A Preview that already exists:
openssl rand -base64 32 | npx wrangler preview secret put LINK_SECRET --name <branch>
```

## Licence

QR codes by [Project Nayuki's QR Code generator](https://www.nayuki.io/page/qr-code-generator-library)
(MIT), in `public/qrcodegen.js`. Font: Fredoka (SIL OFL), in `public/fonts/`.
