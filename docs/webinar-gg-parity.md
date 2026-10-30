# webinar.gg parity — feature plan

> Setting the project up, configuring it, or deploying it? Start with
> [`running-the-platform.md`](running-the-platform.md). This document is a feature
> audit — it records what was compared and what was built, not how to run it.

Researched from `webinar.gg` (landing page), `/docs`, `/llms.txt` and
`/llms-full.txt` on 2026-10-27. This document records what webinar.gg ships,
what this platform already had, and what was added to close the gap.

## What webinar.gg ships

From the landing page ("Powerful Features"):

| Pillar | Their claim |
|---|---|
| Live Sessions | Go live in seconds, join from any browser with one link, no installs |
| Host Controls | One focused panel: mute, spotlight, moderate Q&A |
| Audience Engagement | Live chat, polls, Q&A steered from the stage |
| Recording | Unlimited cloud recordings, plus pre-recorded webinars you can schedule and re-run |
| Security | Invite-only auth, passcodes, required sign-ins |

From the developer docs, the full surface is considerably larger:

- **Webinars API** — CRUD, lifecycle status poll, post-event metrics.
- **Invites and registration** — bulk email invites, uninvite, invitee list with
  `attended` state, **custom join-form fields** (11 types, options, reorder,
  soft delete, reuse from a previous webinar), **join tokens** (10 min, 10 uses,
  host or attendee, carries `customResponses`).
- **Co-hosts** — up to 10 per room, added by email or user id, with a
  **granular permission map** (`chatModeration`, `qna`, `polls`, `usersControl`,
  `waitingRoom`, `startWebinar`, `endWebinar`, `screenshare`, `liveSettings`,
  `handraise`) plus `cohostStartWithoutHost`.
- **Stream destinations** — push the live room to YouTube, Twitch or a custom
  RTMP server. Max 3, one per platform, addable only before the start.
- **Webinar series** — `DAILY | WEEKLY | MONTHLY | YEARLY` recurrence with
  `interval`, `byWeekday`, `byMonthday`, `count`/`until`; each occurrence is a
  normal webinar; cancel one or the whole series.
- **Webhooks** — `webinar.created|updated|started|ended|deleted`,
  `webinar.user.invited|uninvited`, `webinar.slot.ended`,
  `webinar.recording.created`, and five `registration.*` events.
- **Iframe embedding** — one-time join token is mandatory inside an iframe;
  `postMessage` both ways (`webinar-ended`, `webinar-user-left`,
  `webinar-user-kicked`, `webinar-tab-duplicate`, `fullscreen`,
  `fullscreen_exit`, `USER_INTERACTION` out; `SET_VOLUME`, `SET_DISABLED` in).
- **Automation timeline** — a portable JSON bundle of scheduled chat, Q&A, polls
  and offers, plus personas and a simulated attendance curve. Strictly
  validated, unknown keys rejected.
- **Analytics events** — `ViewContent`, `CompleteRegistration`,
  `InitiateCheckout`, `Purchase`, `Join` fired into GA4 / Meta Pixel / Clarity /
  GTM.
- **Registration approval** — `requireApproval` puts registrants in a waiting
  room; hosts approve, reject, waitlist or cancel, one at a time or "approve
  all".
- **Watermark** — viewer id and email (or name for guests) burned over the video.
- **Show live users count** — a per-webinar toggle.

## What this platform already had

Live SFU sessions, host controls (mute, mute-all, spotlight, kick, media
requests), chat with profanity masking, polls, Q&A with upvotes, quizzes, CTAs,
Razorpay payments with refunds, registration + guest join + claim gate,
passcode / invite-only / require-sign-in, `.ics` calendar, recording + replay +
premiere, waiting room, media effects (virtual background, noise gate, echo
cancellation, frame rate, fit, mirror), basic analytics and CSV export.

## What was missing, and what was added

All fourteen gaps are closed, wired end to end (schema → service → route →
realtime → admin UI → participant UI) and covered by a verification suite.

| # | Feature | Status | Suite | Checks |
|---|---|---|---|---|
| 1 | Custom registration fields (11 types) | implemented | `verify-custom-fields.mjs` | 25 |
| 2 | Registration approval workflow | implemented | `verify-approval.mjs` | 30 |
| 3 | Bulk email invites + invitee list | implemented | `verify-invites.mjs` | 19 |
| 4 | Co-hosts with granular permissions | implemented | `verify-cohosts.mjs` | 31 |
| 5 | Watermark overlay | implemented | `verify-watermark.mjs` | 25 |
| 6 | Show live users count toggle | implemented | `verify-watermark.mjs` | (same suite) |
| 7 | Outbound webhooks | implemented | `verify-webhooks.mjs` | 33 |
| 8 | Public API tokens + `/api/v1` | implemented | `verify-public-api.mjs` | 52 |
| 9 | Iframe embedding + `postMessage` | implemented | `verify-embed.mjs` | 27 |
| 10 | Analytics events (GA4/Meta/GTM/Clarity) | implemented | `smoke-parity.mjs` | (config round-trip) |
| 11 | Automation timeline import/export | implemented | `verify-automation.mjs` | 41 |
| 12 | Webinar series / recurrence | implemented | `verify-series.mjs` | 36 |
| 13 | Stream destinations (RTMP) | implemented | `verify-stream-destinations.mjs` | 37 |
| 14 | Post-event metrics / attendee report | implemented | `verify-metrics.mjs` | 20 |

