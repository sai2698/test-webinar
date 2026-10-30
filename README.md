# NexaLive — Real-Time Webinar Platform

A production-shaped webinar platform built around a **mediasoup SFU**, with role-based
media visibility, live chat, hand-raise moderation, quizzes, polls, Q&A, in-session
offers, cloud recordings with a replayable timeline, scheduled premieres, and Razorpay
checkout.

The defining design decision: **media visibility is a server-side policy, not a UI
convention.** A participant's camera never leaves the SFU unless a moderator approves
them as a speaker, and the decision is enforced in `canConsume()` on every producer
announcement and every approval change.

---

## Features

| Area | What you get |
|---|---|
| **Live sessions** | SFU-routed audio/video, screen share, device switching, fullscreen |
| **Waiting room** | Participants join early and wait; the host opens the session with **Go live** |
| **Host controls** | Mute all, spotlight a speaker, ask a participant to unmute or enable video, remove from room |
| **Engagement** | Live chat with profanity masking, hand raise, quizzes, polls, Q&A with upvoting and pinning |
| **Offers** | In-session CTA cards shown and hidden on cue, with click tracking |
| **Recording** | Timeline capture plus best-effort MP4 muxing; replay reconstructs the session from the clock |
| **Premieres** | Attach a recording to a webinar and schedule it to run as a live-looking session |
| **Security** | Passcodes, invite-only, required sign-in, per-webinar access gates |
| **Payments** | Razorpay checkout with mock mode, refunds, and CSV export |
| **Media effects** | Virtual background (blur or image), noise gate, echo cancellation, frame rate, fit, mirror |
| **Custom fields** | 11 field types on the join form, reorderable, reusable across webinars, exported with the CSV |
| **Approval** | Registrants queue as `PENDING`; approve, reject, waitlist or cancel, one at a time or all at once |
| **Invites** | Bulk email invites, uninvite, invitee list with attended state |
| **Co-hosts** | Up to 10 per room with a 10-key permission map, invited by email before they have an account |
| **Watermark** | Per-viewer name and id burned over the video, so a leaked recording is traceable |
| **Webhooks** | 14 events, HMAC-signed, delivered from an outbox with retry and a delivery log |
| **Public API** | Hashed `nxl_` tokens and a `/api/v1` surface with a uniform `{ success, data }` envelope |
| **Embedding** | Iframe embed with a strict origin allow-list and a public policy endpoint |
| **Analytics** | GA4, Meta Pixel, Clarity and GTM events fired from the participant page |
| **Automation** | A portable JSON timeline of scheduled chat, Q&A, polls and offers, plus personas |
| **Series** | `DAILY | WEEKLY | MONTHLY | YEARLY` recurrence; each occurrence is a normal webinar |
| **Streaming** | Push the room to YouTube, Twitch or a custom RTMP server (max 3), with a generated ffmpeg command |
| **Metrics** | Post-event attendee report: peak viewers, duration, engagement counts, time series |

---

## Stack

| Layer | Choice |
|---|---|
| Monorepo | npm workspaces (`packages/*`, `apps/*`) |
| API | Express 4 + TypeScript (ESM), Zod validation |
| Realtime | Socket.IO 4 |
| Media | mediasoup 3 (SFU), mediasoup-client |
| Database | Prisma 6 — SQLite in dev, PostgreSQL in production |
| Web | Next.js 15 App Router, React 19, Tailwind 3, Zustand |
| Payments | Razorpay (mock mode when keys are absent) |

---

## Quick start

```bash
# 1. Install (also fetches the mediasoup worker binary)
npm install

# 2. Configure — the same file in all three locations
cp .env.example .env
cp .env.example apps/server/.env
cp .env.example apps/web/.env.local
#    then edit JWT_SECRET at minimum

# 3. Create the schema and seed demo data
npm run db:push
npm run db:seed

# 4. Run both apps
npm run dev
```

- Web: <http://localhost:3000>
- API: <http://localhost:4000> — health at `/api/health`

> **Setting this up for the first time, or deploying it?** Read
> [`docs/running-the-platform.md`](docs/running-the-platform.md) — the complete
> runbook covering prerequisites, every environment variable, database setup,
> production builds, Docker, WebRTC networking, and troubleshooting.

### Demo credentials

