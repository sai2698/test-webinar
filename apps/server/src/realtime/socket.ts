import type { Server, Socket } from 'socket.io';
import { nanoid } from 'nanoid';
import type { Role, CohostPermissions } from '@webinar/shared';
import { DEFAULT_COHOST_PERMISSIONS } from '@webinar/shared';
import { prisma } from '../db/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { roomManager } from './RoomManager.js';
import { toSettings } from '../modules/webinars/service.js';
import { isStaffRole } from './visibility.js';
import { iceServers } from '../config/mediasoup.js';
import { chatLimiter, handLimiter, qaLimiter, qaVoteLimiter, quizLimiter } from '../middleware/rateLimit.js';
import { bus } from '../utils/bus.js';
import { emitWebhook } from '../modules/webhooks/service.js';
import { maskProfanity } from '../utils/profanity.js';
import { createLogger } from '../utils/logger.js';
import type { Room } from './Room.js';
import { Peer } from './Peer.js';

const log = createLogger('socket');

interface SocketData {
  peerId?: string;
  webinarId?: string;
  userId?: string;
  role?: Role;
  name?: string;
}

type AppSocket = Socket & { data: SocketData };

// A client that emits a payload to an ack-only event hands us an object where
// we expect a function. Guarding here means a malformed client gets no reply
// instead of crashing the process.
function ackOk<T>(ack: unknown, data?: T) {
  if (typeof ack === 'function') (ack as (res: unknown) => void)({ ok: true, data });
}

function ackErr(ack: unknown, error: string) {
  if (typeof ack === 'function') (ack as (res: unknown) => void)({ ok: false, error });
}

/**
 * Ack-only events are declared as `(ack) => void`, but a client written against
 * the payload convention will emit `(payload, ack)`. Picking whichever argument
 * is actually a function keeps both call styles working.
 */
function pickAck(a: unknown, b?: unknown): unknown {
  if (typeof a === 'function') return a;
  if (typeof b === 'function') return b;
  return undefined;
}

/**
 * Work out what a joining peer is allowed to do.
 *
 * Returns `null` for anyone who is not a co-host — an owner, a global admin, or
 * a plain moderator — because those peers are governed by their role and should
 * not be narrowed by a permission map that was never written for them.
 *
 * A co-host is a HOST-role peer with a `WebinarCohost` row. Their map is merged
 * over the defaults at read time, so a permission added in a later release is
 * granted automatically instead of reading as `undefined` on an old row.
 */
async function resolveCohostPermissions(
  webinar: {
    id: string;
    hostId: string;
    cohostStartWithoutHost: boolean;
    cohostPermissionsJson: string;
  },
  userId: string,
  role: Role
): Promise<CohostPermissions | null> {
  if (role === 'ADMIN' || role === 'PARTICIPANT') return null;
  if (webinar.hostId === userId) return null;

  const row = await prisma.webinarCohost.findFirst({
    where: { webinarId: webinar.id, userId },
    select: { permissionsJson: true },
  });
  if (!row) return null;

  let stored: Partial<CohostPermissions> = {};
  try {
    stored = JSON.parse(row.permissionsJson) as Partial<CohostPermissions>;
  } catch {
    stored = {};
  }

  let webinarDefaults: Partial<CohostPermissions> = {};
  try {
    webinarDefaults = JSON.parse(webinar.cohostPermissionsJson) as Partial<CohostPermissions>;
  } catch {
    webinarDefaults = {};
  }

  const merged: CohostPermissions = {
    ...DEFAULT_COHOST_PERMISSIONS,
    ...webinarDefaults,
    ...stored,
  };

  // The owner's policy can grant the start right to every co-host at once,
  // which is the common case — "my co-host can open the room if I am late".
  if (webinar.cohostStartWithoutHost) merged.startWebinar = true;

  return merged;
}

/**
 * Announces a purchase in the room's chat.
 *
 * The buyer's name is looked up rather than taken from the peer, because the
 * purchase can land while they are not connected — a checkout completed on a
 * phone after the tab was closed still deserves the announcement, and the room
 * should not silently lose the room's best social proof.
 */
