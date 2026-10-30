# Architecture

> Setting the project up, configuring it, or deploying it? Start with
> [`running-the-platform.md`](running-the-platform.md). This document explains how
> the pieces fit together once it is running.

## Shape of the system

```
                    ┌──────────────────────────────┐
   browser ────────►│  Next.js (apps/web)          │
                    │  App Router, React 19        │
                    └───────────┬──────────────────┘
                                │  REST (fetch)      ┌─────────────────────┐
                                ├───────────────────►│  Express (apps/server)│
                                │  Socket.IO (ws)    │  REST + realtime      │
                                │                    └──────────┬───────────┘
                                │                               │
                                │                    ┌──────────┴──────────┐
                                │                    │  Prisma → SQLite/PG │
                                │                    └─────────────────────┘
                                │
                                ▼
                    ┌──────────────────────────────┐
                    │  mediasoup SFU               │
                    │  N workers → Routers →       │
                    │  Transports → Producers      │
                    └──────────────────────────────┘
```

The web app never talks to mediasoup directly. It exchanges SDP-shaped parameters with
the server over Socket.IO, and the server holds the only authoritative view of who may
publish and who may consume.

## Why an SFU

A mesh would have every participant upload to every other participant — O(n²) uplinks.
An SFU terminates each participant's media once and forwards selected streams, so a
participant uploads one stream regardless of audience size. The cost is that the server
decides what gets forwarded, which is exactly the property this platform needs: the
visibility policy lives in one place and cannot be bypassed by a modified client.

## Media lifecycle

### 1. Join

`join` is the only event that carries a JWT. The server:

1. Verifies the token and loads the webinar by slug.
2. **Re-scopes the role for this webinar.** A global `ADMIN` keeps admin powers; the
   webinar's `hostId` becomes `HOST`; a listed moderator becomes `MODERATOR`; everyone
   else is `PARTICIPANT`. A host of a *different* webinar is a participant here.
3. Creates a `Peer` and adds it to the `Room`.
4. Returns `rtpCapabilities` plus a `RoomSnapshot` — peers, hands, viewer count, and any
   quiz or offer already running, so a late joiner lands in the correct state.

### 2. Transports

Each peer gets a send transport and a receive transport on demand. Transports are
`WebRtcTransport`s bound to the room's router, with ICE servers from the environment
(STUN plus optional TURN).

### 3. Produce

The client calls `produce` with `kind`, `rtpParameters`, and a `source`
(`camera` | `microphone` | `screen`). The server:

1. Checks `canPublish` — staff always may; participants only when approved as speakers,
   and only for the kinds the webinar settings allow.
2. Creates the producer and records its source in `Peer.producerSources`.
3. Calls `announceProducer`, which walks every other peer and emits `newProducer` **only
   to those allowed to consume it**.

The source tag is what lets the UI distinguish a camera from a screen share, and what
lets the policy treat a presentation differently from a webcam.

### 4. Consume

`consume` re-checks `canConsume` at request time. This matters because a client can ask
for anything; the answer is computed from the viewer's role, the owner's role, the
producer's kind, and its source.

### 5. Revocation

When a moderator revokes a speaker, `revalidateVisibility` runs over that peer's
producers and closes the consumers that are no longer permitted, emitting
`producerClosed` to the affected viewers. The revoked peer also receives `handRevoked`,
which tears down their local producers and any screen share in progress.

## The visibility policy

One function, `canConsume`, in `apps/server/src/realtime/visibility.ts`. It is called
from three places — `announceProducer`, `revalidateVisibility`, and `Peer.consume` — so
there is no path that skips it. It takes a third argument, `VisibilityPolicy`, which
carries the room-level switches (`showParticipantsToEachOther`). Passing the policy in
rather than reading a global keeps the decision a pure function of its inputs.

| Viewer | Owner | Kind | Source | Allowed |
|---|---|---|---|---|
| Staff | anyone | any | any | ✅ |
| Participant | staff | any | any | ✅ |
| Participant | participant | any | any | ✅ if `showParticipantsToEachOther` |
| Participant | participant | audio | microphone | only if owner approved |
| Participant | participant | video | camera | ❌ |
| Participant | participant | video | screen | only if owner approved |

The screen-share row is deliberate: a share is a presentation meant for the room, so it
is not treated like a private webcam.

The `showParticipantsToEachOther` row is checked first, before any per-source carve-out.
A participant who could see another participant's camera but not their screen share
would be a confusing half-measure, so the setting is all-or-nothing.

A companion function, `canSeePeer`, answers the roster question — may this viewer be
told that peer exists at all. It applies the same rules, and `snapshotFor`,
`peerJoined` and `peerUpdated` all use it, so the roster and the media policy can never
disagree.

## Room state

A `Room` owns:

- `peers` — connected `Peer` objects
- `hands` — the raise-hand queue
- `activeQuiz` — the running quiz plus its correct answer and auto-close timer
- `activeCta` — the offer currently on screen

Rooms are created lazily on first join and destroyed when the last peer leaves, which
also closes the router and releases its worker slot.

## Engagement flows

**Quiz.** `quizLaunch` loads the quiz, stores the correct answer server-side, starts a
timer, and broadcasts `quizStarted` with a `PublicQuiz` that **omits the correct
answer**. Answers are graded on the server and persisted with an upsert keyed on
`(quizId, userId)`, so a participant cannot answer twice. On close (manual or timer),
`quizResults` carries the distribution and `quizClosed` clears the modal.

**Offer.** `ctaShow` resolves the CTA and its course, computes the effective price
(override, else course price), and broadcasts `ctaShown`. The client either opens an
external URL or runs checkout. In mock mode the order and verification round-trip
locally; with real keys it opens Razorpay Checkout and verifies the signature
server-side. A successful enrollment is announced in chat.

## Payments

`POST /api/payments/order` creates a `Payment` row and, when keys are configured, a
Razorpay order. `POST /api/payments/verify` checks the HMAC signature before marking the
payment captured and the registration paid. `POST /api/payments/webhook` is mounted with
a raw body parser *before* `express.json()` so the signature can be verified against the
exact bytes Razorpay sent.

## Failure modes worth knowing

- **Worker binary missing.** mediasoup installs but cannot spawn a worker. The server
  fails at startup; `fetch-mediasoup-worker.mjs` fixes it.
- **Unreachable announced IP.** ICE gathers candidates but none are reachable, so media
  never flows even though signalling succeeds. Set `MEDIASOUP_ANNOUNCED_IP` and publish
  the RTC port range.
- **Shared localStorage across tabs.** Two tabs in one browser share a token, so logging
  in as a second user ends the first session. This is intended single-session behaviour.
- **Proxy-blocked downloads.** Node's `fetch` ignores proxy variables; use `curl` for
  scripted downloads.