| Role | Email | Password |
|---|---|---|
| Admin | `admin@webinar.local` | `Admin@12345` |
| Host | `host@webinar.local` | `Host@12345` |
| Moderator | `mod@webinar.local` | `Mod@12345` |

The seed also creates a published webinar at `/w/live-product-teardown` with quizzes,
an offer, and a course attached.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server + web together (concurrently) |
| `npm run dev:server` | API + SFU only, `tsx watch` |
| `npm run dev:web` | Next.js dev server only |
| `npm run build` | Compile server (`tsc`) and web (`next build`) |
| `npm start` | Run both production builds |
| `npm run typecheck` | Typecheck both workspaces |
| `npm run db:push` | Sync Prisma schema, regenerate client |
| `npm run db:seed` | Seed demo users, webinar, quizzes, offers |
| `npm run db:studio` | Prisma Studio |
| `npm run verify` | Run all 29 verification suites against a live API |
| `npm run verify:reset` | Restore the demo webinar to `LIVE` |

---

## How media visibility works

Every producer is tagged with a `source` — `camera`, `microphone`, or `screen` — and
every consumer request is filtered through one function in
`apps/server/src/realtime/visibility.ts`:

```ts
export function canConsume(viewer, producerOwner, policy): boolean {
  if (isStaffRole(viewer.role)) return true;              // staff see everything
  if (isStaffRole(producerOwner.role)) return true;       // participants get staff media
  if (policy.participantsSeeEachOther) return true;       // host opened the room up
  if (producerOwner.kind === 'video' && producerOwner.source === 'screen') {
    return producerOwner.isApprovedSpeaker;               // a share is a presentation
  }
  if (producerOwner.kind === 'video') return false;       // never another participant's camera
  return producerOwner.isApprovedSpeaker;                 // only an approved speaker's audio
}
```

Consequences worth knowing:

- A participant who raises their hand and is approved can publish mic, camera, **and**
  screen — but only staff and other approved speakers receive their camera.
- A screen share is treated as a presentation and reaches the whole room, because that
  is the point of sharing a screen.
- When a speaker is revoked, `revalidateVisibility()` closes the consumers that are no
  longer permitted, so revocation is immediate rather than advisory.
- A host can turn on **Participants see each other** (`showParticipantsToEachOther`,
  off by default) to make the room behave like a meeting. It is all-or-nothing: the
  audience either sees everyone or only staff, never a confusing half-measure.
- The roster is filtered by the same rules (`canSeePeer`), so a participant is not even
  told that another participant exists while the setting is off.

---

## Waiting room and going live

Participants are allowed into the room before the host starts. They get a live roster,
working chat, and a screen that says plainly that the webinar has not started yet —
rather than an empty video grid with a spinner, which reads as a broken page.

The host sees the real room the whole time, so they can check their camera and slides
without an audience watching them fumble, and opens the session with **Host tools → Go
live**. Everyone waiting drops straight in — the socket is already connected, so there
is nothing to re-join and no reload.

Two details make this hold up:

- **`startedAt` is explicit server state**, not something the client infers from the
  peer list. "Nobody is here yet" and "the session has not begun" look identical
  otherwise.
- **Starting is idempotent.** A double-click, or a second host arriving late, returns
  the existing start time and does not re-fire the event — otherwise the waiting screen
  would flash back over a session that is already running.

The start is persisted on the webinar row, so a participant who reloads an hour later
still finds the session open. A webinar already `LIVE` in the database is treated as
started when its room is created, which covers rooms rebuilt after the last peer left.

---

## Recording and replay

A host opens **Host tools → Session recording → Start recording**. Everyone in the room
gets an amber **REC** badge, and the session is captured until the host stops it or ends
the webinar.

A recording is two independent things:

- **The timeline** — every chat message, quiz launch, quiz result, offer shown or hidden,
  hand raise and peer join, each stamped with milliseconds since the recording started.
  This is always captured.
- **The media** — the host's video, muxed to MP4 by FFmpeg over a mediasoup plain
  transport. This is best-effort.

That split is the whole design. A session with no camera still produces a replay worth
watching, because the chat, quizzes and offers are the part people come back for. If the
media pipeline fails, the recording is still created with `mediaKind: "none"` — a broken
encoder must never cost you the chat log.

