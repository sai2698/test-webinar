# Webinar Platform (SFU + Razorpay) – Complete Technical Build Guide

A step-by-step blueprint for building a MiroTalk-SFU-style webinar platform with admin-controlled webinars, role-based video visibility, Razorpay payments, countdown registration pages, chat, hand raise, quizzes, and course-enrollment CTAs. Written so each section can be pasted into an AI coding assistant (Claude Code, Cursor, etc.) as an implementation task.

## 1. Product Summary

**What you are building:** a webinar system (like Webinar.gg / Zoom Webinars) where one or a few people broadcast and many people watch, with limited interaction.

**Core rules**

- Admin creates webinars and decides per-webinar: mic allowed, camera allowed, registration required, payment required (Razorpay).
- Four roles: **Admin, Host, Moderator, Participant**.
- **Participants see only Host and Moderator video/audio.** They never receive other participants' streams.
- **Admin sees everyone's video.** Moderators can see raised-hand participants and promote them to speak.
- Chat, hand raise, quiz (live polls with correct answers), CTA popups for course enrollment (with payment).
- If a participant has paid/enrolled, their name shows an **"Enrolled"** badge in chat.
- Registration page with a polished countdown to the start time.

**Important design principle:** hiding video in the UI is NOT enough. The SFU server must simply never send other participants' media to a participant. This is both a privacy guarantee and a bandwidth saver.

## 2. Technology Stack

| Layer | Choice | Why |
| --- | --- | --- |
| SFU | **mediasoup v3** (Node.js) | Same engine family MiroTalk SFU uses; programmable per-consumer control |
| Signaling | **Socket.IO** | Simple rooms, acks, reconnects |
| Backend API | **Node.js + Express + TypeScript** | One language across stack |
| DB | **PostgreSQL + Prisma ORM** | Relational data: users, webinars, payments, quizzes |
| Cache / pub-sub | **Redis** | Socket.IO adapter, rate limits, live state (hand raises, viewer counts) |
| Frontend | **Next.js (React) + Tailwind CSS** | SSR for registration/countdown pages (SEO, sharing), SPA for the room |
| Payments | **Razorpay** (Orders API + Checkout.js + Webhooks) | Indian gateway, UPI/cards/netbanking |
| Auth | JWT (httpOnly cookies) + OTP/email magic link for participants | Low-friction joining |
| Email/WhatsApp | Resend/SES + optional WhatsApp API | Confirmation + reminders |
| TURN | **coturn** | Needed for users behind strict NAT |
| Deploy | Docker Compose, Nginx, Ubuntu VPS with public IP | mediasoup needs UDP port range |
| Recording (optional, later) | mediasoup PlainTransport + FFmpeg | Phase 2 |

**Scale note:** one mediasoup worker per CPU core; one Router per webinar. A single 8-core server comfortably handles a few hundred viewers **because participants only consume 2 streams (host + moderator)**. For thousands of viewers, add HLS fallback (FFmpeg → HLS) in Phase 3.

## 3. High-Level Architecture

1. **Next.js web app** – public pages (landing, registration, countdown, payment), admin dashboard, live room.
2. **API server (Express)** – REST: auth, webinars CRUD, registration, Razorpay orders/webhooks, quizzes, CTAs.
3. **Realtime server (Socket.IO + mediasoup)** – signaling, chat, hand raise, quiz events, SFU media routing. Can live in the same Node process initially, split later.
4. **PostgreSQL / Redis** – persistence and ephemeral state.
5. **coturn** – TURN/STUN.

**Media flow:** every publisher (Host, Moderator, or a promoted participant) sends 1 audio + 1 video producer to the SFU. Each viewer opens a receive transport and consumes only the producers they are *allowed* to see (decided server-side by role).

## 4. Role & Permission Matrix