async function announceEnrollment(room: Room, userId: string, courseTitle: string) {
  const peer = room.getPeerByUserId(userId);
  const name =
    peer?.name ??
    (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ??
    'Someone';

  // No emoji in the text: the chat card and the stage banner each supply their
  // own glyph, and a third one in the string reads as a stutter.
  //
  // The two nouns ride along so each surface can phrase the fact its own way —
  // the feed says "Congratulations! Tamanna for Enrolling", the toast over the
  // video says "Tamanna just enrolled in the course." Deriving one from the
  // other would mean parsing the sentence back apart.
  room.pushSystemMessage(`${name} just enrolled in ${courseTitle}!`, 'enrollment', {
    actor: name,
    subject: courseTitle,
  });
}

export function registerSocketHandlers(io: Server) {
  roomManager.setIo(io);

  // Bridge REST-side events (payments) into live rooms.
  bus.onEvent('enrollment:created', ({ webinarId, userId, courseTitle }) => {
    if (!webinarId) return;
    const room = roomManager.get(webinarId);
    if (!room) return;
    room.markEnrolled(userId);
    void announceEnrollment(room, userId, courseTitle);
  });

  bus.onEvent('registration:paid', ({ webinarId, userId }) => {
    const room = roomManager.get(webinarId);
    room?.markEnrolled(userId);
  });

  io.on('connection', (socket: AppSocket) => {
    log.debug(`socket connected ${socket.id}`);

    /* ── join ─────────────────────────────────────────────── */
    socket.on('join', async (payload, ack) => {
      try {
        const { slug, token } = payload ?? {};
        if (!slug) return ackErr(ack, 'Missing webinar slug');

        const webinar = await prisma.webinar.findUnique({
          where: { slug },
          include: { moderators: true },
        });
        if (!webinar) return ackErr(ack, 'Webinar not found');
        if (webinar.status === 'ENDED') return ackErr(ack, 'This webinar has ended');

        // ── authenticate ────────────────────────────────────
        let userId: string;
        let role: Role;
        let name: string;

        const jwtPayload = token ? verifyToken(token) : null;

        if (jwtPayload) {
          userId = jwtPayload.sub;
          name = jwtPayload.name;
          role = jwtPayload.role;

          // Staff roles are scoped per webinar: a HOST of another webinar is
          // just a participant here.
          const isHost = webinar.hostId === userId;
          const isModerator = webinar.moderators.some((m) => m.userId === userId);

          // A co-host is invited by email, often before they have an account,
          // so the row may still have a null userId. Match on either, and
          // backfill the link so the permission lookup below finds it.
          const cohost = await prisma.webinarCohost.findFirst({
            where: {
              webinarId: webinar.id,
              OR: [{ userId }, { email: jwtPayload.email.toLowerCase() }],
            },
            select: { id: true, userId: true },
          });
          if (cohost && !cohost.userId) {
            await prisma.webinarCohost.update({
              where: { id: cohost.id },
              data: { userId },
            });
          }

          if (role === 'ADMIN') {
            // global admin keeps admin powers
          } else if (isHost) {
            role = 'HOST';
          } else if (isModerator || cohost) {
            role = 'MODERATOR';
          } else {
            role = 'PARTICIPANT';
          }
        } else {
          return ackErr(ack, 'Authentication required');
        }

        // ── payment gate ────────────────────────────────────
        const needsPayment = webinar.requirePayment && webinar.priceInPaise > 0;
        if (needsPayment && !isStaffRole(role)) {
          const registration = await prisma.registration.findUnique({
            where: { webinarId_userId: { webinarId: webinar.id, userId } },
          });
          if (!registration?.paid) {
            return ackErr(ack, 'Payment required to join this webinar');
          }
        }

        // ── approval gate ───────────────────────────────────
        // A registration that is waiting for, or was refused, host approval must
        // not enter the room. Checked here as well as at the HTTP claim step,
        // because a token minted before the host rejected the request would
        // otherwise still open the door.
        if (!isStaffRole(role)) {
          const registration = await prisma.registration.findUnique({
            where: { webinarId_userId: { webinarId: webinar.id, userId } },
            select: { status: true },
          });

          if (registration) {
            if (registration.status === 'PENDING') {
              return ackErr(ack, 'Your registration is awaiting host approval');
            }
            if (registration.status === 'REJECTED') {
              return ackErr(ack, 'Your registration was not approved');
            }
            if (registration.status === 'CANCELLED') {
              return ackErr(ack, 'Your registration was cancelled');
            }
            if (registration.status === 'WAITLISTED') {
              return ackErr(ack, 'You are on the waitlist for this webinar');
            }
          } else if (webinar.inviteOnly) {
            // inviteOnly with no registration row means this person was never
            // invited — the HTTP layer normally catches this, but a stale token
            // would slip through.
            return ackErr(ack, 'This webinar is invite-only');
          }
        }

        // ── capacity gate ───────────────────────────────────
        const room = await roomManager.getOrCreate({
          webinarId: webinar.id,
          slug: webinar.slug,
          title: webinar.title,
          status: webinar.status,
          settings: toSettings(webinar),
          hostId: webinar.hostId,
          moderatorIds: webinar.moderators.map((m) => m.userId),
          startedAt: webinar.startedAt,
        });

        if (
          webinar.maxParticipants &&
          room.peers.size >= webinar.maxParticipants &&
          !isStaffRole(role)
        ) {
          return ackErr(ack, 'This webinar is full');
        }

        // ── one active socket per user ──────────────────────
        const existing = room.getPeerByUserId(userId);
        if (existing) {
          io.to(existing.socketId).emit('kicked', {
            reason: 'You joined from another tab or device',
          });
          room.removePeer(existing.peerId);
        }

        const peer = new Peer({
          peerId: nanoid(12),
          userId,
          name,
          role,
          socketId: socket.id,
          permissions: await resolveCohostPermissions(webinar, userId, role),
        });

        await room.addPeer(peer);

        socket.data.peerId = peer.peerId;
        socket.data.webinarId = webinar.id;
        socket.data.userId = userId;
        socket.data.role = role;
        socket.data.name = name;

        socket.join(room.roomName());

        // Mark attendance
        await prisma.registration
          .updateMany({
            where: { webinarId: webinar.id, userId },
            data: { attended: true },
          })
          .catch(() => undefined);

        // Notify others — only those allowed to see this peer. A room-wide
        // broadcast would tell participants about each other even when the
        // host has kept the audience private.
        room.broadcastPeerToVisible(peer, 'peerJoined');

        // Send chat history + hand list to the newcomer
        for (const msg of room.getChatHistory()) {
          socket.emit('chatMessage', msg);
        }
        if (isStaffRole(role)) socket.emit('handList', room.getHandList());

        const snapshot = room.snapshotFor(peer);
        room.broadcastViewerCount();

        ack?.({
          ok: true,
          data: {
            peerId: peer.peerId,
            role,
            userId,
            name,
            rtpCapabilities: room.rtpCapabilities,
            snapshot,
          },
        });

        // The snapshot is built synchronously, so the Q&A queue is sent right
        // after the ack — the client renders the room first, then fills in.
        void room.sendQuestionsTo(peer);

        log.info(`${name} (${role}) joined ${webinar.slug}`);
      } catch (err) {
        log.error('join failed', err);
        ackErr(ack, err instanceof Error ? err.message : 'Join failed');
      }
    });

    /* ── helpers ──────────────────────────────────────────── */
    const ctx = () => {
      const room = socket.data.webinarId ? roomManager.get(socket.data.webinarId) : undefined;
      const peer = room?.getPeerBySocket(socket.id);
      return { room, peer };
    };

    const requirePeer = (): { room: Room; peer: Peer } | null => {
      const { room, peer } = ctx();
      if (!room || !peer) return null;
      return { room, peer };
    };

    /**
     * Staff action gate.
     *
     * A peer with no permission map (owner, admin, plain moderator) passes on
     * role alone. A co-host passes only if their map grants the permission.
     * Returns the error string to send back, or `null` when allowed.
     */
    const denied = (peer: Peer, permission: keyof CohostPermissions): string | null => {
      if (!peer.isStaff) return 'Not allowed';
      if (peer.can(permission)) return null;
      return 'Your co-host permissions do not allow this';
    };

    /* ── transports ───────────────────────────────────────── */
    socket.on('createTransport', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      try {
        const router = c.room.router;
        if (!router) return ackErr(ack, 'Router not ready');

        const transport = await c.peer.createTransport(router, payload.direction);

        ackOk(ack, {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          iceServers: iceServers(),
        });
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Transport failed');
      }
    });

    socket.on('connectTransport', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      try {
        const transport =
          c.peer.sendTransport?.id === payload.transportId
            ? c.peer.sendTransport
            : c.peer.recvTransport?.id === payload.transportId
              ? c.peer.recvTransport
              : null;

        if (!transport) return ackErr(ack, 'Transport not found');

        await transport.connect({
          dtlsParameters: payload.dtlsParameters as never,
        });
        ackOk(ack);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Connect failed');
      }
    });

    /* ── produce ──────────────────────────────────────────── */
    socket.on('produce', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      try {
        const producer = await c.peer.produce(
          payload.transportId,
          payload.kind,
          payload.rtpParameters as never,
          payload.appData ?? {},
          c.room.settings,
          payload.source
        );

        c.room.announceProducer(c.peer, producer.id, payload.kind);
        c.room.broadcastPeerUpdated(c.peer);

        ackOk(ack, { producerId: producer.id });
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Produce failed');
      }
    });

    socket.on('closeProducer', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const producer = c.peer.producers.get(payload.producerId);
      if (!producer) return ackErr(ack, 'Producer not found');

      producer.close();
      c.peer.producers.delete(payload.producerId);
      c.peer.producerSources.delete(payload.producerId);
      c.room.announceProducerClosed(c.peer, payload.producerId);
      c.room.broadcastPeerUpdated(c.peer);
      ackOk(ack);
    });

    socket.on('setProducerPaused', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const producer = c.peer.producers.get(payload.producerId);
      if (!producer) return ackErr(ack, 'Producer not found');

      if (payload.paused) await producer.pause();
      else await producer.resume();

      socket.to(c.room.roomName()).emit('producerPaused', {
        producerId: payload.producerId,
        paused: payload.paused,
      });
      ackOk(ack);
    });

    /* ── consume ──────────────────────────────────────────── */
    socket.on('consume', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      try {
        const router = c.room.router;
        if (!router) return ackErr(ack, 'Router not ready');

        // Find the producer and its owner.
        let owner: Peer | undefined;
        let producer;
        for (const p of c.room.peers.values()) {
          const found = p.producers.get(payload.producerId);
          if (found) {
            owner = p;
            producer = found;
            break;
          }
        }

        if (!owner || !producer) return ackErr(ack, 'Producer not found');

        const consumer = await c.peer.consume(
          router,
          producer,
          owner,
          payload.rtpCapabilities as never,
          c.room.visibilityPolicy()
        );

        ackOk(ack, {
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind as 'audio' | 'video',
          source: owner.sourceOf(consumer.producerId, consumer.kind as 'audio' | 'video'),
          rtpParameters: consumer.rtpParameters,
          peerId: owner.peerId,
          userId: owner.userId,
          producerPaused: consumer.producerPaused,
        });
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Consume failed');
      }
    });

    socket.on('resumeConsumer', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const consumer = c.peer.consumers.get(payload.consumerId);
      if (!consumer) return ackErr(ack, 'Consumer not found');
      try {
        await consumer.resume();
        ackOk(ack);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Resume failed');
      }
    });

    /* ── simulcast layer preference ───────────────────────── */
    // Video producers are single-layer now (see `publishTrack` in
    // `useMediasoup.ts`), so there is no layer to prefer. The handler stays so
    // an older client that still emits `setPreferredLayers` gets an ack
    // instead of a timeout.
    //
    // It used to forward to `Consumer.setPreferredLayers`, which *pins* a
    // consumer to one spatial layer: the SFU stops adapting and will not fall
    // back if that layer stops encoding. A camera producer advertised three
    // simulcast layers, but the top one (`r2`) only ramps up when the encoder
    // has spare bitrate — so pinning a consumer to layer 2 left it waiting for
    // a keyframe that never arrived. The tile was in the DOM, the consumer
    // reported `paused: false`, and yet the `<video>` had `videoWidth: 0` and
    // a muted track. It showed up most when a host shared their screen: the
    // layout switch re-mounted the camera tile, the unmount cleanup pinned the
    // top layer, and the camera went black for every participant.
    //
    // mediasoup exposes no "clear preference" call, so the only safe way to
    // keep the SFU's bandwidth estimator in charge is to never take control
    // away from it.
    socket.on('setPreferredLayers', async (_payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      ackOk(ack);
    });

    /* ── chat ─────────────────────────────────────────────── */
    socket.on('chatSend', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (!c.room.settings.chatEnabled) return ackErr(ack, 'Chat is disabled');

      const limit = chatLimiter(c.peer.userId);
      if (!limit.allowed) return ackErr(ack, 'Slow down a little');

      const text = String(payload?.text ?? '').trim().slice(0, 1000);
      if (!text) return ackErr(ack, 'Message is empty');

      c.room.pushChat({
        id: nanoid(12),
        userId: c.peer.userId,
        name: c.peer.name,
        role: c.peer.role,
        text: maskProfanity(text),
        enrolled: c.room.isEnrolled(c.peer.userId),
        ts: Date.now(),
      });

      ackOk(ack);
    });

    socket.on('chatDelete', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (!c.peer.isStaff) return ackErr(ack, 'Not allowed');

      const removed = await c.room.deleteChat(payload.id);
      if (removed) return ackErr(ack, removed);
      ackOk(ack);
    });

    /* ── hands ────────────────────────────────────────────── */
    socket.on('handRaise', (ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (!c.room.settings.handRaiseEnabled) return ackErr(ack, 'Hand raise is disabled');
      if (c.peer.isStaff) return ackErr(ack, 'Staff do not need to raise hands');

      const limit = handLimiter(c.peer.userId);
      if (!limit.allowed) return ackErr(ack, 'Please wait before raising again');

      c.room.raiseHand(c.peer);
      ackOk(ack);
    });

    socket.on('handLower', (ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      c.room.lowerHand(c.peer);
      ackOk(ack);
    });

    socket.on('handApprove', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (!c.peer.isStaff) return ackErr(ack, 'Not allowed');

      const target = c.room.getPeerByUserId(payload.userId);
      if (!target) return ackErr(ack, 'Participant is not connected');

      target.isApprovedSpeaker = true;
      c.room.hands.delete(target.userId);
      c.room.broadcastHandList();
      c.room.broadcastPeerUpdated(target);

      io.to(target.socketId).emit('handApproved', {
        canPublishAudio: c.room.settings.allowMic,
        canPublishVideo: c.room.settings.allowVideo,
      });

      c.room.pushSystemMessage(`${target.name} was invited to speak`);
      ackOk(ack);
    });

    socket.on('handDeny', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (!c.peer.isStaff) return ackErr(ack, 'Not allowed');

      const target = c.room.getPeerByUserId(payload.userId);
      if (!target) return ackErr(ack, 'Participant is not connected');

      target.isApprovedSpeaker = false;
      c.room.hands.delete(target.userId);

      // Close their producers — they may no longer publish.
      const closed = target.closeAllProducers();
      for (const producerId of closed) {
        c.room.announceProducerClosed(target, producerId);
      }

      c.room.revalidateVisibility(target);
      c.room.broadcastHandList();
      c.room.broadcastPeerUpdated(target);

      io.to(target.socketId).emit('handRevoked');
      ackOk(ack);
    });

    /* ── quiz ─────────────────────────────────────────────── */
    socket.on('quizLaunch', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const no = denied(c.peer, 'polls');
      if (no) return ackErr(ack, no);
      try {
        await c.room.launchQuiz(payload.quizId);
        ackOk(ack);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not launch quiz');
      }
    });

    socket.on('quizAnswer', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');

      const limit = quizLimiter(c.peer.userId);
      if (!limit.allowed) return ackErr(ack, 'Slow down');

      try {
        const correct = await c.room.answerQuiz(c.peer, payload.quizId, payload.optionId);
        ackOk(ack, { correct });
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not submit answer');
      }
    });

    socket.on('quizClose', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const no = denied(c.peer, 'polls');
      if (no) return ackErr(ack, no);
      await c.room.closeQuiz(payload.quizId);
      ackOk(ack);
    });

    /* ── poll ─────────────────────────────────────────────── */
    socket.on('pollLaunch', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const no = denied(c.peer, 'polls');
      if (no) return ackErr(ack, no);
      try {
        await c.room.launchPoll(payload.pollId);
        ackOk(ack);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not launch poll');
      }
    });

    socket.on('pollVote', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');

      const limit = quizLimiter(c.peer.userId);
      if (!limit.allowed) return ackErr(ack, 'Slow down');

      try {
        const results = await c.room.votePoll(c.peer, payload.pollId, payload.optionId);
        ackOk(ack, { distribution: results.distribution, totalVotes: results.totalVotes });
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not record vote');
      }
    });

    socket.on('pollClose', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (!c.peer.isStaff) return ackErr(ack, 'Not allowed');
      await c.room.closePoll(payload.pollId);
      ackOk(ack);
    });

    /* ── Q&A ──────────────────────────────────────────────── */
    socket.on('qaAsk', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const limit = qaLimiter(c.peer.userId);
      if (!limit.allowed) return ackErr(ack, 'Slow down');
      try {
        const question = await c.room.askQuestion(c.peer, payload.text);
        ackOk(ack, { question });
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not post question');
      }
    });

    socket.on('qaUpvote', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const limit = qaVoteLimiter(c.peer.userId);
      if (!limit.allowed) return ackErr(ack, 'Slow down');
      try {
        const result = await c.room.upvoteQuestion(c.peer, payload.questionId);
        ackOk(ack, result);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not record vote');
      }
    });

    socket.on('qaAnswer', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (!c.peer.isStaff) return ackErr(ack, 'Not allowed');
      try {
        await c.room.answerQuestion(payload.questionId, payload.answered);
        ackOk(ack);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not update question');
      }
    });

    socket.on('qaPin', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const no = denied(c.peer, 'qna');
      if (no) return ackErr(ack, no);
      try {
        await c.room.pinQuestion(payload.questionId, payload.pinned);
        ackOk(ack);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not pin question');
      }
    });

    socket.on('qaDelete', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const no = denied(c.peer, 'qna');
      if (no) return ackErr(ack, no);
      try {
        await c.room.deleteQuestion(payload.questionId);
        ackOk(ack);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not delete question');
      }
    });

    /* ── spotlight & mute-all ─────────────────────────────── */
    socket.on('spotlight', (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const no = denied(c.peer, 'usersControl');
      if (no) return ackErr(ack, no);
      try {
        c.room.setSpotlight(payload.peerId);
        ackOk(ack);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not spotlight');
      }
    });

    socket.on('muteAll', (ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const no = denied(c.peer, 'usersControl');
      if (no) return ackErr(ack, no);
      ackOk(ack, { muted: c.room.muteAll() });
    });

    /* ── media state & requests ───────────────────────────── */
    socket.on('mediaState', (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      c.peer.micOn = Boolean(payload.micOn);
      c.peer.camOn = Boolean(payload.camOn);
      // Everyone needs this, not just staff: the participant list shows a mic
      // and camera icon per row, and a viewer reading it should see the truth.
      c.room.broadcastPeerUpdated(c.peer);
      ackOk(ack);
    });

    socket.on('mediaRequest', (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const no = denied(c.peer, 'usersControl');
      if (no) return ackErr(ack, no);
      try {
        const name = c.room.requestMedia(payload.userId, payload.kind, c.peer.name);
        ackOk(ack, { name });
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not send the request');
      }
    });
    /* ── CTA ──────────────────────────────────────────────── */
    socket.on('ctaShow', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (!c.peer.isStaff) return ackErr(ack, 'Not allowed');
      try {
        await c.room.showCta(payload.ctaId);
        ackOk(ack);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not show offer');
      }
    });

    socket.on('ctaHide', (a, b) => {
      const ack = pickAck(a, b);
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (!c.peer.isStaff) return ackErr(ack, 'Not allowed');
      c.room.hideCta();
      ackOk(ack);
    });

    /**
     * A participant opened the offer.
     *
     * Deliberately open to every peer, not just staff — the whole point is to
     * count the people who are *not* staff. The server dedupes by user, so a
     * double click is harmless, and the tally is broadcast to staff only.
     */
    socket.on('ctaClick', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (!payload?.ctaId) return ackErr(ack, 'Missing offer');

      try {
        const clickCount = await c.room.recordCtaClick(
          payload.ctaId,
          c.peer,
          payload.responses ?? {}
        );
        ackOk(ack, { clickCount });
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not record the click');
      }
    });

    /* ── moderation ───────────────────────────────────────── */
    socket.on('modMute', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const no = denied(c.peer, 'usersControl');
      if (no) return ackErr(ack, no);

      const target = c.room.getPeerByUserId(payload.userId);
      if (!target) return ackErr(ack, 'Participant is not connected');

      for (const producer of target.producers.values()) {
        if (producer.kind === 'audio') await producer.pause();
      }
      io.to(target.socketId).emit('errorMessage', { message: 'A moderator muted you' });
      ackOk(ack);
    });

    socket.on('modKick', async (payload, ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      const no = denied(c.peer, 'usersControl');
      if (no) return ackErr(ack, no);

      const target = c.room.getPeerByUserId(payload.userId);
      if (!target) return ackErr(ack, 'Participant is not connected');

      io.to(target.socketId).emit('kicked', { reason: 'You were removed by a moderator' });
      c.room.removePeer(target.peerId);
      ackOk(ack);
    });

    /* ── snapshot ─────────────────────────────────────────── */
    socket.on('requestSnapshot', (ack) => {
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      ackOk(ack, c.room.snapshotFor(c.peer));
    });

    /* ── recording ────────────────────────────────────────── */
    socket.on('recordingStart', async (a, b) => {
      const ack = pickAck(a, b);
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      // Recording captures everything said and shown, so it is a host/admin
      // decision — a moderator can run the room but not archive it.
      if (c.peer.role !== 'HOST' && c.peer.role !== 'ADMIN') {
        return ackErr(ack, 'Not allowed');
      }
      try {
        const recordingId = await c.room.startRecording();
        void emitWebhook('webinar.recording.created', {
          webinarId: c.room.webinarId,
          slug: c.room.slug,
          recordingId,
          startedBy: c.peer.name,
        });
        ackOk(ack, { recordingId });
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not start recording');
      }
    });

    socket.on('recordingStop', async (a, b) => {
      const ack = pickAck(a, b);
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      if (c.peer.role !== 'HOST' && c.peer.role !== 'ADMIN') {
        return ackErr(ack, 'Not allowed');
      }
      try {
        const result = await c.room.stopRecording();
        ackOk(ack, result);
      } catch (err) {
        ackErr(ack, err instanceof Error ? err.message : 'Could not stop recording');
      }
    });

    /* ── start webinar ────────────────────────────────────── */
    socket.on('webinarStart', async (a, b) => {
      const ack = pickAck(a, b);
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      // Opening the session is the host's call. A moderator can run the room
      // once it is open, but deciding when the audience is let in is not
      // theirs to make — unless the owner granted it. A co-host carries a
      // permission map; a plain moderator carries none, so `can()` is false
      // for them and the role gate below still holds.
      const isOwner = c.peer.role === 'HOST' || c.peer.role === 'ADMIN';
      if (!isOwner && !c.peer.can('startWebinar')) {
        return ackErr(ack, 'Not allowed');
      }
      const no = denied(c.peer, 'startWebinar');
      if (no) return ackErr(ack, no);

      const startedAt = c.room.startWebinar();

      // Persist so a participant who reloads — or arrives an hour later —
      // still finds the session open rather than back in the waiting room.
      await prisma.webinar
        .update({
          where: { id: c.room.webinarId },
          data: { status: 'LIVE', startedAt: new Date(startedAt) },
        })
        .catch(() => undefined);

      void emitWebhook('webinar.started', {
        webinarId: c.room.webinarId,
        slug: c.room.slug,
        title: c.room.title,
        startedAt: new Date(startedAt).toISOString(),
        startedBy: c.peer.name,
      });

      ackOk(ack, { startedAt });
    });

    /* ── end webinar ──────────────────────────────────────── */
    socket.on('webinarEnd', async (a, b) => {
      const ack = pickAck(a, b);
      const c = requirePeer();
      if (!c) return ackErr(ack, 'Not in a room');
      // Only the webinar's own host or a global admin may end it — unless the
      // owner granted the right to a co-host. Same reasoning as `webinarStart`.
      const isOwner = c.peer.role === 'HOST' || c.peer.role === 'ADMIN';
      if (!isOwner && !c.peer.can('endWebinar')) {
        return ackErr(ack, 'Not allowed');
      }
      const no = denied(c.peer, 'endWebinar');
      if (no) return ackErr(ack, no);

      // Ending the session must also close the recording, otherwise the row
      // stays in RECORDING and the replay never becomes available.
      if (c.room.isRecording) {
        await c.room.stopRecording().catch(() => undefined);
      }

      await prisma.webinar
        .update({ where: { id: c.room.webinarId }, data: { status: 'ENDED' } })
        .catch(() => undefined);

      void emitWebhook('webinar.ended', {
        webinarId: c.room.webinarId,
        slug: c.room.slug,
        title: c.room.title,
        endedAt: new Date().toISOString(),
        endedBy: c.peer.name,
      });

      c.room.endWebinar();
      ackOk(ack);
    });

    /* ── disconnect ───────────────────────────────────────── */
    socket.on('disconnect', async () => {
      const { room, peer } = ctx();
      if (!room || !peer) return;

      room.removePeer(peer.peerId);
      await roomManager.destroyIfEmpty(room.webinarId);
      log.debug(`${peer.name} disconnected`);
    });
  });
}