Run everything with `node scripts/verify-all.mjs` — 25 suites, all green.

## Design notes

### Custom fields

A field is a row, not a JSON blob, because the join form is queried on every
page load and the responses have to be exportable per field. Options are their
own table so they can be reordered and soft-deleted without rewriting the
parent. Soft delete (`deletedAt`) keeps historical responses readable — a
report from last month must not lose a column because the host tidied the form.

### Approval

`Registration.status` is the single source of truth:
`PENDING | APPROVED | REJECTED | WAITLISTED | CANCELLED`. When a webinar does
not require approval, a registration is created `APPROVED` — the column is
always populated, so no code has to branch on "approval is off".

### Co-host permissions

Stored as a JSON column on `WebinarCohost`. The permission map is merged over a
default at read time, so adding a new permission later does not require a
migration of existing rows. `startWebinar` and `endWebinar` default to `false`
(matching webinar.gg's 2026-10-03 change); everything else defaults to `true`.

### Webhooks

Delivered from an outbox table, not inline. A slow or dead endpoint must never
block a socket handler. Each delivery records its attempt count and last error,
so a host can see why their endpoint is failing. Payloads are signed with
HMAC-SHA256 over the raw body in `X-Webinar-Signature`, so a receiver can prove
the call came from us.

### Public API

Tokens are stored hashed. The plaintext is shown once at creation, matching
webinar.gg. The `/api/v1` surface reuses the same service layer as the console
routes — a second implementation would drift.

### Automation timeline

Validated as one document with zod, and the error names the failing path
(`cues[3].simulate.weights`). Unknown top-level keys are rejected: a typo must
fail loudly rather than silently do nothing. Times are offsets from the start
of the webinar, never wall-clock, so a bundle is portable between events.

### Stream destinations

Keys are write-only and encrypted at rest. Responses carry only `keyHint` (last
4 characters) and, for custom servers, the host. Adding is refused once the
webinar is live — the destination list is fixed for the session.

### Series

A series is a recurrence rule plus generated occurrences. Each occurrence is a
normal `Webinar` row with `seriesId` and `occurrenceIndex`, so everything else
in the platform works on it unchanged.

## Verification

Each feature has a suite under `scripts/`. Every suite creates its own fixture
webinar and deletes it in a `finally`, so they are re-runnable and independent
of the demo data. `node scripts/verify-all.mjs` runs all 25 suites in order.

| Suite | Checks | Covers |
|---|---|---|
| `verify-custom-fields.mjs` | 25 | field CRUD, options, reorder, soft delete, join form, responses, export |
| `verify-approval.mjs` | 30 | pending on register, approve/reject/waitlist/cancel, approve-all, join gate |
| `verify-invites.mjs` | 19 | bulk invite, uninvite, invitee list, attended flag |
| `verify-cohosts.mjs` | 31 | add by email/user, permission map, policy patch, remove, enforcement |
| `verify-webhooks.mjs` | 33 | subscription CRUD, delivery, signature, retry, event log |
| `verify-public-api.mjs` | 52 | token create/revoke, bearer auth, `/api/v1` CRUD, scoping, error envelope |
| `verify-embed.mjs` | 27 | embed config, origin allow-list, snippet, public policy endpoint |
| `verify-automation.mjs` | 41 | bundle validation, import, cue editing, export round-trip, reset |
| `verify-series.mjs` | 36 | recurrence preview, generation, occurrence isolation, cancel single/series |
| `verify-stream-destinations.mjs` | 37 | add/list/remove, platform rules, live lock, key redaction, ffmpeg command |
| `verify-metrics.mjs` | 20 | post-event metrics, peak users, duration, engagement counts, cache |
| `verify-watermark.mjs` | 25 | watermark payload, guest vs signed-in label, toggle, hidden viewer count |

## Known limits

- **Stream destinations are locked while a webinar is `LIVE`.** This is
  deliberate — the destination list is fixed for the session — so any test or
  UI flow that adds one must use a `DRAFT` or `SCHEDULED` webinar.
- **A co-host's permission map is read at join time.** Changing a co-host's
  permissions takes effect when they rejoin, not instantly.
- **The metrics cache is only served for an `ENDED` webinar.** A `LIVE` webinar
  recomputes on every call, because the numbers are still moving.
- **Embed origins reject wildcards.** `*` is the same as no allow-list, so the
  schema refuses it rather than pretending to enforce something.
- **The automation bundle is `.strict()`.** An unknown top-level key is a 400,
  not a silent no-op — a typo must fail loudly.
