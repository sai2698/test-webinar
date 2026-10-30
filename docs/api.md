# REST API

> For installation, configuration, and running the server, see
> [`running-the-platform.md`](running-the-platform.md).

Base URL: `http://localhost:4000`. All responses are JSON. Errors use
`{ "error": "message", "details"?: { field: string[] } }` with a matching HTTP
status — `error` is a plain string, not an object.

Authentication is a bearer token: `Authorization: Bearer <jwt>`. The token is issued by
`POST /api/auth/login` or `POST /api/webinars/:slug/register`.

**Two identities, one browser.** The console and the attendee flow are separate
sessions and are expected to coexist — a host testing their own webinar is the
ordinary case. They are kept apart on both sides:

- **Client.** The console stores its JWT under `nexa:admin:token` /
  `nexa:admin:user`; the attendee flow keeps the historical `token` / `user`.
  Registering as a participant therefore cannot evict a signed-in host. The
  request scope is derived from the path — anything under `/api/admin` is sent
  as the console, everything else as the attendee — so a new endpoint cannot be
  wired to the wrong token. `POST /api/webinars/:slug/host-join` is the one
  staff route outside that prefix and is special-cased. A JWT whose `exp` has
  passed is treated as no session at all, which sends the user to sign-in
  instead of leaving a console that renders but cannot load anything.
- **Server.** `POST /api/auth/login` also sets an httpOnly cookie scoped to
  `Path=/api/admin`, so a console page load is authenticated before any
  JavaScript runs and a refresh cannot lose the session. The scope is what keeps
  it out of attendee requests: a host who registers for their own webinar must
  be treated as that participant, not silently upgraded to staff by an ambient
  cookie. `extractToken` prefers the `Authorization` header, so an explicit
  Bearer always wins over the cookie.

**Sign-in navigation follows the session.** `/admin/login` checks for an
existing console session on mount and redirects to `/admin` when one is found,
so a signed-in host is never asked for credentials the browser already holds.
The landing page's console link is session-aware for the same reason: it points
at `/admin` when signed in and `/admin/login` when not, and its label changes
with the destination. Both checks treat an expired JWT as no session, so a
stale token still lands on the form rather than a console that cannot load.

**Exception — the public API.** Every path under `/api/v1` uses a
`{ "success": boolean, "data"?: T, "error"?: string, "details"?: unknown }`
envelope, for failures as well as successes. A machine client should never have
to special-case the one response it most needs to handle.
---

## Health

### `GET /api/health`

No auth. Used by the container healthcheck.

```json
{ "ok": true, "uptime": 254.09, "workers": 2, "rooms": 1 }
```

`workers` is the mediasoup worker pool size; `rooms` is the number of live rooms.

---

## Auth

### `POST /api/auth/login`

```json
{ "email": "admin@webinar.local", "password": "Admin@12345" }
```

```json
{
  "token": "eyJhbGciOi...",
  "user": { "id": "cmvor...", "name": "Platform Admin", "email": "admin@webinar.local", "role": "ADMIN" }
}
```

Rate limited. Returns `401` on bad credentials.

Also sets a session cookie:

```
Set-Cookie: token=<jwt>; Max-Age=604800; Path=/api/admin; HttpOnly; SameSite=Lax
```

`Path=/api/admin` is deliberate — see *Two identities, one browser* above. The
lifetime matches the JWT's own `exp`; a cookie that outlives its token is worse
than no cookie, because the browser keeps sending a credential the server has
already rejected. Any legacy `Path=/` cookie from an earlier build is cleared on
the same response, so a browser that signed in before the scoping change cannot
stay silently authenticated.

### `GET /api/auth/me`

Requires auth. Returns the current user. Accepts either the Bearer token or the
scoped cookie.

### `POST /api/auth/logout`

Clears the auth cookie and returns `{ "ok": true }`. Both the `/api/admin` and
the legacy `/` paths are cleared — a cookie is identified by name *and* path, so
clearing one leaves the other authenticating every request.

**The JWT itself is not revoked.** Clearing a cookie is a browser instruction,
not a server-side invalidation, so a token captured before sign-out remains
valid until its `exp`. This is the ordinary trade-off of a stateless JWT; a
revocation list would be needed to close it.

---

## Public webinars

### `GET /api/webinars/:slug/public`

No auth. The public projection — internal ids and staff assignments are omitted.

