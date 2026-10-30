# Socket.IO events

> For installation, configuration, and running the server, see
> [`running-the-platform.md`](running-the-platform.md).

Namespace: `/` (default). Connect with the JWT in the handshake:

```ts
const socket = io(API_URL, { auth: { token }, transports: ['websocket'] });
```

Every client→server event takes an **ack callback** as its last argument. The ack shape
is uniform:

```ts
type Ack<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { data?: undefined } : { data: T }))
  | { ok: false; error: string };
```

Always check `ok` before reading `data`. A failed ack is a normal outcome, not an
exception — permission denials arrive this way.

---

## Client → server

### `join`

```ts
socket.emit('join', { slug, token }, (res) => { /* JoinAck */ });
```

The only event that carries a token. The server verifies it, **re-scopes the role for
this webinar**, creates a peer, and returns capabilities plus a snapshot.

```ts
{
  ok: true,
  data: {
    peerId: string,
    role: 'ADMIN' | 'HOST' | 'MODERATOR' | 'PARTICIPANT',
    userId: string,
    name: string,
    rtpCapabilities: unknown,
    snapshot: RoomSnapshot
  }
}
```

Role re-scoping: a global `ADMIN` keeps admin powers; the webinar's `hostId` becomes
`HOST`; a listed moderator becomes `MODERATOR`; everyone else is `PARTICIPANT`. A host
of a different webinar is a participant here.

A **co-host** is promoted to `MODERATOR` for the session even though their JWT says
`PARTICIPANT`. The lookup matches `OR: [{ userId }, { email }]` and backfills `userId`
on first match, because a co-host is invited by email before they have an account.
Their permission map is attached to the peer and read at join time — changing a
co-host's permissions takes effect when they rejoin, not instantly.

`join` also enforces the **registration approval gate**. A registration in
`PENDING`, `REJECTED`, `CANCELLED` or `WAITLISTED` is refused, and so is an
`inviteOnly` webinar with no registration row at all. The refusal arrives as
`{ ok: false, error }`, not as a thrown exception.

`RoomSnapshot` carries `webinarId`, `slug`, `title`, `status`, `settings`, `self`,
`peers`, `viewerCount`, `hands`, `activeQuiz`, `activePoll`, `activeCta`,
`questions`, `spotlightedPeerId`, `recording`, `startedAt` and `watermark` — so a
late joiner lands in the correct state without extra round-trips.

`startedAt` is `null` until the host opens the session (see `webinarStart`). It is
explicit server state rather than something the client infers from the peer list,
because "nobody is here yet" and "the session has not begun" look identical otherwise.

`watermark` is `{ enabled, label, userId } | null`. It carries the **viewer's own**
name and id, not a generic label, so a leaked screen recording can be traced back to
the account that made it. The client renders it as an overlay that cannot be
dismissed.

`viewerCount` in the snapshot is always the real headcount. The
`showLiveUsersCount` setting gates the **broadcast**, not the value: when it is off,
`viewerCount` events go only to staff sockets. A hidden headcount must still reach
the people running the session.

`settings.showPeopleTab`, `settings.showQaTab` and `settings.showPollsTab` decide
which sidebar tabs a **participant** may open. All three default to `false`. Staff
ignore them and always get all four tabs — the roster, the question queue and the
poll list are how they run the room. The client resolves the visible tab set from
`isStaff || flag`, and falls back to Chat when the remembered tab turns out to be
hidden, so a reload can never land a participant on a blank panel.

`settings.showParticipantsToEachOther` decides whether the **audience** may see and
hear each other. It defaults to `false`. When off, `snapshot.peers` omits other
participants entirely — a participant is not told they exist — and `consume` refuses
their producers. When on, every participant appears in the roster and their media is
consumable. Staff are mutually visible either way.

Because the roster is filtered, `peerJoined` and `peerUpdated` are **not** room-wide
broadcasts: each is delivered only to the sockets allowed to see that peer. A peer
always receives its own `peerUpdated`, so its mic/camera badge stays accurate.

### `createTransport`

```ts
socket.emit('createTransport', { direction: 'send' | 'recv' }, (res) => { /* TransportParams */ });
```

Returns `{ id, iceParameters, iceCandidates, dtlsParameters, iceServers? }`.

### `connectTransport`

```ts
socket.emit('connectTransport', { transportId, dtlsParameters }, ack);
```

### `produce`

```ts
socket.emit('produce', {
  transportId,
  kind: 'audio' | 'video',
  rtpParameters,
  source: 'camera' | 'microphone' | 'screen',   // optional, defaults by kind
  appData: { kind, source },
}, (res) => { /* { producerId } */ });
```