| Capability | Admin | Host | Moderator | Participant |
| --- | --- | --- | --- | --- |
| Create/edit webinars | Yes | No | No | No |
| Publish audio/video | Yes | Yes | Yes | Only if webinar allows AND promoted |
| See Host video | Yes | Yes | Yes | Yes |
| See Moderator video | Yes | Yes | Yes | Yes |
| See other participants' video | **Yes** | Yes | Yes | **No** |
| Hear participants (when promoted to speak) | Yes | Yes | Yes | **Yes, only the currently approved speaker** |
| Chat | Yes | Yes | Yes | Yes (if enabled) |
| Raise hand | n/a | n/a | n/a | Yes |
| Approve hand / mute / kick | Yes | Yes | Yes | No |
| Launch quiz / CTA | Yes | Yes | Yes | No |
| Answer quiz / click CTA | No | No | No | Yes |

You can make Host and Admin the same person, but keep roles separate in the data model.

## 5. Recommended Folder Structure (Monorepo)

```
webinar-platform/
├── docker-compose.yml
├── .env.example
├── README.md
├── docs/
│   ├── architecture.md
│   ├── api.md
│   └── socket-events.md
├── infra/
│   ├── nginx/default.conf
│   └── coturn/turnserver.conf
├── apps/
│   ├── web/                         # Next.js frontend
│   │   ├── app/
│   │   │   ├── (public)/
│   │   │   │   ├── page.tsx                    # landing / list
│   │   │   │   ├── w/[slug]/page.tsx           # webinar page + countdown + register
│   │   │   │   ├── w/[slug]/pay/page.tsx       # Razorpay checkout
│   │   │   │   └── w/[slug]/thanks/page.tsx
│   │   │   ├── room/[slug]/page.tsx            # live room (all roles)
│   │   │   ├── admin/
│   │   │   │   ├── login/page.tsx
│   │   │   │   ├── page.tsx                    # dashboard
│   │   │   │   ├── webinars/new/page.tsx       # create webinar
│   │   │   │   ├── webinars/[id]/edit/page.tsx
│   │   │   │   ├── webinars/[id]/quizzes/page.tsx
│   │   │   │   ├── webinars/[id]/ctas/page.tsx
│   │   │   │   └── webinars/[id]/registrations/page.tsx
│   │   ├── components/
│   │   │   ├── countdown/Countdown.tsx
│   │   │   ├── room/{VideoGrid,HostStage,ChatPanel,HandRaiseButton,QuizModal,CtaOverlay,ControlsBar,ParticipantList}.tsx
│   │   │   └── admin/WebinarForm.tsx
│   │   ├── hooks/{useSocket,useMediasoup,useWebinar}.ts
│   │   ├── lib/{api.ts,mediasoupClient.ts,razorpay.ts}
│   │   └── store/roomStore.ts            # zustand
│   └── server/
│       ├── src/
│       │   ├── index.ts
│       │   ├── config/{env.ts,mediasoup.ts}
│       │   ├── db/prisma.ts
│       │   ├── middleware/{auth.ts,rbac.ts,rateLimit.ts,validate.ts}
│       │   ├── modules/
│       │   │   ├── auth/{routes.ts,service.ts}
│       │   │   ├── webinars/{routes.ts,service.ts,schema.ts}
│       │   │   ├── registrations/{routes.ts,service.ts}
│       │   │   ├── payments/{routes.ts,razorpay.service.ts,webhook.ts}
│       │   │   ├── quizzes/{routes.ts,service.ts}
│       │   │   ├── ctas/{routes.ts,service.ts}
│       │   │   └── notifications/{email.ts,scheduler.ts}
│       │   ├── realtime/
│       │   │   ├── socket.ts                 # auth + namespace
│       │   │   ├── rooms/RoomManager.ts      # one Room per webinar
│       │   │   ├── rooms/Room.ts             # router, peers, producers
│       │   │   ├── rooms/Peer.ts
│       │   │   ├── handlers/{media,chat,hand,quiz,cta,moderation}.ts
│       │   │   └── visibility.ts             # WHO MAY CONSUME WHOM
│       │   └── utils/{logger.ts,slug.ts}
│       ├── prisma/schema.prisma
│       └── package.json
└── packages/
    └── shared/                           # shared TS types
        └── src/{roles.ts,events.ts,webinarSettings.ts}
```