Replay at `/replay/<recordingId>` is not video playback with overlays bolted on. It is a
clock: advancing it and applying every event whose timestamp has passed reconstructs the
session. Seeking backwards is instant, and a timeline-only recording is still fully
navigable. The chat panel fills in as the clock reaches each message, the quiz popup
reappears at the moment it was launched, and the offer card slides back in at its offset.

Recordings are listed per webinar under **Admin → Recordings**, where they can be watched
or deleted.

---

## Project layout

```
apps/
  server/
    prisma/            schema + seed
    src/
      config/          env parsing, mediasoup worker pool
      middleware/      auth, error handling, rate limiting
      modules/         auth, webinars, registrations, payments, quizzes,
                       recordings, customFields, cohosts, streams, series,
                       embed, analytics, automation, webhooks, publicApi
      realtime/        Room, Peer, Recorder, visibility policy, Socket.IO wiring
  web/
    app/               App Router pages (landing, webinar, pay, room, replay, admin)
    components/        VideoGrid, VideoTile, ControlsBar, ChatPanel, QuizModal,
                       CtaOverlay, HostPanel, ParticipantList, RecordingsPanel,
                       QaPanel, PollsPanel, WaitingRoom, MediaRequestPrompt,
                       MediaSettingsPanel, CustomFieldsForm, WatermarkOverlay,
                       PendingApproval
    components/admin/  AdminShell (sidebar + top bar), the inline icon set,
                       PanelKit, and the 11 feature panels
    lib/               API client, socket factory, useMediasoup hook, theme
                       provider, backgroundEffects, audioProcessor, mediaPrefs
    store/             Zustand room store
packages/
  shared/              Types shared by server and web (consumed from source)
infra/docker/          Multi-stage Dockerfiles for server and web
infra/nginx/           nginx config template (rendered by both deploy scripts)
infra/coturn/          coturn config template
deploy/                Production .env example
deploy.sh              Docker deployment (compose)
deploy-native.sh       Bare-metal deployment (systemd + host nginx)
scripts/               Runtime verification scripts (29 suites + shared harness)
```

---

## Console theming

The host console (`/admin`) is a sidebar layout with a manual light/dark switch.
The theme is driven by a class on `<html>` (`darkMode: 'class'`), not the OS
preference, so a host can keep the console light while the room stays dark.

- **Tokens.** `tailwind.config.ts` maps semantic colour names — `surface`,
  `panel`, `panel-2`, `line`, `fg`, `muted`, `subtle` — onto RGB triplets held in
  CSS variables. `bg-panel/60` and friends keep working while the palette swaps.
- **Palettes.** `app/globals.css` defines the dark values in `:root` and the
  light overrides in `.theme-light`, plus light-mode restatements of the shared
  component classes (`.glass`, `.card`, `.input`, `.btn-ghost`, …).
- **State.** `lib/theme.tsx` exposes `ThemeProvider` / `useTheme`. The choice is
  persisted in `localStorage['nexa:theme']`.
- **No flash.** `app/admin/layout.tsx` injects a tiny blocking script that sets
  the class before React hydrates, so the first paint is already correct.
- **Scoping.** The class is applied to `<html>` only while a console route is
  mounted and removed on unmount. The landing, room and replay pages are
  dark-only by design and are never affected by a light console.

---

## Environment notes

**mediasoup worker binary.** `mediasoup` downloads a prebuilt native worker during
`npm install`. Behind a proxy that download can fail silently, leaving the package
installed but unusable. `apps/server/scripts/fetch-mediasoup-worker.mjs` runs as a
`postinstall` step and fetches the binary directly from GitHub releases if it is
missing. If the server exits with a worker error, run that script manually.

**Corporate proxies.** Node's global `fetch` ignores `HTTP(S)_PROXY`, so any download
performed by a script must go through `curl` or an explicit proxy agent. `npm` itself
honours the standard proxy variables.

**No camera or microphone.** In a headless or VM environment `getUserMedia` throws
`NotFoundError`. The room still works — you join as a viewer, and screen share can be
exercised by stubbing `getDisplayMedia`.

**Payments.** With `RZP_KEY_ID` and `RZP_KEY_SECRET` blank, the payments module runs in
mock mode: `POST /api/payments/order` returns `mock: true` and the client completes the
flow locally. Set real keys to use Razorpay Checkout, and set `RZP_WEBHOOK_SECRET` to
enable signature-verified webhooks.