`source` is the discriminator that lets the UI tell a webcam from a screen share and
lets the visibility policy treat a presentation differently. It defaults to
`microphone` for audio and `camera` for video when omitted.

Fails with `ok: false` when the peer is not permitted to publish that kind right now.

### `consume`

```ts
socket.emit('consume', { producerId, rtpCapabilities }, (res) => { /* ConsumerParams */ });
```

```ts
{
  id, producerId, kind, source, rtpParameters,
  peerId, userId, producerPaused
}
```

Re-checks the visibility policy at request time. A client may ask for anything; the
answer is computed from roles, kind, and source.

### `resumeConsumer`

```ts
socket.emit('resumeConsumer', { consumerId }, ack);
```

### `setPreferredLayers`

```ts
socket.emit('setPreferredLayers', { consumerId, spatialLayer }, ack);
```

Pins a video consumer to one simulcast layer (`0` lowest, `2` highest), or passes
`null` to hand control back to the SFU. Layer choice is a server-side decision in
mediasoup 3.25+ — `mediasoup-client` no longer exposes `Consumer.setPreferredLayers()`.

The room UI uses this so a 160px filmstrip thumbnail pulls layer 0 instead of 720p.
Non-video consumers are a no-op.

### `closeProducer`

```ts
socket.emit('closeProducer', { producerId }, ack);
```

Closes the producer, clears its source tag, and notifies every consumer with
`producerClosed`.

### `setProducerPaused`

```ts
socket.emit('setProducerPaused', { producerId, paused }, ack);
```

Broadcasts `producerPaused` so remote tiles can show a paused state without tearing down
the consumer.

### `chatSend`

```ts
socket.emit('chatSend', { text }, ack);
```

Rate limited. Profanity is masked in place (`shit` → `s***`) rather than rejected —
silently dropping a message looks like a bug to the sender. Broadcasts `chatMessage`
to the room.

### `chatDelete`

```ts
socket.emit('chatDelete', { id }, ack);   // staff only
```

Removes the message from the in-memory buffer, the database, and every connected
client via `chatDeleted`. System messages (`system: true`) are ephemeral and cannot
be deleted — the ack carries `System messages cannot be deleted`.

### System lines and `kind`

A `ChatMessagePayload` with `system: true` is a server-authored line. It carries an
optional `kind` so the client can style it without string-matching:

| `kind` | Meaning | Rendering |
| --- | --- | --- |
| `info` (default) | Housekeeping — recording started/stopped, webinar started, a speaker invited | Centred grey pill |
| `enrollment` | Somebody bought a seat or a course | Gold celebratory card in chat, plus a short banner over the stage |

System lines are **not persisted** — they live in the room's 200-message buffer and
vanish on reload. That is deliberate: "Recording started" is a moment, not a record.

An `enrollment` line is emitted from the payment bridge, not from a socket handler.
The buyer's name is resolved from the live peer when they are connected and from the
database when they are not, so a checkout completed on a phone after the tab was
closed still announces. See `announceEnrollment` in `apps/server/src/realtime/socket.ts`.

### Hand raise

```ts
socket.emit('handRaise', ack);
socket.emit('handLower', ack);
socket.emit('handApprove', { userId }, ack);   // staff only
socket.emit('handDeny', { userId }, ack);      // staff only
```

`handApprove` sets `isApprovedSpeaker`, revalidates visibility so the room can now
receive that peer's media, and emits `handApproved` to the approved peer.

`handDeny` clears the flag, closes the peer's producers, revalidates visibility, and
emits `handRevoked`.

`handList` is **per-recipient**: staff receive the full queue, participants receive only
their own entry.

### Quiz

```ts
socket.emit('quizLaunch', { quizId }, ack);              // staff only
socket.emit('quizAnswer', { quizId, optionId }, (res) => { /* { correct } */ });
socket.emit('quizClose', { quizId }, ack);               // staff only
```

`quizAnswer` is rate limited and rejects a second answer from the same user. Grading
happens server-side; the correct option is never sent while the quiz is live.

### Offers

```ts
socket.emit('ctaShow', { ctaId }, ack);   // staff only
socket.emit('ctaHide', ack);              // staff only — note: no payload
socket.emit('ctaClick', { ctaId, responses? }, ack);   // any peer
```

`ctaHide` takes the ack as its **only** argument. Passing a payload shifts the callback
and the ack never fires.

`ctaClick` is deliberately open to **every** peer, not just staff — the whole point
is to count the people who are not staff. The server dedupes by user, so a repeat
click is harmless and does not inflate the tally.