## 6. Database Schema (Prisma)

```prisma
enum Role { ADMIN HOST MODERATOR PARTICIPANT }
enum PaymentStatus { CREATED PAID FAILED REFUNDED }
enum WebinarStatus { DRAFT SCHEDULED LIVE ENDED }

model User {
  id         String   @id @default(cuid())
  name       String
  email      String   @unique
  phone      String?
  role       Role     @default(PARTICIPANT)
  passwordHash String?
  createdAt  DateTime @default(now())
  registrations Registration[]
}

model Webinar {
  id            String   @id @default(cuid())
  slug          String   @unique
  title         String
  description   String
  bannerUrl     String?
  startsAt      DateTime
  durationMins  Int
  timezone      String   @default("Asia/Kolkata")
  status        WebinarStatus @default(DRAFT)
  // admin-chosen options
  allowMic            Boolean @default(false)
  allowVideo          Boolean @default(false)
  requireRegistration Boolean @default(true)
  requirePayment      Boolean @default(false)
  priceInPaise        Int     @default(0)
  currency            String  @default("INR")
  chatEnabled         Boolean @default(true)
  handRaiseEnabled    Boolean @default(true)
  maxParticipants     Int?
  hostId        String
  createdById   String
  registrations Registration[]
  moderators    WebinarModerator[]
  quizzes       Quiz[]
  ctas          Cta[]
  messages      ChatMessage[]
}

model WebinarModerator {
  webinarId String
  userId    String
  @@id([webinarId, userId])
}

model Registration {
  id         String   @id @default(cuid())
  webinarId  String
  userId     String
  joinToken  String   @unique        // unique magic join link
  paid       Boolean  @default(false)
  attended   Boolean  @default(false)
  createdAt  DateTime @default(now())
  @@unique([webinarId, userId])
}

model Payment {
  id                 String   @id @default(cuid())
  userId             String
  webinarId          String?
  ctaId              String?          // course enrollment payments
  courseId           String?
  razorpayOrderId    String   @unique
  razorpayPaymentId  String?
  razorpaySignature  String?
  amountPaise        Int
  status             PaymentStatus @default(CREATED)
  createdAt          DateTime @default(now())
}

model Course {
  id String @id @default(cuid())
  title String
  pricePaise Int
  description String?
  enrollments Enrollment[]
}

model Enrollment {            // powers the "Enrolled" badge
  id String @id @default(cuid())
  userId String
  courseId String
  webinarId String?
  paymentId String
  @@unique([userId, courseId])
}

model Quiz {
  id String @id @default(cuid())
  webinarId String
  question String
  options Json              // [{id:"a", text:".."}]
  correctOptionId String?
  timeLimitSecs Int @default(30)
  answers QuizAnswer[]
}

model QuizAnswer {
  id String @id @default(cuid())
  quizId String
  userId String
  optionId String
  isCorrect Boolean
  @@unique([quizId, userId])
}

model Cta {
  id String @id @default(cuid())
  webinarId String
  courseId String?
  title String
  description String?
  buttonText String @default("Enroll Now")
  priceOverridePaise Int?
  externalUrl String?
}

model ChatMessage {
  id String @id @default(cuid())
  webinarId String
  userId String
  text String
  createdAt DateTime @default(now())
}
```

## 7. Admin: Create Webinar Page

Form fields (single `WebinarForm.tsx`, validated with Zod on both client and server):

- Title, description, banner image upload, slug (auto-generated, editable)
- Date/time + timezone, duration
- Host (select user), Moderators (multi-select)
- Toggles: **Allow participant mic**, **Allow participant video**, **Require registration**, **Require payment** (shows price field in INR), Chat enabled, Hand raise enabled
- Max participants
- Buttons: Save draft, Publish (status → SCHEDULED)

**Shared settings type** (`packages/shared/src/webinarSettings.ts`):