**Email.** Three transports, chosen in this order:

1. `SMTP_HOST` set — plain SMTP, any provider.
2. `RESEND_API_KEY` set — Resend over SMTP.
3. Neither — messages are written to the server log instead of sent.

Mail is always best-effort. A send failure is logged and swallowed, because a mail
outage must never fail a registration or roll back a payment that already succeeded.
Confirmation emails carry a join link with the token in the query string, so a
registrant can enter the room from a device that has never visited the site.

**Reminders.** `apps/server/src/utils/reminders.ts` runs a 60-second scheduler that
emails registrants 24 hours, 1 hour, and 10 minutes before a webinar starts. Each
`(webinar, lead)` pair is sent at most once per process. Set `REMINDERS_ENABLED=false`
to turn it off.

**Calendar.** Every webinar page and confirmation page offers an *Add to calendar*
link that downloads an `.ics` file from `GET /api/webinars/:slug/calendar.ics`. The
event carries the join URL and a 10-minute alarm, so a registrant who never opens
the email still gets a nudge.

**Guest join.** A webinar with `requireRegistration` switched off asks only for a
name. `POST /api/webinars/:slug/guest` mints a throwaway guest identity and returns
the same payload as registration, so chat, quizzes and hand raises all work without
an account.

**Refunds.** The admin console has a *Payments* tab per webinar listing every
transaction with the buyer attached. A `PAID` row can be refunded in one click. A
full refund revokes access (the seat loses `paid`, a course purchase loses its
enrollment); a partial refund leaves access intact. When Razorpay is not configured
the refund is simulated so the database still records what a real deployment would.

---

## Deployment

Two paths, same result. Pick one.

### With Docker

```bash
./deploy.sh install     # generates secrets, builds, starts, prints the ports
./deploy.sh ports       # the whitelist, any time
./deploy.sh firewall    # apply it with ufw or firewalld
```

Brings up six containers: PostgreSQL, Redis, the API, the web client, coturn, and nginx.

### Without Docker (systemd + host nginx)

```bash
sudo ./deploy-native.sh install
```

Node runs under systemd (`webinar-api`, `webinar-web`), nginx and coturn come from the
distro, and PostgreSQL is either installed locally or replaced with SQLite. Same
subcommands as `deploy.sh`: `up`, `down`, `restart`, `rebuild`, `logs [svc]`, `status`,
`ports`, `firewall`, `env`, `backup`, `destroy`.

Requires Node 20+, systemd, and root (or sudo). `ports` and `env` work without root.

Both scripts detect the public IP, ask for a domain, generate `JWT_SECRET`, the admin
password, the Postgres password and the TURN password, write `.env` (mode 600), render
the nginx and coturn configs from the same templates, build, start, and wait for
`/api/health`. The admin password is printed once.

Run `./deploy.sh --help` or `./deploy-native.sh --help` for the full list.

### TLS

**nginx does not terminate TLS.** It listens on plain HTTP on `HTTP_PORT` (5173) and
expects a TLS terminator in front of it. On a VPS with Caddy already installed, the
whole config is:

```caddy
webinar.example.com {
    reverse_proxy 127.0.0.1:5173
}
```

Caddy owns 80/443, obtains and renews the certificate, and forwards WebSocket upgrades
for `/socket.io/` without extra config. It also sets `X-Forwarded-Proto`, which nginx
passes through so the app sees `https`. There is no certbot, no ACME webroot, and no
`SSL_ENABLED` switch to manage.

If you are not using Caddy, any reverse proxy that forwards to `127.0.0.1:5173` and
preserves the `Upgrade`/`Connection` headers will do.

### Ports

Every port is a variable in `.env`. `./deploy.sh ports` (or `./deploy-native.sh ports`)
prints the authoritative list, computes the peer capacity from the actual RTC range, and
emits copy-paste `ufw` and `firewalld` rules.