```json
{
  "webinar": {
    "slug": "live-product-teardown",
    "title": "Live Product Teardown",
    "description": "...",
    "bannerUrl": null,
    "startsAt": "2026-10-26T12:00:00.000Z",
    "durationMins": 60,
    "timezone": "Asia/Kolkata",
    "status": "SCHEDULED",
    "hostName": "Ananya Sharma",
    "settings": {
      "requireRegistration": true,
      "requirePayment": false,
      "priceInPaise": 0,
      "currency": "INR",
      "chatEnabled": true,
      "handRaiseEnabled": true,
      "allowMic": true,
      "allowVideo": true,
      "maxParticipants": null,
      "showPeopleTab": false,
      "showQaTab": false,
      "showPollsTab": false,
      "showParticipantsToEachOther": false
    }
  }
}
```

### Participant sidebar tabs

`showPeopleTab`, `showQaTab` and `showPollsTab` decide which sidebar tabs the
**audience** sees. All three default to `false` — a broadcast should not hand every
viewer the attendee list, and an empty Q&A queue or poll list reads as a broken
feature rather than an unused one.

Staff (`ADMIN`, `HOST`, `MODERATOR`) always see all four tabs regardless: they need
the roster, the question queue and the poll list to run the room. The flags are
therefore a per-role hide, not a suppressed value — the same shape as
`showLiveUsersCount`.

A launched poll or quiz still reaches everyone as a modal, so turning the Polls tab
off hides the *list*, not the polls themselves.

### Participant media visibility

`showParticipantsToEachOther` decides whether the **audience** may see and hear each
other. It defaults to `false`, because a webinar is a broadcast: an attendee joining a
product demo does not expect their camera in every other attendee's grid.

When it is `false`, a participant receives only staff media — plus the audio and screen
share of the one participant a moderator has approved to speak. When it is `true`, the
SFU creates consumers between participants and the room behaves like a meeting.