```ts
export interface WebinarSettings {
  allowMic: boolean; allowVideo: boolean;
  requireRegistration: boolean; requirePayment: boolean;
  priceInPaise: number; chatEnabled: boolean; handRaiseEnabled: boolean;
}
```

**Semantics:** `allowMic/allowVideo` do NOT mean everyone publishes. They mean a participant is *eligible* to publish when a moderator approves their raised hand. The server checks these flags again when a participant asks to produce.

REST endpoints (all `ADMIN` only): `POST /api/webinars`, `PATCH /api/webinars/:id`, `GET /api/webinars`, `DELETE /api/webinars/:id`, `POST /api/webinars/:id/publish`.

## 8. Registration + Countdown Page

Route: `/w/[slug]` (server-rendered with Open Graph tags for sharing).

**Layout**

- Hero: banner, title, host photo, date/time shown in the *viewer's* local timezone.
- **Countdown component**: big animated digits (Days : Hours : Minutes : Seconds) computed from `startsAt` minus *server time offset* (fetch `/api/time` once to avoid wrong client clocks).
- Registration form: name, email, phone → submit.
- If `requirePayment`: after the form, open Razorpay checkout. Registration is confirmed only after payment verification.
- After success: thank-you page with "Add to Calendar" (.ics) and the unique join link.
- When countdown hits zero (or 10 minutes before): button changes to **"Join Webinar"** and links to `/room/[slug]?token=<joinToken>`.

```tsx
// Countdown.tsx (core logic)
const [left, setLeft] = useState(target - Date.now() - offset);
useEffect(() => {
  const t = setInterval(() => setLeft(target - (Date.now() + offset)), 1000);
  return () => clearInterval(t);
}, []);
const d = Math.floor(left / 864e5), h = Math.floor(left % 864e5 / 36e5),
      m = Math.floor(left % 36e5 / 6e4), s = Math.floor(left % 6e4 / 1e3);
```

**Reminders:** a cron job (node-cron or BullMQ) sends emails 24h, 1h, and 10 min before start with the join link.

**If registration is not required:** the page shows only name entry and a Join button; the server issues a temporary guest token.

## 9. Razorpay Payment Integration

**Flow (works for webinar fee AND course-enrollment CTAs)**

1. Client calls `POST /api/payments/order` with `{ webinarId }` or `{ ctaId }`.
2. Server reads the price **from the database** (never trust the client), creates a Razorpay order, saves a `Payment` row with status CREATED.
3. Client opens Razorpay Checkout with the returned `orderId` and public key.
4. On success, Razorpay returns `payment_id` and `signature` to the client; client posts to `POST /api/payments/verify`.
5. Server verifies the signature, marks PAID, creates Registration or Enrollment.
6. **Webhook** (`payment.captured`) is the source of truth if the user closes the tab before verify. Make the handler idempotent.

```ts
// razorpay.service.ts
import Razorpay from 'razorpay';
import crypto from 'crypto';
const rzp = new Razorpay({ key_id: env.RZP_KEY_ID, key_secret: env.RZP_KEY_SECRET });

export async function createOrder(amountPaise: number, receipt: string) {
  return rzp.orders.create({ amount: amountPaise, currency: 'INR', receipt });
}

export function verifySignature(orderId: string, paymentId: string, sig: string) {
  const expected = crypto.createHmac('sha256', env.RZP_KEY_SECRET)
    .update(`${orderId}|${paymentId}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// webhook.ts  (use express.raw({type:'application/json'}) for this route only)