| Port | Proto | Exposure | Purpose |
|---|---|---|---|
| `HTTP_PORT` (5173) | tcp | loopback | Web app, API, websocket via nginx. Caddy fronts this and terminates TLS. |
| `RTC_MIN_PORT`–`RTC_MAX_PORT` | udp + tcp | public | WebRTC media |
| `TURN_PORT` (3478) | udp + tcp | public | TURN relay |
| `TURN_TLS_PORT` (5349) | tcp | public | TURN over TLS |
| `TURN_MIN_PORT`–`TURN_MAX_PORT` | udp | public | TURN relay range |
| `API_PORT` (4000) | tcp | loopback | API + SFU |
| `WEB_PORT` (3000) | tcp | loopback | Next.js |
| `POSTGRES_PORT` (5432) | tcp | loopback | PostgreSQL |
| `REDIS_PORT` (6379) | tcp | loopback | Redis |

Open the public ones in **both** the host firewall and the cloud provider's security
group.

### Capacity — read this before promising 500 seats

The RTC port range is the hard limit. Each peer uses 2 transports (send + recv) and each
transport takes 1 port, so concurrent peers ≈ `(RTC_MAX_PORT - RTC_MIN_PORT + 1) / 2`.
The range is shared by **all** mediasoup workers — raising `MEDIASOUP_WORKERS` adds
throughput, not capacity.

| Range | Ports | Peers |
|---|---|---|
| `40000-40100` (old default) | 101 | **~50** |
| `40000-42000` (recommended) | 2001 | **~1000** |

Measured directly against mediasoup 3.31, not inferred. Beyond the port range, egress
bandwidth is the next wall: 500 viewers × ~1 Mbps ≈ 500 Mbps outbound.

### Manual start

```bash
cp deploy/env.production.example .env
# edit .env: POSTGRES_PASSWORD, JWT_SECRET, ADMIN_PASSWORD, PUBLIC_IP, SERVER_NAME
docker compose --env-file .env up --build -d
```

The schema and admin account are applied by the container entrypoint when
`RUN_MIGRATIONS=1`, so no `exec` step is needed.