```ts
// ack
{ ok: true, data: { clickCount: 1 } }
```

`responses` is optional and keyed by form-field id. A **bare** click (no
`responses`) is the normal case: the card records the click the moment someone
opens it, before they have filled anything in. A bare click is therefore *not*
validated against the form's required fields — validating it would reject the
very click the host is counting. Only a submission that actually carries answers
is held to the form's rules, and a rejection comes back as
`{ ok: false, error: "Full name is required" }`.

A bare click also never wipes answers submitted earlier: `responsesJson` is only
overwritten when the caller sent something.

### Moderation

```ts
socket.emit('modMute', { userId }, ack);   // staff only
socket.emit('modKick', { userId }, ack);   // staff only
```

`modMute` pauses the target's audio producers and notifies them. `modKick` removes them
from the room and emits `kicked`.

### Co-host permissions

A co-host is a `MODERATOR` with a permission map. Every staff action is gated twice:
first by role, then by permission. The map has exactly 10 keys:

| Permission | Gates |
|---|---|
| `chatModeration` | `chatDelete` |
| `qna` | `qaPin`, `qaDelete` |
| `polls` | `quizLaunch`, `quizClose`, `pollLaunch` |
| `usersControl` | `spotlight`, `muteAll`, `modMute`, `modKick`, `mediaRequest` |
| `waitingRoom` | admitting a waiting participant |
| `startWebinar` | `webinarStart` |
| `endWebinar` | `webinarEnd` |
| `screenshare` | publishing a screen share |
| `liveSettings` | changing settings mid-session |
| `handraise` | clearing the hand queue |

`startWebinar` and `endWebinar` default to `false`; everything else defaults to
`true`. The map is merged over the default at read time, so a permission added in a
later release is automatically granted and old rows do not read as `undefined`.

A non-co-host's map is `null`, not "all false" — `null` means "not a co-host", which
is a different thing from "a co-host with nothing allowed".

A denial arrives as `{ ok: false, error: 'Not allowed' }`. It is a normal ack, not an
exception.

### `requestSnapshot`

```ts
socket.emit('requestSnapshot', (res) => { /* RoomSnapshot */ });
```

### `webinarStart`

```ts
socket.emit('webinarStart', (res) => { /* { ok, data: { startedAt } } */ });
```

Host or admin only — a moderator can run the room once it is open, but deciding when
the audience is let in is not theirs to make. **Unless the owner granted it.** A
co-host carries a permission map; if `startWebinar` is `true` (or the webinar has
`cohostStartWithoutHost` set), they may start the session too. A plain moderator
carries no permission map, so `can()` is `false` for them and the role gate still
holds.

The gate is `isOwner || can('startWebinar')`, not `isOwner` followed by
`can('startWebinar')`. A role check that runs *before* a permission check makes the
permission unreachable — which is exactly the bug that made
`cohostStartWithoutHost` decorative for two releases.

Participants are allowed to join before this is called. They sit in a waiting room
(the client shows `WaitingRoom` while `RoomSnapshot.startedAt` is `null`) with a live
roster and working chat, but no stage. Starting is an explicit act so the host can get
their camera and slides ready without an audience watching them fumble.

The call is **idempotent**: a double-click, or a second host arriving late, returns the
existing `startedAt` and does not re-fire `webinarStarted` — otherwise the waiting
screen would flash back over a session that is already running.

Starting persists `status: 'LIVE'` and `startedAt` on the webinar row, so a participant
who reloads an hour later still finds the session open rather than back in the waiting
room. A webinar already `LIVE` in the database is treated as started on room creation,
which covers rows written before the column existed and rooms rebuilt after the last
peer left.

### `webinarEnd`

```ts
socket.emit('webinarEnd', ack);   // host, admin, or a co-host with endWebinar
```

Sets the webinar's status to `ENDED`, tears down the room, and emits `webinarEnded`
to everyone. The ack is the only argument — like `ctaHide`, passing a payload shifts
the callback and the ack never fires.

Same permission shape as `webinarStart`: `isOwner || can('endWebinar')`.

Ending a session also stops any recording in flight, so the row never stays stuck in
`RECORDING` and the replay becomes available immediately.

### Recording

```ts
socket.emit('recordingStart', (res) => { /* { ok, data: { recordingId } } */ });
socket.emit('recordingStop',  (res) => { /* { ok, data: { recordingId, durationMs } } */ });
```