export function verifyWebhook(rawBody: Buffer, header: string) {
  const expected = crypto.createHmac('sha256', env.RZP_WEBHOOK_SECRET)
    .update(rawBody).digest('hex');
  return expected === header;   // header = X-Razorpay-Signature
}
```

```ts
// client: lib/razorpay.ts
export function openCheckout(o: {orderId:string; amount:number; name:string; email:string}) {
  return new Promise((resolve, reject) => {
    const rz = new (window as any).Razorpay({
      key: process.env.NEXT_PUBLIC_RZP_KEY_ID,
      order_id: o.orderId, amount: o.amount, currency: 'INR',
      name: 'Your Brand', prefill: { name: o.name, email: o.email },
      handler: resolve,
      modal: { ondismiss: () => reject(new Error('dismissed')) },
    });
    rz.open();
  });
}
```

Load `https://checkout.razorpay.com/v1/checkout.js` with `next/script`.

**Env vars:** `RZP_KEY_ID`, `RZP_KEY_SECRET`, `RZP_WEBHOOK_SECRET`, `NEXT_PUBLIC_RZP_KEY_ID`.

**Rules:** amounts in paise; store every order; webhook idempotency via unique `razorpayPaymentId`; support refunds from admin; add GST invoice fields later if needed. Test in Razorpay test mode first.

## 10. SFU Design with mediasoup

**Objects**

- `Worker` (one per CPU core) → `Router` (one per webinar, created when the first publisher joins) → per-peer `WebRtcTransport` (one send, one recv) → `Producer` / `Consumer`.

**mediasoup config highlights** (`config/mediasoup.ts`)

```ts
export const mediasoupConfig = {
  worker: { rtcMinPort: 40000, rtcMaxPort: 49999, logLevel: 'warn' },
  router: { mediaCodecs: [
    { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
    { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
      parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f' } },
  ]},
  webRtcTransport: {
    listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.PUBLIC_IP }],
    enableUdp: true, enableTcp: true, preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  },
};
```

**Publishing:** Host, Moderators, Admin (and promoted participants) use simulcast (3 layers) so viewers on poor networks get a lower layer automatically.

### 10.1 The visibility rule (most important file: `visibility.ts`)

```ts
export function canConsume(viewer: Peer, producerOwner: Peer): boolean {
  if (viewer.role === 'ADMIN') return true;                       // sees all
  if (['HOST','MODERATOR'].includes(viewer.role)) return true;    // staff see all
  // participants:
  if (['HOST','MODERATOR','ADMIN'].includes(producerOwner.role)) return true;
  if (producerOwner.isApprovedSpeaker) return producerOwner.mediaKind === 'audio'
      || false;   // hear the approved speaker, never see participant video
  return false;
}
```

**Where to call it**

1. When a viewer joins: loop over existing producers → create consumers only if `canConsume` is true.
2. On `newProducer`: notify only peers for whom `canConsume` is true.
3. On the `consume` request: re-check `canConsume` server-side and reject otherwise (never trust the client).
4. On role change (hand approved/revoked): re-evaluate and add/close consumers.

Only **audio** of an approved participant speaker is delivered to other participants; their video goes only to Admin/Host/Moderator. If you want participants to also see the approved speaker, flip that one line.

### 10.2 Signaling events (Socket.IO)

| Client → Server | Purpose |
| --- | --- |
| `join` {slug, token} | Auth, create Peer, return role + settings + router RTP capabilities |
| `createTransport` {direction} | Return transport params |
| `connectTransport` {transportId, dtlsParameters} | Finish DTLS |
| `produce` {kind, rtpParameters, appData} | Staff, or approved participant only |
| `consume` {producerId, rtpCapabilities} | Policy-checked |
| `resumeConsumer` {consumerId} | Start playback |
| `chat:send` {text} | Broadcast with enrolled flag |
| `hand:raise` / `hand:lower` | Participant |
| `hand:approve` {userId} / `hand:deny` | Staff |
| `quiz:launch` {quizId} / `quiz:answer` {quizId, optionId} / `quiz:close` | Staff / participant |
| `cta:show` {ctaId} / `cta:hide` | Staff |
| `mod:mute` / `mod:kick` | Staff |