The full deployment checklist — including the `NEXT_PUBLIC_*` build-time trap, the
reverse-proxy WebSocket requirements, and the coturn configuration — is in
[`docs/running-the-platform.md`](docs/running-the-platform.md#10-running-with-docker-compose).

---

## Verification scripts

These run against a live dev server and assert real behaviour over the wire:

```bash
node scripts/verify-all.mjs            # all 29 suites below, in order, with a summary
```

**Core**

| Suite | Checks | Covers |
|---|---|---|
| `verify-polls.mjs` | 29 | poll CRUD, launch/vote/close, join gate |
| `verify-qa.mjs` | 37 | ask, broadcast, upvote, staff gates |
| `verify-quiz-cta.mjs` | 17 | quiz + offer lifecycle |
| `verify-engagement.mjs` | 18 | admin quiz/offer/course authoring |
| `verify-guest-join.mjs` | 26 | guest join + admin refunds |
| `verify-security.mjs` | 33 | passcode, invite-only, required sign-in, each gate in isolation |
| `verify-media-requests.mjs` | 25 | mic/cam state, host requests |
| `verify-waiting-room.mjs` | 16 | waiting room + go live |
| `verify-recording.mjs` | 58 | recording + replay timeline |
| `verify-premiere.mjs` | 24 | scheduled replay |
| `verify-screen-share.mjs` | — | screen producers are tagged `source: 'screen'` |
| `verify-media-effects.mjs` | 59 | vendored assets, worklet syntax, prefs |
| `verify-moderation.mjs` | 17 | chat moderation, kicks, hand raises |

**webinar.gg parity**

| Suite | Checks | Covers |
|---|---|---|
| `verify-custom-fields.mjs` | 25 | field CRUD, options, reorder, soft delete, join form, responses, export |
| `verify-approval.mjs` | 30 | pending on register, approve/reject/waitlist/cancel, approve-all, join gate |
| `verify-invites.mjs` | 19 | bulk invite, uninvite, invitee list, attended flag |
| `verify-cohosts.mjs` | 31 | add by email/user, permission map, policy patch, remove, enforcement |
| `verify-webhooks.mjs` | 33 | subscription CRUD, delivery, signature, retry, event log |
| `verify-public-api.mjs` | 52 | token create/revoke, bearer auth, `/api/v1` CRUD, error envelope |
| `verify-embed.mjs` | 27 | embed config, origin allow-list, snippet, public policy endpoint |
| `verify-automation.mjs` | 41 | bundle validation, import, cue editing, export round-trip, reset |
| `verify-series.mjs` | 36 | recurrence preview, generation, occurrence isolation, cancel |
| `verify-stream-destinations.mjs` | 37 | add/list/remove, platform rules, live lock, key redaction, ffmpeg |
| `verify-metrics.mjs` | 20 | post-event metrics, peak users, duration, engagement, cache |
| `verify-watermark.mjs` | 25 | watermark payload, guest vs signed-in label, hidden viewer count |

Each logs in as the seeded admin, registers a throwaway participant, and exits non-zero
on failure. `verify-all.mjs` runs them in a fixed order and resets the demo webinar
between the suites that leave it in an unusable state — `verify-moderation.mjs` ends the
webinar, and `verify-premiere.mjs` and `verify-waiting-room.mjs` leave it `LIVE` with a
start time. `verify-guest-join.mjs` creates and deletes its own webinars, so it leaves
the demo untouched. `verify-recording.mjs` deletes the recording it creates.

**Every parity suite creates its own fixture webinar and deletes it in a `finally`.**
They are re-runnable, independent of the demo data, and need no reset.

**Close any browser tab that is in the room before running the suites.** A tab logged in
as the seeded admin holds the same single socket slot the suite's host needs, and the
suite's host is then kicked with "Not in a room".

---

## Media effects

Participants and hosts can shape their outgoing media from the **Media settings** button
in the control bar. Everything runs in the browser — no frame or audio sample is sent to
the server for processing.

| Setting | What it does |
|---|---|
| **Virtual background** | Off, blur, or an image. Six built-in gradients plus your own upload. |
| **Noise cancellation** | A spectral gate on the microphone, run as an AudioWorklet. |
| **Video fit** | Cover, contain, fill, scale-down, or none. |
| **Mirror** | Flips your own preview only — peers always see the unmirrored frame. |

**Virtual backgrounds** use MediaPipe's selfie segmenter to build a per-frame mask, then
composite the camera over a blurred copy of itself or over the chosen image. The result
is a `canvas.captureStream()` track that replaces the camera track on the existing
producer, so switching a background never renegotiates the transport and never
interrupts anyone's video.

**Noise cancellation** is a 512-point spectral gate written in-repo, not RNNoise. RNNoise
is a trained network that needs a ~90 KB WASM binary fetched at runtime; a gate is weaker
on non-stationary noise but has no download and cannot fail to initialise. When the
worklet is unavailable the native `noiseSuppression` constraint is requested instead —
never both, because running two suppressors thins the voice.

### Assets are vendored, not fetched

MiroTalk loads MediaPipe from a CDN. That is a firewall dependency, so every asset is
served from our own origin:

```
apps/web/public/mediapipe/vision_bundle.mjs          137 KB
apps/web/public/mediapipe/wasm/*.js, *.wasm          9.5 MB
apps/web/public/models/selfie_segmenter_landscape.tflite   250 KB
apps/web/public/worklets/noiseSuppressionProcessor.js
```

The worklet is served verbatim as an ES module, so it must stay plain JavaScript — a
TypeScript annotation in that file is a `SyntaxError` at `addModule` time, in the browser,
for every participant. `verify-media-effects.mjs` asserts this.

### Degradation

Every failure path falls back to the raw camera track and surfaces a message in the
panel. A background that will not load must never cost someone their video. Preferences
persist in `localStorage`; custom uploads live in IndexedDB and are downscaled to 1280 px
and re-encoded to WebP before storage.

See [`docs/media-effects.md`](docs/media-effects.md) for the pipeline and the constraints.

---

## Further reading

- [`docs/running-the-platform.md`](docs/running-the-platform.md) — **the complete setup and operations runbook**: prerequisites, every environment variable, database setup, dev and production runs, Docker, WebRTC networking, verification, troubleshooting
- [`docs/architecture.md`](docs/architecture.md) — request and media flows
- [`docs/api.md`](docs/api.md) — REST endpoints, including the `/api/v1` public API
- [`docs/socket-events.md`](docs/socket-events.md) — realtime contract and the co-host permission model
- [`docs/media-effects.md`](docs/media-effects.md) — virtual backgrounds and noise cancellation
- [`docs/webinar-gg-parity.md`](docs/webinar-gg-parity.md) — the competitor feature audit and what closed each gap
