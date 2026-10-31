# whenever

Finn tid (nb) / Whenever (en): find the day or time that suits most people,
at finn-tid.apphub.casa and whenever.apphub.casa. The host picks the default
language (`finn-tid.` → nb, `whenever.` → en, anything else → browser).

## Layout

- `public/`: the whole frontend, no build, no framework, no dependencies, no
  third-party requests. ES modules:
  - `model.js`: pure and shared with the Worker. Dates (UTC `YYYY-MM-DD`
    strings, weekday 0 = Monday), Norwegian holidays, selection helpers,
    option keys, `sanitizeEvent`/`sanitizeEntry`, permissions
    (`canAdd`/`canEdit`), results (`tally`, `bestOptions`, `windows`,
    `bestWindows`), `LIMITS`, retention.
  - `app.js`: UI, routing, the event form, overview/results, the answer
    editor. `i18n.js`: strings and date formatting. `api.js`: fetch wrapper.
    `store.js`: localStorage. `ui.js`: `$`, `esc`, dialogs, toast, QR.
  - `calendar.js`: month grids (`calendarHtml`) and drag/tap painting
    (`bindPaint`). `timegrid.js`: the drag-to-paint time grid (`TimeGrid`).
  - `qrcodegen.js`: Nayuki's MIT QR library, copied from scorepad. Don't edit
    by hand.
- `src/worker.js`: `/api/*` only (`run_worker_first`): routing, JSON parsing,
  rate limit, turning the Bearer token into a credential.
  `src/poll.js`: the `Poll` Durable Object, which decides everything about
  who may do what. `src/link.js`: sealing and opening link tokens.

## How it works

- **One Durable Object per event** (`idFromName(eventId)`), SQLite tables
  `meta(k, v)` and `people(...)`. `exists()` never creates tables, so probing
  a wrong id leaves no storage; only `POST /api/events` creates. An alarm
  deletes everything at `max(last date + 31 days, now + 7 days)`
  (`expiresAt`, `deleteAt`); `RETENTION_DAYS` is what the UI and privacy page
  say.
- **Links are random secrets stored with the event.** `/e/<eventId>` is
  the public event link; `/e/<eventId>/<token>` is an admin or personal
  link. The token (`src/link.js`, patterns `TOKEN`/`TOKEN_RE` in
  `model.js`) is a 16-hex selector (the participant id, or the event's
  `adminId`) followed by a 22-char random secret (128 bits): 38 chars, no
  separator. The Poll object finds the row by selector and compares the
  secret in constant time (`same()`); it also makes every token. Resetting
  a link stores a new secret, and the old one reads as `link: 'invalid'`.
  Secrets are stored unhashed on purpose, so the admin can copy a
  participant's current link again. There is no Worker secret or key. Never
  put tokens in query strings or logs; the client sends them as
  `Authorization: Bearer`.
- **Option keys:** dates mode `YYYY-MM-DD`, times mode `YYYY-MM-DDTHH:MM`
  (wall-clock in the event's `tz`; nothing converts time zones). An event's
  `options` is the allowed set; answers map key → 1 (yes) or 2 (maybe), and
  `cleanAnswers` drops keys that aren't options. Editing an event prunes
  answers to removed options (the form warns first).
- **Selection helpers only change the selection.** Weekday/group chips
  (Hverdager, Helger, Helligdager, Ma…Sø, week numbers) add or remove days and
  show a tri-state (`weekdayState`, `groupState`); the stored event is just
  the explicit set, so a single Saturday can always be picked by hand.
  Extending the range adds the new days unless that weekday is currently
  fully off. Keep it that way: never store a "no weekends" rule.
- **Ranking:** most available (yes + maybe) first, then most yes, then
  earliest. Times mode ranks windows of `duration` built from consecutive
  slots, and the top windows don't overlap.
- **Permissions:** the admin can do everything; `closed` blocks everyone
  else; people edit their own entry; `openEdit` lets anyone edit/delete any
  entry (not with `hidden`, where only the admin sees others' answers).
  Emails are only returned to their owner (and `adminEmail` to the admin).
  No email is sent yet; it's stored for magic links later.
- **Routes:** paths `/`, `/new`, `/e/:id`, `/e/:id/:token` (SPA fallback
  serves `index.html`), plus hash sub-views `#answer`, `#answer=<pid>`,
  `#edit`. Clicks go through `data-act` delegation to the `actions` map.
  The overview polls every 30 s and on tab focus, only while it's the
  visible view and no dialog is open (`refreshIfIdle`).
- **Painting:** `TimeGrid` uses pointer events with `touch-action: none` on
  cells, so a finger paints a rectangle (the first cell decides paint or
  erase); the cell under the pointer comes from the grid geometry
  (`track()`), not `elementFromPoint`, and dragging near the window edge
  auto-scrolls. The calendar (`bindPaint`) drag-paints with a mouse and
  taps on touch, so the page still scrolls. Calendar days are buttons; the
  time grid takes arrow keys + Space.
- **i18n:** `STRINGS.nb` / `STRINGS.en`, same keys, plurals as
  `{ one, other }` (tests check parity, that literal `t('…')` keys exist and
  that every API error code has an `err.*` string). User text always goes
  through `esc()`.
- **CSS names:** `.page` is the container and `.bar` the header; the result
  meter is `.meter`. Don't reuse `.bar`/`.wrap`-style generic names (both
  collided once).
- **Privacy page:** `public/privacy.html`, static, nb + en. Keep it true
  when adding storage or a request: no cookies, analytics or third-party
  requests. localStorage keys start with `whenever-`.
- **Security headers:** `public/_headers` sets a strict same-origin CSP
  (no inline scripts) and `Referrer-Policy: no-referrer` (links carry
  tokens). The Worker sets `no-store`, `nosniff` and `no-referrer` on API
  responses and only accepts `application/json` bodies (415 otherwise).

## Testing

- `npm test`: model, link tokens and i18n (node:test).
- `npx wrangler dev`, then `BASE=http://127.0.0.1:8787 node scripts/smoke.mjs`: a browser end-to-end
  check (dates and times events, chips, drag and touch painting, several
  participants, permissions, link reset). Needs `npm i --no-save
  playwright`; if Playwright's browser version isn't installed, point
  `PWCHROME` at an existing
  `~/.cache/ms-playwright/chromium_headless_shell-*/…/chrome-headless-shell`.
  Screenshots go to `$SHOTS` (default `/tmp/whenever-shots`).
- Changes go in PRs; visible ones with screenshots:
  `scripts/pr-shots.sh --pr <shot-name>...` uploads them to the orphan
  `pr-shots` branch and adds the Markdown to the branch's PR.

## Deploy

Cloudflare Worker `whenever` (never rename it: the custom domains are bound
to it), Workers Builds on push to `main`; other branches run `wrangler
preview`, which needs the `previews` block in `wrangler.jsonc`: give any new
binding a Preview-safe copy there. Rate-limit namespaces are account-wide:
`3001` production, `3002` previews (1001 is scoreboard, 2001/2002 scorepad).
No secrets or other manual setup. Agent sessions can't deploy (Cloudflare
credentials there are read-only). Free plan: SQLite-backed
Durable Objects only, which this uses.