| Server → Client | Purpose |
| --- | --- |
| `newProducer`, `producerClosed` | Only to allowed viewers |
| `chat:message` | `{ name, text, role, enrolled, ts }` |
| `hand:list` | Updated queue (staff only) |
| `hand:approved` | To that participant: you may publish |
| `quiz:started`, `quiz:results` | Questions (without correct answer) / leaderboard |
| `cta:shown` | Overlay payload |
| `viewerCount` | Periodic |
| `webinar:ended` | Redirect |

**Socket auth:** verify the JWT or `joinToken` in the Socket.IO handshake; reject if the webinar requires payment and `registration.paid` is false.

## 11. Live Room UI

**Participant view:** a large stage showing Host (and Moderator if present, picture-in-picture or side by side), chat panel, "Raise Hand" button, quiz modal, CTA overlay banner. No participant tiles at all.

**Admin view:** stage plus a scrollable grid of all participants who have video on (lazy-load tiles visible on screen only; subscribe to lower simulcast layers for thumbnails using `consumer.setPreferredLayers`). Side panels: participants list, raised-hand queue, quiz controls, CTA controls.

**Moderator view:** like Admin minus webinar settings.

**Control bar:** mic, camera (only enabled for those allowed), leave, fullscreen, settings, device selection.

Use `mediasoup-client` in `useMediasoup.ts`: load Device with router RTP capabilities, create send/recv transports, wire `produce` and `connect` events to socket calls.

## 12. Chat, Hand Raise, Quiz, CTA, Enrolled Badge

**Chat:** persist to DB (batched), keep last 200 in Redis for late joiners. Rate-limit (e.g. 1 msg/sec/user), profanity filter, moderator delete. Server attaches `enrolled` by checking an in-memory set loaded from `Enrollment` at join and updated instantly when a payment webhook succeeds. UI shows a green **"Enrolled"** badge next to the name. Optionally broadcast a system message: "Rahul just enrolled in the course!"

**Hand raise:** participant emits `hand:raise`; Redis sorted set `hands:{webinarId}` by timestamp; staff gets `hand:list`. On approve, server sets `isApprovedSpeaker` (only if `allowMic`), sends `hand:approved`; client then produces audio (and video if `allowVideo`). On lower/revoke, server closes that peer's producers.

**Quiz:** staff pre-create quizzes in admin; during webinar click Launch. Server sends the question without `correctOptionId`, starts a timer, accepts one answer per user, then emits `quiz:results` (distribution chart, correct answer, top scorers). Save answers for post-webinar analytics.

**Course enrollment CTA:** staff clicks Show CTA → overlay card with title, price, button. Button calls the same Razorpay order flow (`ctaId`) without leaving the room (checkout popup). On success: create Enrollment, add to the enrolled set, push badge update through the room, send a confirmation email.

## 13. REST API Overview

| Method | Path | Notes |
| --- | --- | --- |
| POST | /api/auth/login | Admin/staff |
| GET | /api/time | Server time for countdown |
| GET | /api/webinars/:slug/public | Public landing data |
| POST | /api/webinars/:slug/register | Create user + registration |
| POST | /api/payments/order | Razorpay order |
| POST | /api/payments/verify | Signature check |
| POST | /api/payments/webhook | Raw body |
| CRUD | /api/admin/webinars, /quizzes, /ctas, /courses | ADMIN only |
| GET | /api/admin/webinars/:id/registrations | Export CSV |
| GET | /api/admin/webinars/:id/analytics | Attendance, quiz stats, revenue |

## 14. Security Checklist

- Role checks on every REST route and every socket event (RBAC middleware).
- Server-side visibility enforcement in the SFU (section 10.1).
- Prices only from DB; verify Razorpay signature and webhook.
- Join links signed and single-user; block token sharing by allowing one active socket per token.
- Rate limiting and input validation (Zod); helmet; CORS allow-list.
- HTTPS everywhere (WebRTC requires it).
- Do not leak `correctOptionId` before the quiz closes.
- Secrets in environment variables, never in the repo.

## 15. Deployment

**Server requirements:** Ubuntu VPS with a public IP, 4+ cores, open ports: 80/443 (TCP), 40000-49999 (UDP/TCP for mediasoup), 3478 + 49152-65535 UDP (coturn).