Host or admin only — a moderator can run the room but not archive it. Both take the
ack as their only argument. The server broadcasts `recordingState` rather than trusting
the caller, so two hosts in the same room stay in sync and a reconnect picks up the
real state from `RoomSnapshot.recording`.

Starting a recording captures the timeline unconditionally and attaches the host's
video producer to FFmpeg on a best-effort basis. If there is no host video — no camera,
or the host has not published yet — the recording is still created and marked
`mediaKind: "none"`. A failed media pipeline must never cost you the chat log.

---

## Server → client

### Presence

| Event | Payload |
|---|---|
| `peerJoined` | `PeerInfo` |
| `peerLeft` | `{ peerId, userId }` |
| `peerUpdated` | `PeerInfo` |

`PeerInfo` is `{ peerId, userId, name, role, isApprovedSpeaker, producers: [{ producerId, kind, source }] }`.

### Media

| Event | Payload |
|---|---|
| `newProducer` | `{ peerId, userId, producerId, kind, source }` |
| `producerClosed` | `{ peerId, producerId }` |
| `producerPaused` | `{ producerId, paused }` |

`newProducer` is emitted **only to peers allowed to consume that producer**. Receiving it
is the client's cue to call `consume`.

### Chat

| Event | Payload |
|---|---|
| `chatMessage` | `ChatMessagePayload` |
| `chatDeleted` | `{ id }` |

### Hands

| Event | Payload |
|---|---|
| `handList` | `HandRaiseEntry[]` — full queue for staff, own entry for participants |
| `handApproved` | `{ canPublishAudio, canPublishVideo }` |
| `handRevoked` | *(none)* |

On `handRevoked` the client must stop publishing: close producers, stop local tracks, and
stop any screen share in progress.

### Quiz

| Event | Payload |
|---|---|
| `quizStarted` | `PublicQuiz` — `{ id, question, options, timeLimitSecs }`, no correct answer |
| `quizResults` | `QuizResults` — `{ quizId, question, correctOptionId, distribution, totalAnswers, correctCount, topScorers }` |
| `quizClosed` | `{ quizId }` |

`topScorers` is the leaderboard: the five fastest *correct* answers, best first, as
`{ userId, name, elapsedMs }`. Everyone who answered correctly scores the same, so elapsed
time is the only meaningful tie-breaker — it rewards knowing the answer over guessing after
the discussion. `elapsedMs` is measured from the moment the quiz opened.

### Offers

| Event | Payload |
|---|---|
| `ctaShown` | `CtaPayload` — `{ id, title, description, buttonText, priceInPaise, currency, externalUrl, clickCount, clickedByMe, form }` |
| `ctaHidden` | *(none)* |
| `ctaClicks` | `{ ctaId, clickCount }` — **staff only** |

`form` is `null` when the offer has no pre-payment form, in which case the button
goes straight to checkout. When present it is
`{ intro, submitText, fields: [{ id, label, type, isRequired, placeholder, options, order }] }`.

`ctaClicks` goes to staff only. A participant seeing "37 people clicked" is social
proof the host never asked for, and it would leak the offer's conversion rate to
the whole room. The same reasoning applies to `clickCount` on `ctaShown`: it is
sent to everyone because the payload is shared, but the client only renders it in
the host panel.

### Room

| Event | Payload |
|---|---|
| `viewerCount` | `number` |
| `enrolledUpdated` | `{ userId, enrolled }` |
| `webinarStarted` | `{ startedAt }` — the host opened the session; the waiting room drops straight in |
| `webinarEnded` | *(none)* |
| `kicked` | `{ reason }` |
| `errorMessage` | `{ message }` |
| `recordingState` | `{ recording: boolean, startedAt?: number }` |

`recordingState` is the single source of truth for the REC badge and the host's
start/stop button. `startedAt` is a `Date.now()` stamp, present only when recording
begins.

---

## A minimal working sequence

```ts
const socket = io(API, { auth: { token }, transports: ['websocket'] });

socket.on('newProducer', ({ producerId }) => {
  socket.emit('consume', { producerId, rtpCapabilities }, async (res) => {
    if (!res.ok) return;
    const consumer = await recvTransport.consume(res.data);
    attachToVideoElement(consumer.track, res.data.source);
  });
});

socket.emit('join', { slug, token }, async (res) => {
  if (!res.ok) return;
  const device = new Device();
  await device.load({ routerRtpCapabilities: res.data.rtpCapabilities });

  const send = await createTransport('send');
  const recv = await createTransport('recv');

  // Publish a screen share.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  const producer = await send.produce({
    track: stream.getVideoTracks()[0],
    appData: { kind: 'video', source: 'screen' },
  });
});
```