This is enforced in the SFU, not the UI. Hiding a tile is not a privacy guarantee, so
`canConsume` refuses to create the consumer at all; see
[`architecture.md`](architecture.md#the-visibility-policy). Staff are mutually visible
either way — the flag governs the audience only.

Changing it on a live webinar takes effect immediately: the PATCH handler pushes the
new settings into the running room and re-evaluates every consumer, so existing streams
are torn down or announced without anyone rejoining.

---

## Registration

### `POST /api/webinars/:slug/register`

No auth. Creates or reuses a participant and returns a join token.

```json
{ "name": "Priya Nair", "email": "priya@example.com", "phone": "+91..." }
```

```json
{
  "token": "eyJhbGciOi...",
  "user": { "id": "...", "name": "Priya Nair", "email": "priya@example.com" },
  "registration": { "joinToken": "V1StGXR8...", "paid": true },
  "requiresPayment": false,
  "webinar": { "slug": "...", "title": "...", "startsAt": "...", "priceInPaise": 0, "currency": "INR" }
}
```

`requiresPayment: true` means the client must run checkout before the room will admit
them. Returns `400` if the webinar has ended.

### `GET /api/webinars/:slug/join-info?token=<joinToken>`

No auth. Validates a join link before the room page opens a socket. Returns `400` when
payment is outstanding, `404` when the token does not belong to this webinar.

---

## Payments

All payment routes require auth. **Prices always come from the database, never from the
request body.**

### `POST /api/payments/order`

```json
{ "webinarId": "cmvor..." }
```
or
```json
{ "ctaId": "cmvor..." }
```

```json
{
  "orderId": "order_mock_1a2b3c",
  "amount": 499900,
  "currency": "INR",
  "paymentId": "cmvor...",
  "keyId": null,
  "mock": true
}
```

`mock: true` means Razorpay keys are not configured — the client should complete the
flow locally by calling `/verify` with synthetic ids.

### `POST /api/payments/verify`

```json
{
  "razorpayOrderId": "order_mock_1a2b3c",
  "razorpayPaymentId": "pay_mock_1729...",
  "razorpaySignature": "mock_order_mock_1a2b3c"
}
```

Verifies the HMAC, marks the payment `PAID`, fulfils the registration or enrollment, and
announces the enrollment in chat. Idempotent — a repeat call returns
`{ "ok": true, "alreadyProcessed": true }`.

### `POST /api/payments/webhook`

Razorpay → server. Mounted with a **raw body parser before `express.json()`** so the
signature can be checked against the exact bytes received. Requires
`RZP_WEBHOOK_SECRET`.

---

## Admin — webinars

All routes require `ADMIN`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/webinars` | List all, with registration counts |
| `GET` | `/api/admin/webinars/:id` | Single webinar with relations |
| `POST` | `/api/admin/webinars` | Create |
| `PATCH` | `/api/admin/webinars/:id` | Update |
| `POST` | `/api/admin/webinars/:id/publish` | Set status `SCHEDULED` |
| `DELETE` | `/api/admin/webinars/:id` | Delete |
| `GET` | `/api/admin/webinars/:id/registrations` | List; `?format=csv` downloads |
| `GET` | `/api/admin/webinars/:id/analytics` | Registrations, revenue, quiz stats |

`PATCH` accepts `startedAt` (`ISO string` or `null`) alongside the usual fields. The
`webinarStart` socket event normally writes it; the field is exposed here so an admin
can reset a webinar back to its waiting state — send `{ "status": "SCHEDULED",
"startedAt": null }` — or correct a start time. A reset takes effect on the live room
immediately, not just on the next join.

### Analytics response

```json
{
  "analytics": {
    "registrations": 42,
    "paidRegistrations": 17,
    "revenuePaise": 8498300,
    "quizzes": [{ "id": "...", "question": "...", "answers": 30, "correct": 21 }]
  }
}
```

---

## Admin — quizzes, offers, courses

Require `ADMIN`, `HOST`, or `MODERATOR` (courses require `ADMIN`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/:webinarId/quizzes` | List with answer counts |
| `POST` | `/api/admin/:webinarId/quizzes` | Create |
| `PATCH` | `/api/admin/quizzes/:id` | Edit question, options, correct answer, time limit |
| `DELETE` | `/api/admin/quizzes/:id` | Delete |
| `GET` | `/api/admin/:webinarId/polls` | List with vote counts |
| `POST` | `/api/admin/:webinarId/polls` | Create |
| `PATCH` | `/api/admin/polls/:id` | Edit question, options, time limit |
| `DELETE` | `/api/admin/polls/:id` | Delete |
| `GET` | `/api/admin/:webinarId/ctas` | List with course, click count and form |
| `POST` | `/api/admin/:webinarId/ctas` | Create, optionally with a pre-payment form |
| `PATCH` | `/api/admin/ctas/:id` | Edit an offer, including its form |
| `GET` | `/api/admin/ctas/:id/clicks` | Raw click rows: who clicked, what they answered |
| `GET` | `/api/admin/ctas/:id/follow-up` | Follow-up list: contact details, form status, payment status |
| `DELETE` | `/api/admin/ctas/:id` | Delete |
| `GET` | `/api/admin/courses` | List |
| `POST` | `/api/admin/courses` | Create |
| `DELETE` | `/api/admin/courses/:id` | Delete |

### Editing a quiz or poll

`PATCH` accepts any subset of the create body. Editing **saves in place** — it never
re-launches the asset, so a host fixing a typo mid-session does not restart the clock
for everyone.

**Options are immutable once answers or votes exist.** `QuizAnswer.optionId` and
`PollVote.optionId` are plain strings with no foreign key, so replacing the option
list would orphan every stored answer and silently corrupt the results. The handler
compares the submitted list against the stored one and returns `400` when they differ
and `_count.answers > 0` (or `_count.votes > 0`):

```json
{
  "error": "This quiz already has answers, so its options can no longer be changed. Delete it and create a new one."
}
```

The question and the time limit stay editable — neither is referenced by a stored
answer.

### Offers (CTAs)

An offer is a card the host can push to the room. It carries a price and either a
course or an external URL, and it can optionally ask a short form **before**
checkout.

```jsonc
// POST /api/admin/:webinarId/ctas
{
  "title": "Full-Stack Product Engineering",
  "description": "12 weeks, live cohort, lifetime recordings.",
  "buttonText": "Enroll Now",
  "priceOverridePaise": 210000,
  "formEnabled": true,
  "formIntro": "We just need a few details to send your access.",
  "formSubmitText": "Pay now",
  "formFields": [
    { "label": "Full name", "type": "text",  "isRequired": true, "placeholder": "Asha Menon" },
    { "label": "Work email", "type": "email", "isRequired": true },
    { "label": "Company size", "type": "select",
      "options": [{ "label": "1-10" }, { "label": "11-50" }] }
  ]
}
```

`type` is one of `text | number | email | phone | textarea | select | checkbox`.
`options` is only stored for `select`; it is dropped for every other type so that
switching a field back to text does not resurrect stale choices.

Both list and create responses carry the derived fields:

```jsonc
{
  "cta": {
    "id": "cmvor…",
    "title": "Full-Stack Product Engineering",
    "priceInPaise": 210000,
    "clickCount": 1,          // distinct people who opened the card
    "form": {                 // null when formEnabled is false
      "intro": "We just need a few details…",
      "submitText": "Pay now",
      "fields": [ { "id": "cmvor…", "label": "Full name", "type": "text",
                    "isRequired": true, "placeholder": "Asha Menon",
                    "options": [], "order": 0 } ]
    }
  }
}
```

`PATCH /api/admin/ctas/:id` accepts any subset of the create body. `formFields`
is the exception: when present it **replaces** the field list wholesale, because
a partial merge of an ordered list has no sensible meaning.

`GET /api/admin/ctas/:id/clicks` returns the raw click rows — the audit trail:

```jsonc
{
  "clicks": [
    {
      "id": "cmvrk…",
      "userId": "cmvq9…",
      "name": "Asha Menon",
      "email": "asha@example.com",
      "phone": "+91 98765 43210",
      "responses": { "cmvrkim5q007grqbozv1pdi78": "Asha Menon" },
      "purchasedAt": "2026-10-28T03:42:33.579Z",   // null if they did not buy
      "createdAt": "2026-10-28T03:42:26.587Z"
    }
  ],
  "total": 1,
  "purchased": 1
}
```

### Offer follow-up

`GET /api/admin/ctas/:id/follow-up` answers a different question from `/clicks`:
not "what happened" but **"who do I call, and where did they get to"**. It joins
the click rows against payments and registrations.

**Guard: authentication only.** A co-host's JWT still says `PARTICIPANT` — their
staff rights live in `WebinarCohost`, not in the token — so a `requireRole` guard
would lock out exactly the people this list exists for. The handler does the real
check, in this order:

1. `ADMIN` → allowed.
2. The webinar's `hostId` → allowed.
3. A `WebinarModerator` row for this webinar → allowed.
4. A `WebinarCohost` row matching the caller's `userId` **or** their lowercased
   email → allowed.

Anything else is `403`.

```jsonc
{
  "offer": {
    "id": "cmvrk…",
    "title": "Full-Stack Product Engineering",
    "priceInPaise": 210000,
    "currency": "INR",
    "formEnabled": true
  },
  "fields": [
    { "id": "cmvrkim5q007grqbozv1pdi78", "label": "Full name", "type": "text" }
  ],
  "people": [
    {
      "userId": "cmvq9…",
      "name": "Passcode Tester",
      "email": "passcode-1793079434333@example.com",
      "phone": "+91 98765 43210",
      "clickedAt": "2026-10-28T03:42:26.587Z",
      "formFilled": true,
      "answeredCount": 4,
      "responses": { "cmvrkim5q007grqbozv1pdi78": "Asha Menon" },
      "paymentStatus": "PAID",          // null when they never reached checkout
      "paidAt": "2026-10-28T03:42:33.579Z",
      "amountPaise": 210000,
      "purchasedAt": "2026-10-28T03:42:33.579Z",
      "attended": true,
      "registeredAt": "2026-10-28T03:40:02.101Z"
    }
  ],
  "summary": { "clicked": 1, "formFilled": 1, "paid": 1, "pending": 0 }
}
```

Two behaviours worth knowing:

- **`paymentStatus` prefers a `PAID` attempt over a later retry.** A buyer who
  paid and then tried again must not read as "failed" because the retry came
  last.
- **`formFilled` ignores answers to fields the host has since deleted.** The
  answers themselves stay in `responses` — the host is chasing a lead, not
  auditing a schema — but a stale answer must not count as a completed form, or
  the funnel would overstate itself every time a host tidied up their questions.
  `fields` is read from the stored field rows rather than from the serialised
  form, so the labels survive the form being switched off.

`responses` is keyed by form-field id. A click is recorded the moment the card is
opened — before the form is filled — so `responses` is `{}` for anyone who opened
the offer and walked away. That is deliberate: the host's question is "how many
were interested", not "how many bought".

---

## Admin — payments and refunds

Require `ADMIN`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/payments` | List payments, newest first (max 200) |
| `POST` | `/api/admin/payments/:id/refund` | Refund a captured payment |

`GET /api/admin/payments` accepts two optional filters: `webinarId` and
`status` (`CREATED`, `PAID`, `FAILED`, `REFUNDED`). Each row carries the buyer
(`user`), the webinar it belongs to, and `kind` — `course` when the payment came
from an offer, `webinar` otherwise.

### Refund a payment

```json
{ "amountPaise": 49900 }
```

`amountPaise` is optional. Omit it for a full refund; supply a smaller figure
for a partial one. The amount must be between 1 and the original charge.

A **full** refund reverses what the payment granted: a webinar seat loses
`paid`, and a course purchase loses its `Enrollment`. A **partial** refund
leaves access intact — the buyer still has what they paid for, they just paid
less. Neither path deletes rows, because the audit trail matters more than a
tidy table.

```json
{
  "ok": true,
  "refundId": "rfnd_mock_1a2b3c4d5e6f7a8b",
  "amountPaise": 49900,
  "full": true,
  "mock": true
}
```

Only a `PAID` payment can be refunded; a second attempt returns `400`. When
Razorpay is not configured the refund is simulated and `mock` is `true`, so the
database stays consistent with what a real deployment would record.

---

## Public — calendar

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/webinars/:slug/calendar.ics` | Download an iCalendar file |

Returns `text/calendar` with `Content-Disposition: attachment`, so a plain
`<a download>` link saves the file rather than navigating away. The event
carries the title, description, join URL, and a 10-minute display alarm.

Times are emitted in UTC (`20261027T063000Z`) because that is the only form
every calendar client agrees on — Outlook, Google and Apple all localise a UTC
stamp correctly, whereas a floating local time is interpreted differently
depending on the reader's machine. Text values are escaped per RFC 5545 and
long lines are folded at 75 octets, without which some clients reject the file
outright.

---

## Public — guest join

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/webinars/:slug/guest` | Join without registering |

```json
{ "name": "Ada Lovelace" }
```

Only valid when the webinar has `requireRegistration: false`; otherwise the
route returns `400` and the client should show the registration form instead.

The server creates a throwaway `User` with a `guest-<random>@guest.local`
address and a `Registration` marked paid, then returns the same shape as
`POST /api/webinars/:slug/register` — `token`, `user`, `joinToken`,
`requiresPayment: false`. Guests are real user rows because every downstream
feature (chat authorship, quiz answers, hand raises) is keyed on a user id; the
`guest-` email prefix is what marks them for exclusion from analytics later.

### Create a quiz

```json
{
  "question": "Which component decides whether a participant may receive a stream?",
  "options": [
    { "id": "a", "text": "The browser" },
    { "id": "b", "text": "The visibility policy on the server" },
    { "id": "c", "text": "The SFU router" },
    { "id": "d", "text": "The CDN" }
  ],
  "correctOptionId": "b",
  "timeLimitSecs": 30
}
```

`correctOptionId` is stored server-side and never sent to participants while the quiz is
live.

### Create an offer

```json
{
  "title": "Enroll in Full-Stack Product Engineering",
  "description": "12-week cohort with weekly expert reviews.",
  "buttonText": "Enroll Now",
  "courseId": "cmvor...",
  "priceOverridePaise": 499900,
  "externalUrl": null
}
```

`priceOverridePaise` wins over the course price. If `externalUrl` is set, the client
opens it instead of running checkout.

---

## Staff — host join

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/webinars/:slug/host-join` | Mint a join pass for staff |

Requires a bearer token for a `HOST`, `MODERATOR` or `ADMIN` user. Returns
`{ joinToken, webinar: { slug, title, startsAt } }`.

A host is not a participant: they must not be charged, must not consume a seat,
and must not be blocked by the registration gate. Rather than special-casing the
gate, the route issues a real `Registration` with `paid: true`, so every
downstream check passes unchanged. Non-admins must actually be assigned to the
webinar — its `hostId` or one of its moderators — otherwise the route returns
`400`.

---

## Recording and replay

A recording is two independent things: a **timeline** of everything that
happened, and optionally a **media file**. The timeline is always captured; the
media is best-effort. That split is deliberate — a session with no camera still
produces a replay worth watching, because the chat, quizzes and offers are the
part people come back for.

### Admin

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/recordings?webinarId=<id>` | List recordings, newest first |
| `GET` | `/api/admin/recordings/:id` | Full detail with timeline |
| `DELETE` | `/api/admin/recordings/:id` | Delete the row and its media file |

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/webinars/:slug/recordings` | `READY` recordings for a webinar |
| `GET` | `/api/webinars/:slug/recordings/:id` | Full detail |
| `GET` | `/api/webinars/:slug/recordings/:id/media` | Stream the MP4 |
| `GET` | `/api/recordings/:id` | Full detail by id alone |
| `GET` | `/api/recordings/:id/media` | Stream the MP4 by id alone |

The by-id routes exist because a shared replay link carries only the recording
id — the recipient has no reason to know the webinar slug. Media responses
support HTTP range requests (`206` + `Content-Range`) so the browser can seek
without downloading the whole file, and the resolved path is checked against the
recordings directory before anything is read.

### Timeline format

`timeline` is an array of events, each stamped with `t` — milliseconds since the
recording started:

```json
[
  { "t": 22, "type": "system", "text": "Recording started" },
  { "t": 5506, "type": "quizStarted", "quiz": { "id": "…", "question": "…", "options": [] } },
  { "t": 11657, "type": "quizResults", "results": { "correctOptionId": "b", "distribution": {} } },
  { "t": 11657, "type": "quizClosed", "quizId": "…" },
  { "t": 15248, "type": "ctaShown", "cta": { "id": "…", "title": "…", "priceInPaise": 499900 } },
  { "t": 19690, "type": "ctaHidden" }
]
```

Other event types are `chat`, `handRaised`, `handLowered`, `peerJoined` and
`peerLeft`. Replay is therefore not video playback with overlays bolted on: it
is a clock. Advancing the clock and applying every event whose `t` has passed
reconstructs the session, which is why seeking backwards works instantly and why
a timeline-only recording is still fully navigable.

`chat` is also returned as its own array so a replay UI can render the message
list without filtering the timeline.

---

## Admin — users

### `GET /api/admin/users?role=HOST`

Requires `ADMIN`. Returns up to 200 users, optionally filtered by role. Used to populate
host and moderator pickers.

---

## Admin — custom registration fields

Requires `ADMIN | HOST | MODERATOR`. Fields are rows, not a JSON blob, so the
join form can be queried cheaply and responses can be exported per field.
Options live in their own table so they can be reordered and soft-deleted
without rewriting the parent.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/:webinarId/custom-fields` | `{ fields: CustomField[] }` |
| `POST` | `/api/admin/:webinarId/custom-fields` | 201 `{ field }` |
| `PATCH` | `/api/admin/custom-fields/:id` | `{ field }` |
| `DELETE` | `/api/admin/custom-fields/:id` | soft delete — `{ ok: true }` |
| `POST` | `/api/admin/:webinarId/custom-fields/order` | body `{ ids: string[] }` |
| `POST` | `/api/admin/:webinarId/custom-fields/bulk` | replace the whole set |
| `POST` | `/api/admin/:webinarId/custom-fields/reuse` | copy from another webinar |
| `POST` | `/api/admin/custom-fields/:id/options` | add an option |
| `PATCH` | `/api/admin/custom-field-options/:id` | rename / reorder |
| `DELETE` | `/api/admin/custom-field-options/:id` | soft delete |

`CustomFieldType` is exactly 11 values: `text`, `number`, `email`, `phone`,
`date`, `time`, `textarea`, `checkbox`, `radio`, `select`, `multi-select`.
`radio`, `select` and `multi-select` require options.

Public side: `GET /api/webinars/:slug/form` returns the fields a registrant
must fill in. Answers are posted as `customResponses` on
`POST /api/webinars/:slug/register` — **not** on the claim endpoint, because a
claim is a returning attendee, not a new registration.

---

## Admin — registration approval and invites

Requires `ADMIN | HOST | MODERATOR`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/:webinarId/registrations` | `{ registrations, counts }` |
| `PATCH` | `/api/admin/registrations/:id` | body `{ status, note? }` |
| `POST` | `/api/admin/:webinarId/registrations/approve-all` | bounded to `PENDING` |
| `GET` | `/api/admin/:webinarId/registrations/export` | CSV, custom-field columns included |
| `POST` | `/api/admin/:webinarId/invite` | body `{ emails: string[], sendEmail? }` |
| `DELETE` | `/api/admin/:webinarId/invite?email=` | sets `status: CANCELLED` |

`Registration.status` is `PENDING | APPROVED | REJECTED | WAITLISTED |
CANCELLED`. When a webinar does not require approval, a registration is created
`APPROVED` — the column is always populated, so no code branches on "approval
is off".

`counts` **omits statuses with a zero count**. Assert the absence of the key,
not `=== 0`.

Invites are validated per-entry, not per-request: a batch of 200 pasted
addresses with one typo invites the other 199 and reports the bad one. The
response is `{ invited, results: [{ email, invited, reason? }] }`.

The CSV export prefixes any cell starting with `=`, `+`, `-` or `@` with a
single quote. Excel treats those as formulas, and a name like `=cmd|...` is a
real attack vector.

---

## Admin — co-hosts

Requires `ADMIN | HOST | MODERATOR`. Max 10 per webinar.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/:webinarId/cohosts` | `{ cohosts, maxCohosts: 10 }` |
| `POST` | `/api/admin/:webinarId/cohosts` | body `{ email, name?, permissions? }` |
| `PATCH` | `/api/admin/cohosts/:id` | update name / permissions |
| `DELETE` | `/api/admin/cohosts/:id` | `{ ok: true }` |
| `GET` | `/api/admin/:webinarId/cohost-policy` | owner view |
| `GET` | `/api/admin/:webinarId/cohost-policy/me` | **auth only, no role gate** |

`cohost-policy/me` is mounted on a separate router that requires authentication
but **not** a staff role, because a co-host's JWT still says `PARTICIPANT`.
It returns `{ isOwner, isCohost?, permissions }` and applies
`cohostStartWithoutHost` to `permissions.startWebinar`.

The permission map has exactly 10 keys: `chatModeration`, `qna`, `polls`,
`usersControl`, `waitingRoom`, `startWebinar`, `endWebinar`, `screenshare`,
`liveSettings`, `handraise`. Everything defaults to `true` except
`startWebinar` and `endWebinar`.

A co-host is invited by email **before they have an account**, so every lookup
matches on `OR: [{ userId }, { email }]` and backfills `userId` on first match.

---

## Admin — stream destinations

Requires `ADMIN | HOST | MODERATOR`. Max 3, one per platform.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/:webinarId/stream-destinations` | `{ destinations, maxDestinations, editable }` |
| `POST` | `/api/admin/:webinarId/stream-destinations` | 201 `{ destination }` |
| `DELETE` | `/api/admin/stream-destinations/:id` | `{ ok: true }` |
| `GET` | `/api/admin/:webinarId/stream-destinations/ffmpeg` | `{ command, destinationCount }` |

`STREAM_PLATFORMS` is `['youtube', 'twitch', 'custom']`. A `custom` destination
requires `rtmpUrl`, and its `rtmpHost` is the **full URL**, not the hostname.

A destination is never returned with its key — only `keyHint` (last 4
characters). The one exception is the ffmpeg command, which is useless without
it and is served with `Cache-Control: no-store`.

`editable` is `false` once the webinar is `LIVE` or `ENDED`. The destination
list is fixed for the session.

---

## Admin — webinar series

Requires `ADMIN | HOST | MODERATOR`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/admin/:webinarId/series/preview` | `{ occurrences: string[], total }` — creates nothing |
| `POST` | `/api/admin/:webinarId/series` | 201 `{ series, occurrenceCount }` |
| `GET` | `/api/admin/:webinarId/series` | `{ series, occurrences }` |
| `PATCH` | `/api/admin/series/:id` | `{ series }` |
| `DELETE` | `/api/admin/series/:id` | `{ ok: true, cancelledOccurrences }` |
| `DELETE` | `/api/admin/:webinarId/series/occurrence` | detach one occurrence |

`SERIES_FREQUENCIES` are **uppercase**: `DAILY | WEEKLY | MONTHLY | YEARLY`.
Lowercase is a 400.

The base webinar becomes `occurrenceIndex: 0`; copies are created `SCHEDULED`
with their own slugs. A second `POST` is a 400 — a webinar belongs to at most
one series. Cancelling a series records `cancelledAt` and leaves the
occurrences in place; they are real webinars and may already have registrations.

The generator is a pure function so it can be previewed before it creates rows.

---

## Admin — iframe embedding

Requires `ADMIN | HOST`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/:webinarId/embed` | `{ embed, snippet }` |
| `PATCH` | `/api/admin/:webinarId/embed` | body `{ enabled, allowedOrigins }` |
| `GET` | `/api/webinars/:slug/embed-policy` | **public, unauthenticated** |

`allowedOrigins` is capped at 20 and **rejects wildcards**. `*` is the same as
no allow-list, so the schema refuses it rather than pretending to enforce
something. A bare `*`, `https://*.example.com` and a scheme-less `example.com`
are all 400.

The public policy endpoint returns only `{ embed: { enabled, allowedOrigins } }`
— no title, no slug — so a parent page can decide whether to render the iframe
before it knows anything about the webinar.

---

## Admin — analytics events

Requires `ADMIN | HOST | MODERATOR`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/:webinarId/analytics-config` | `{ config }` |
| `PATCH` | `/api/admin/:webinarId/analytics-config` | `{ config }` |
| `GET` | `/api/webinars/:slug/analytics-config` | public — what the page should fire |

`ANALYTICS_EVENTS` is `ViewContent`, `CompleteRegistration`,
`InitiateCheckout`, `Purchase`, `Join`. Providers are GA4, Meta Pixel,
Microsoft Clarity and GTM.

An analytics id is validated against its real format at save time. A typo fails
silently in the browser, and the host concludes the feature is broken.

---

## Admin — automation timeline

Requires `ADMIN | HOST | MODERATOR`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/admin/:webinarId/automation/import` | 201 `{ bundle, cues, summary }` |
| `GET` | `/api/admin/:webinarId/automation/export` | file download |
| `GET` | `/api/admin/:webinarId/automation/cues` | `{ bundle, cues }` |
| `PATCH` | `/api/admin/automation/cues/:id` | body `{ enabled?, atMs? }` |
| `POST` | `/api/admin/:webinarId/automation/reset` | `{ ok: true, reset: count }` |

The bundle is validated `.strict()` — an unknown top-level key is a 400, not a
silent no-op. `version` must be exactly `1`. A reference to an unknown persona
is reported in `details.references`.

`summary` is `{ personas, chatLines, questions, cues }`. There is no top-level
`personas` or `attendance` on the response.

A second import **replaces** rather than merges — the old cues are deleted.
Times are offsets from the start of the webinar, never wall-clock, so a bundle
is portable between events.

---

## Admin — webhooks

Requires `ADMIN | HOST`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/webhooks` | `{ endpoints }` — never the secret |
| `POST` | `/api/admin/webhooks` | 201 `{ endpoint, secret }` — secret shown once |
| `PATCH` | `/api/admin/webhooks/:id` | `{ endpoint }` |
| `DELETE` | `/api/admin/webhooks/:id` | `{ ok: true }` |
| `GET` | `/api/admin/webhooks/:id/deliveries` | last 100, newest first |
| `POST` | `/api/admin/webhooks/:id/test` | `{ ok, sent, failed }` |
| `POST` | `/api/admin/webhooks/:id/rotate` | `{ secret }` |
| `GET` | `/api/admin/webhooks/events` | the 14 event names |

`events` accepts `'*'` to subscribe to everything, including events added in a
future release. The dispatcher has always honoured the wildcard; the schema now
allows it.

Deliveries come from an outbox table, not an inline POST — a slow customer
endpoint must never block a socket handler. Payloads are signed with
HMAC-SHA256 over the raw body in `X-Webinar-Signature`.

Retry policy: a 4xx (except 429) is permanent and marks the delivery `FAILED`;
a network failure is retryable and stays `PENDING` with backoff. An inactive
endpoint marks the delivery `FAILED` with `lastError: 'Endpoint disabled'`
without incrementing `attempts`.

---

## Admin — API tokens

Requires `ADMIN | HOST`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/api-tokens` | `{ tokens }` — prefix only |
| `POST` | `/api/admin/api-tokens` | 201 `{ token, plaintext }` — shown once |
| `DELETE` | `/api/admin/api-tokens/:id` | `{ ok: true }` — sets `revokedAt` |

Tokens are stored hashed (SHA-256) and prefixed `nxl_`. The plaintext is shown
exactly once at creation. Revoking keeps the row for the audit trail.

---

## Public API — `/api/v1`

Authenticated with `Authorization: Bearer nxl_...`, **not** a JWT. Every
response uses the `{ success, data }` / `{ success: false, error, details }`
envelope.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/webinars` | `{ webinars, pagination }` |
| `GET` | `/api/v1/webinars/:id` | id **or** slug; includes `registrationCount` and `customFields` |
| `POST` | `/api/v1/webinars` | 201 `{ webinar }` — `settings` is optional |
| `PATCH` | `/api/v1/webinars/:id` | `{ webinar }` |
| `DELETE` | `/api/v1/webinars/:id` | `{ deleted: true }` |
| `GET` | `/api/v1/webinars/:id/status` | `{ id, status, startedAt, endedAt }` |
| `GET` | `/api/v1/webinars/:id/metrics` | `{ metrics }` |
| `GET` | `/api/v1/webinars/:id/registrations` | `{ registrations, pagination }` |
| `POST` | `/api/v1/webinars/:id/join-tokens` | 201 `{ token, expiresAt, maxUses, joinUrl }` |

Pagination is `?limit=&offset=`, `limit` capped at 100. `limit=500` is a 400.

`metrics` is `{ totalUsers, maxLiveUsers, durationMinutes, timeSeries,
engagement, computedAt }`. `totalUsers` counts **all** registrations, not just
attendees. The cache is only served when the webinar is `ENDED` — a `LIVE`
webinar recomputes on every call, because the numbers are still moving.

---

## Time

### `GET /api/time`

No auth. Returns `{ "now": 1792991544000 }` — used by the countdown so client clock skew
does not matter.