`docker-compose.yml` services: `web`, `server`, `postgres`, `redis`, `coturn`, `nginx`. Run mediasoup with `network_mode: host` (simplest) or map the UDP range explicitly. Set `PUBLIC_IP` correctly or media will not connect.

Nginx proxies `/` to Next.js, `/api` and `/socket.io` to the server (enable WebSocket upgrade). Use Let's Encrypt via certbot.

## 16. Reference Platforms

**MiroTalk SFU** (github.com/miroslavpejic85/mirotalksfu): study its mediasoup room/peer structure, `RoomClient.js`, and signaling flow. It is AGPL-licensed, so if you copy code your project must also be AGPL; safest is to learn the architecture and write your own implementation.

**Webinar.gg-style features worth adding after the MVP:** evergreen/automated webinars (pre-recorded played as live), replay page, polls, offers with timers, attendee analytics, email/WhatsApp reminder sequences, custom registration page themes, "live viewer count" social proof, and automated follow-up emails by attendance. Review their registration funnel and room layout and replicate the *experience*, not the branding.

## 17. Phased Build Plan with LLM Prompts

Work one phase at a time. Commit after each. Give the AI the relevant section of this document plus the schema.

**Phase 1: Foundation**

1. "Create the monorepo structure from section 5 with pnpm workspaces, TypeScript, ESLint, Docker Compose for Postgres and Redis."
2. "Implement the Prisma schema from section 6 and seed an admin user."
3. "Build JWT auth with RBAC middleware."

**Phase 2: Admin and public pages** 4. "Build webinar CRUD API and the admin WebinarForm with all toggles in section 7." 5. "Build the public webinar page with SSR, server-time-synced Countdown, and registration form (section 8)."

**Phase 3: Payments** 6. "Implement Razorpay order, verify, and webhook per section 9, with idempotency and tests using test keys." 7. "Integrate checkout into the registration flow and issue join tokens after payment."

**Phase 4: SFU core** 8. "Implement RoomManager, Room, Peer with mediasoup workers and routers (section 10)." 9. "Implement transports, produce, consume with the `canConsume` policy and simulcast." 10. "Build `useMediasoup` hook and a minimal room page where Host publishes and Participant views only Host/Moderator." 11. "Add Admin view that consumes all participants with lazy thumbnails."

**Phase 5: Interaction** 12. "Add chat with persistence, rate limits and enrolled badge." 13. "Add hand raise queue and approve flow gated by allowMic/allowVideo." 14. "Add quiz engine and results screen." 15. "Add CTA overlay with in-room Razorpay purchase and Enrollment creation."

**Phase 6: Polish and launch** 16. Email reminders, analytics dashboard, error handling, reconnect logic, load testing (k6 + headless Chrome bots), HTTPS/TURN verification, deployment.

**Prompting tips:** ask the AI to write tests for visibility rules first; paste exact event names from section 10.2 to keep client/server in sync; keep shared types in `packages/shared`; ask for one module per prompt rather than the whole app.

## 18. Testing Checklist

- Participant devtools shows **only 2 incoming video tracks** (host, moderator) regardless of room size.
- Participant cannot consume another participant's producer by sending a crafted `consume` (server rejects).
- Admin sees all tiles; CPU stays stable with 50+ publishers using thumbnail layers.
- Payment: success, failure, user closes popup, webhook-only completion, duplicate webhook.
- Unpaid user cannot connect to the room socket.
- Countdown correct across timezones and wrong local clocks.
- Hand approve/revoke correctly opens and closes audio.
- Enrolled badge appears instantly after CTA purchase.
- TURN works on mobile data and strict corporate networks.

## 19. Suggested Timeline

Solo developer with AI assistance: Phase 1-2 about 1 week, Phase 3 about 3 days, Phase 4 about 1-2 weeks (the hardest part), Phase 5 about 1 week, Phase 6 about 1 week. Total roughly 5-6 weeks for a solid MVP.
