import type { Router, RtpCapabilities } from 'mediasoup/types';
import type { Server } from 'socket.io';
import type {
  ChatMessagePayload,
  ChatSystemKind,
  CtaPayload,
  HandRaiseEntry,
  PollResults,
  PublicPoll,
  PublicQuiz,
  QaQuestionPayload,
  QuizOption,
  QuizResults,
  Role,
  RoomSnapshot,
  WebinarSettings,
} from '@webinar/shared';
import { mediaCodecs } from '../config/mediasoup.js';
import { prisma } from '../db/prisma.js';
import { workerPool } from './WorkerPool.js';
import { Peer } from './Peer.js';
import { Recorder } from './Recorder.js';
import { canConsume, canSeePeer, isStaffRole, type VisibilityPolicy } from './visibility.js';
import {
  CTA_INCLUDE,
  countClicks,
  recordClick,
  serializeCta,
  serializeForm,
  validateCtaResponses,
} from '../modules/quizzes/cta.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('room');

export interface RoomContext {
  webinarId: string;
  slug: string;
  title: string;
  status: string;
  settings: WebinarSettings;
  hostId: string;
  moderatorIds: string[];
  /** When the host opened the session, if they already have. */
  startedAt?: Date | null;
}

interface ActiveQuiz {
  quiz: PublicQuiz;
  correctOptionId: string | null;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  answered: Set<string>;
}

interface ActivePoll {
  poll: PublicPoll;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  /** userId → optionId, so a voter can change their mind before it closes. */
  votes: Map<string, string>;
}

/**
 * One Room per webinar. Owns the mediasoup Router, all Peers, and the
 * ephemeral interaction state (hands, active quiz, active CTA, chat buffer).
 */
export class Room {
  readonly webinarId: string;
  readonly slug: string;
  title: string;
  status: string;
  settings: WebinarSettings;
  hostId: string;
  moderatorIds: string[];

  router: Router | null = null;
  private routerReady: Promise<Router> | null = null;

  readonly peers = new Map<string, Peer>();
  private readonly socketToPeer = new Map<string, string>();

  readonly hands = new Map<string, number>(); // userId → raisedAt
  private activeQuiz: ActiveQuiz | null = null;
  private activePoll: ActivePoll | null = null;
  private activeCta: CtaPayload | null = null;
  /** The peer the host has pinned to the big tile, if any. */
  private spotlightedPeerId: string | null = null;

  /**
   * When the host opened the session, or `null` while it is still waiting.
   *
   * Participants are let into the room before the host starts so they can see
   * the waiting screen and the chat, but nothing is "live" until this is set.
   */
  private startedAt: number | null = null;

  private chatBuffer: ChatMessagePayload[] = [];
  private enrolledUserIds = new Set<string>();
  private chatPersistQueue: { webinarId: string; userId: string; text: string }[] = [];

  private viewerCountTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  /** Non-null while the host is capturing this session. */
  private recorder: Recorder | null = null;
  /** PlainTransports feeding FFmpeg, closed when recording stops. */
  private recordingTransports: import('mediasoup/types').PlainTransport[] = [];

  constructor(
    private readonly io: Server,
    ctx: RoomContext
  ) {
    this.webinarId = ctx.webinarId;
    this.slug = ctx.slug;
    this.title = ctx.title;
    this.status = ctx.status;
    this.settings = ctx.settings;
    this.hostId = ctx.hostId;
    this.moderatorIds = ctx.moderatorIds;

    // A webinar already marked LIVE in the database has been opened before —
    // by a host who then left, or by the premiere scheduler. Treating it as
    // unstarted would drop everyone back into the waiting room on the next
    // join, so the persisted start time wins. Falling back to `Date.now()`
    // covers rows written before the column existed.
    if (ctx.startedAt) this.startedAt = ctx.startedAt.getTime();
    else if (ctx.status === 'LIVE') this.startedAt = Date.now();
  }

  /* ── lifecycle ───────────────────────────────────────────── */

  async init(): Promise<void> {
    await this.loadEnrollments();
    await this.loadChatHistory();
    this.startTimers();
  }

  private async getRouter(): Promise<Router> {
    if (this.router) return this.router;
    if (this.routerReady) return this.routerReady;

    this.routerReady = (async () => {
      const worker = workerPool.getNext();
      const router = await worker.createRouter({ mediaCodecs });
      this.router = router;
      log.info(`Router created for "${this.slug}"`);
      return router;
    })();

    return this.routerReady;
  }

  get rtpCapabilities(): RtpCapabilities | null {
    return this.router?.rtpCapabilities ?? null;
  }

  private startTimers() {
    this.viewerCountTimer = setInterval(() => {
      this.broadcastViewerCount();
    }, 10_000);

    this.persistTimer = setInterval(() => {
      void this.flushChat();
    }, 5_000);
  }

  async destroy(): Promise<void> {
    if (this.viewerCountTimer) clearInterval(this.viewerCountTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    if (this.activeQuiz?.timer) clearTimeout(this.activeQuiz.timer);
    if (this.activePoll?.timer) clearTimeout(this.activePoll.timer);
    // A room torn down mid-recording must not leave a row stuck in RECORDING.
    if (this.recorder) {
      await this.recorder.abort('The room closed before recording finished');
      this.recorder = null;
    }
    await this.flushChat();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.socketToPeer.clear();
    this.router?.close();
    this.router = null;
    log.info(`Room destroyed: ${this.slug}`);
  }

  /* ── peers ───────────────────────────────────────────────── */

  async addPeer(peer: Peer): Promise<void> {
    this.peers.set(peer.peerId, peer);
    this.socketToPeer.set(peer.socketId, peer.peerId);
    this.recorder?.record({ type: 'peerJoined', name: peer.name, role: peer.role });
    await this.getRouter();
  }

  removePeer(peerId: string): Peer | null {
    const peer = this.peers.get(peerId);
    if (!peer) return null;

    peer.close();
    this.peers.delete(peerId);
    this.socketToPeer.delete(peer.socketId);
    this.hands.delete(peer.userId);
    this.recorder?.record({ type: 'peerLeft', name: peer.name });

    // Tell everyone this peer is gone.
    this.io.to(this.roomName()).emit('peerLeft', { peerId, userId: peer.userId });

    // Close consumers that were receiving this peer's media. `closeConsumersFrom`
    // returns producer ids, which is what the client keys its stream map by.
    for (const other of this.peers.values()) {
      const closed = other.closeConsumersFrom(peerId);
      for (const producerId of closed) {
        this.io.to(other.socketId).emit('producerClosed', { peerId, producerId });
      }
    }

    this.broadcastHandList();
    this.broadcastViewerCount();
    return peer;
  }

  getPeerBySocket(socketId: string): Peer | undefined {
    const peerId = this.socketToPeer.get(socketId);
    return peerId ? this.peers.get(peerId) : undefined;
  }

  getPeerByUserId(userId: string): Peer | undefined {
    for (const peer of this.peers.values()) {
      if (peer.userId === userId) return peer;
    }
    return undefined;
  }

  get staffPeers(): Peer[] {
    return [...this.peers.values()].filter((p) => p.isStaff);
  }

  roomName(): string {
    return `webinar:${this.webinarId}`;
  }

  /**
   * The room-level half of the media visibility policy.
   *
   * Derived from settings on every call rather than cached, because a host can
   * flip `showParticipantsToEachOther` mid-session and the next consume must
   * honour the new value without a room rebuild.
   */
  visibilityPolicy(): VisibilityPolicy {
    return { participantsSeeEachOther: this.settings.showParticipantsToEachOther === true };
  }

  /* ── producer fan-out ────────────────────────────────────── */

  /**
   * Notifies every peer that is allowed to consume `producer` that it exists.
   * The actual Consumer is created when that peer calls `consume`.
   */
  announceProducer(owner: Peer, producerId: string, kind: 'audio' | 'video') {
    const source = owner.sourceOf(producerId, kind);
    const policy = this.visibilityPolicy();
    for (const viewer of this.peers.values()) {
      if (viewer.peerId === owner.peerId) continue;
      if (
        !canConsume(
          viewer,
          {
            role: owner.role,
            isApprovedSpeaker: owner.isApprovedSpeaker,
            kind,
            source,
          },
          policy
        )
      ) {
        continue;
      }
      this.io.to(viewer.socketId).emit('newProducer', {
        peerId: owner.peerId,
        userId: owner.userId,
        producerId,
        kind,
        source,
      });
    }
  }

  announceProducerClosed(owner: Peer, producerId: string) {
    for (const viewer of this.peers.values()) {
      if (viewer.peerId === owner.peerId) continue;
      this.io.to(viewer.socketId).emit('producerClosed', {
        peerId: owner.peerId,
        producerId,
      });
    }
  }

  /**
   * Re-evaluates visibility for a peer whose approval state changed.
   * Called when a hand is approved or revoked.
   */
  revalidateVisibility(owner: Peer) {
    const policy = this.visibilityPolicy();
    for (const viewer of this.peers.values()) {
      if (viewer.peerId === owner.peerId) continue;

      for (const producer of owner.producers.values()) {
        const kind = producer.kind as 'audio' | 'video';
        const source = owner.sourceOf(producer.id, kind);
        const allowed = canConsume(
          viewer,
          {
            role: owner.role,
            isApprovedSpeaker: owner.isApprovedSpeaker,
            kind,
            source,
          },
          policy
        );

        const existing = [...viewer.consumers.values()].find(
          (c) => c.producerId === producer.id
        );

        if (allowed && !existing) {
          this.io.to(viewer.socketId).emit('newProducer', {
            peerId: owner.peerId,
            userId: owner.userId,
            producerId: producer.id,
            kind,
            source,
          });
        } else if (!allowed && existing) {
          existing.close();
          viewer.consumers.delete(existing.id);
          this.io.to(viewer.socketId).emit('producerClosed', {
            peerId: owner.peerId,
            producerId: producer.id,
          });
        }
      }
    }
  }

  /**
   * Re-applies the visibility policy to the whole room after the host changed
   * `showParticipantsToEachOther` mid-session.
   *
   * Two things have to happen. Existing consumers that are no longer allowed
   * must be torn down — otherwise a participant keeps receiving a stream the
   * host just revoked, and hiding the tile would be a lie. And peers that
   * became visible must be announced, so the audience's grid fills in without
   * anyone reloading.
   */
  applyVisibilityChange() {
    const policy = this.visibilityPolicy();

    for (const viewer of this.peers.values()) {
      for (const owner of this.peers.values()) {
        if (owner.peerId === viewer.peerId) continue;

        const visible = canSeePeer(viewer, owner, policy);
        const info = owner.toInfo();

        if (visible) {
          this.io.to(viewer.socketId).emit('peerUpdated', info);
        } else {
          this.io.to(viewer.socketId).emit('peerLeft', { peerId: owner.peerId });
        }

        for (const producer of owner.producers.values()) {
          const kind = producer.kind as 'audio' | 'video';
          const source = owner.sourceOf(producer.id, kind);
          const allowed = canConsume(
            viewer,
            {
              role: owner.role,
              isApprovedSpeaker: owner.isApprovedSpeaker,
              kind,
              source,
            },
            policy
          );

          const existing = [...viewer.consumers.values()].find(
            (c) => c.producerId === producer.id
          );

          if (allowed && !existing) {
            this.io.to(viewer.socketId).emit('newProducer', {
              peerId: owner.peerId,
              userId: owner.userId,
              producerId: producer.id,
              kind,
              source,
            });
          } else if (!allowed && existing) {
            existing.close();
            viewer.consumers.delete(existing.id);
            this.io.to(viewer.socketId).emit('producerClosed', {
              peerId: owner.peerId,
              producerId: producer.id,
            });
          }
        }
      }
    }
  }

  /* ── chat ────────────────────────────────────────────────── */

  async loadEnrollments() {
    const rows = await prisma.enrollment.findMany({
      where: { webinarId: this.webinarId },
      select: { userId: true },
    });
    this.enrolledUserIds = new Set(rows.map((r) => r.userId));
  }

  private async loadChatHistory() {
    const rows = await prisma.chatMessage.findMany({
      where: { webinarId: this.webinarId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { id: true, name: true, role: true } } },
    });

    this.chatBuffer = rows
      .reverse()
      .map((m) => ({
        id: m.id,
        userId: m.userId,
        name: m.user.name,
        role: m.user.role as Role,
        text: m.text,
        enrolled: this.enrolledUserIds.has(m.userId),
        ts: m.createdAt.getTime(),
      }));
  }

  isEnrolled(userId: string): boolean {
    return this.enrolledUserIds.has(userId);
  }

  markEnrolled(userId: string) {
    this.enrolledUserIds.add(userId);
    this.io.to(this.roomName()).emit('enrolledUpdated', { userId, enrolled: true });
  }

  getChatHistory(): ChatMessagePayload[] {
    return this.chatBuffer.slice(-200);
  }

  pushChat(msg: ChatMessagePayload) {
    this.chatBuffer.push(msg);
    if (this.chatBuffer.length > 200) this.chatBuffer.shift();
    this.chatPersistQueue.push({
      webinarId: this.webinarId,
      userId: msg.userId,
      text: msg.text,
    });
    this.recorder?.record({ type: 'chat', message: msg });
    this.io.to(this.roomName()).emit('chatMessage', msg);
  }

  /**
   * A housekeeping or celebratory line from the server.
   *
   * `extra` carries the structured nouns for an enrollment (`actor` and
   * `subject`) so the chat card and the stage toast can each phrase the fact
   * their own way. `text` stays a complete sentence regardless, because the
   * replay timeline and the recorder only ever see the string.
   */
  pushSystemMessage(
    text: string,
    kind: ChatSystemKind = 'info',
    extra?: Pick<ChatMessagePayload, 'actor' | 'subject'>
  ) {
    const msg: ChatMessagePayload = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      userId: 'system',
      name: 'System',
      role: 'ADMIN',
      text,
      enrolled: false,
      ts: Date.now(),
      system: true,
      kind,
      ...extra,
    };
    this.chatBuffer.push(msg);
    if (this.chatBuffer.length > 200) this.chatBuffer.shift();
    this.recorder?.record({ type: 'system', text });
    this.io.to(this.roomName()).emit('chatMessage', msg);
  }

  /**
   * Removes a message from the in-memory buffer, the database and every
   * connected client. System messages are ephemeral and cannot be deleted.
   *
   * Returns `null` on success, or a human-readable reason on refusal.
   */
  async deleteChat(messageId: string): Promise<string | null> {
    const index = this.chatBuffer.findIndex((m) => m.id === messageId);
    if (index === -1) return 'Message not found';
    if (this.chatBuffer[index].system) return 'System messages cannot be deleted';

    this.chatBuffer.splice(index, 1);
    this.io.to(this.roomName()).emit('chatDeleted', { id: messageId });

    await prisma.chatMessage.deleteMany({ where: { id: messageId } }).catch(() => undefined);
    return null;
  }

  private async flushChat() {
    if (this.chatPersistQueue.length === 0) return;
    const batch = this.chatPersistQueue.splice(0, this.chatPersistQueue.length);
    try {
      await prisma.chatMessage.createMany({ data: batch });
    } catch (err) {
      log.warn('Failed to persist chat batch', err);
    }
  }

  /* ── hands ───────────────────────────────────────────────── */

  raiseHand(peer: Peer) {
    peer.handRaisedAt = Date.now();
    this.hands.set(peer.userId, peer.handRaisedAt);
    this.recorder?.record({ type: 'handRaised', userId: peer.userId, name: peer.name });
    this.broadcastHandList();
  }

  lowerHand(peer: Peer) {
    peer.handRaisedAt = null;
    this.hands.delete(peer.userId);
    this.recorder?.record({ type: 'handLowered', userId: peer.userId });
    this.broadcastHandList();
  }

  getHandList(): HandRaiseEntry[] {
    return [...this.hands.entries()]
      .map(([userId, raisedAt]) => {
        const peer = this.getPeerByUserId(userId);
        return { userId, name: peer?.name ?? 'Participant', raisedAt };
      })
      .sort((a, b) => a.raisedAt - b.raisedAt);
  }

  broadcastHandList() {
    const list = this.getHandList();
    for (const peer of this.peers.values()) {
      // Staff see the whole queue; participants only ever see their own entry,
      // which is enough to drive their "raise / lower hand" button state.
      const payload = isStaffRole(peer.role)
        ? list
        : list.filter((entry) => entry.userId === peer.userId);
      this.io.to(peer.socketId).emit('handList', payload);
    }
  }

  /* ── quiz ────────────────────────────────────────────────── */

  async launchQuiz(quizId: string): Promise<PublicQuiz> {
    const row = await prisma.quiz.findUnique({ where: { id: quizId } });
    if (!row) throw new Error('Quiz not found');

    const options = JSON.parse(row.optionsJson) as QuizOption[];
    const quiz: PublicQuiz = {
      id: row.id,
      question: row.question,
      options,
      timeLimitSecs: row.timeLimitSecs,
    };

    if (this.activeQuiz?.timer) clearTimeout(this.activeQuiz.timer);

    this.activeQuiz = {
      quiz,
      correctOptionId: row.correctOptionId,
      startedAt: Date.now(),
      timer: setTimeout(() => {
        void this.closeQuiz(quiz.id);
      }, row.timeLimitSecs * 1000),
      answered: new Set(),
    };

    this.io.to(this.roomName()).emit('quizStarted', quiz);
    this.recorder?.record({ type: 'quizStarted', quiz });
    return quiz;
  }

  async answerQuiz(peer: Peer, quizId: string, optionId: string): Promise<boolean> {
    const active = this.activeQuiz;
    if (!active || active.quiz.id !== quizId) throw new Error('Quiz is not active');
    if (active.answered.has(peer.userId)) throw new Error('You already answered');

    const isCorrect = active.correctOptionId === optionId;
    active.answered.add(peer.userId);

    await prisma.quizAnswer.upsert({
      where: { quizId_userId: { quizId, userId: peer.userId } },
      create: { quizId, userId: peer.userId, optionId, isCorrect },
      update: { optionId, isCorrect },
    });

    return isCorrect;
  }

  async closeQuiz(quizId: string): Promise<QuizResults | null> {
    const active = this.activeQuiz;
    if (!active || active.quiz.id !== quizId) return null;
    if (active.timer) clearTimeout(active.timer);

    const answers = await prisma.quizAnswer.findMany({ where: { quizId } });

    const distribution: Record<string, number> = {};
    for (const opt of active.quiz.options) distribution[opt.id] = 0;
    for (const a of answers) {
      distribution[a.optionId] = (distribution[a.optionId] ?? 0) + 1;
    }

    // The leaderboard is "who got it right, fastest". Everyone who answered
    // correctly scores the same, so elapsed time is the only meaningful
    // tie-breaker — and it rewards actually knowing the answer over guessing
    // after the discussion.
    const correctAnswers = answers
      .filter((a) => a.isCorrect)
      .map((a) => ({
        userId: a.userId,
        elapsedMs: Math.max(0, a.createdAt.getTime() - active.startedAt),
      }))
      .sort((a, b) => a.elapsedMs - b.elapsedMs)
      .slice(0, 5);

    const scorers = correctAnswers.length
      ? await prisma.user.findMany({
          where: { id: { in: correctAnswers.map((a) => a.userId) } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(scorers.map((u) => [u.id, u.name]));

    const results: QuizResults = {
      quizId,
      question: active.quiz.question,
      correctOptionId: active.correctOptionId,
      distribution,
      totalAnswers: answers.length,
      correctCount: answers.filter((a) => a.isCorrect).length,
      topScorers: correctAnswers.map((a) => ({
        userId: a.userId,
        name: nameById.get(a.userId) ?? 'Participant',
        elapsedMs: a.elapsedMs,
      })),
    };

    this.activeQuiz = null;
    this.io.to(this.roomName()).emit('quizResults', results);
    this.io.to(this.roomName()).emit('quizClosed', { quizId });
    this.recorder?.record({ type: 'quizResults', results });
    this.recorder?.record({ type: 'quizClosed', quizId });
    return results;
  }

  getActiveQuiz(): PublicQuiz | null {
    return this.activeQuiz?.quiz ?? null;
  }

  /* ── poll ────────────────────────────────────────────────── */

  /**
   * Opens a poll. Unlike a quiz there is no correct answer and no leaderboard —
   * the point is the tally, so the results are broadcast on every vote rather
   * than only at the end.
   */
  async launchPoll(pollId: string): Promise<PublicPoll> {
    const row = await prisma.poll.findUnique({ where: { id: pollId } });
    if (!row) throw new Error('Poll not found');

    const options = JSON.parse(row.optionsJson) as QuizOption[];
    const poll: PublicPoll = {
      id: row.id,
      question: row.question,
      options,
      timeLimitSecs: row.timeLimitSecs,
    };

    if (this.activePoll?.timer) clearTimeout(this.activePoll.timer);

    this.activePoll = {
      poll,
      startedAt: Date.now(),
      // 0 means "stay open until the host closes it".
      timer:
        row.timeLimitSecs > 0
          ? setTimeout(() => {
              void this.closePoll(poll.id);
            }, row.timeLimitSecs * 1000)
          : null,
      votes: new Map(),
    };

    this.io.to(this.roomName()).emit('pollStarted', poll);
    this.io.to(this.roomName()).emit('pollResults', this.pollTally());
    this.recorder?.record({ type: 'pollStarted', poll });
    return poll;
  }

  /**
   * Records a vote and returns the new tally. Voting twice replaces the
   * previous choice rather than erroring — people change their minds, and a
   * poll is not a test.
   */
  async votePoll(peer: Peer, pollId: string, optionId: string): Promise<PollResults> {
    const active = this.activePoll;
    if (!active || active.poll.id !== pollId) throw new Error('Poll is not active');
    if (!active.poll.options.some((o) => o.id === optionId)) {
      throw new Error('Unknown poll option');
    }

    active.votes.set(peer.userId, optionId);

    await prisma.pollVote.upsert({
      where: { pollId_userId: { pollId, userId: peer.userId } },
      create: { pollId, userId: peer.userId, optionId },
      update: { optionId },
    });

    const results = this.pollTally();
    this.io.to(this.roomName()).emit('pollResults', results);
    // Record the tally alongside the broadcast so a replay shows the poll
    // filling up rather than jumping from zero to the final result.
    this.recorder?.record({ type: 'pollResults', results });
    return results;
  }

  async closePoll(pollId: string): Promise<PollResults | null> {
    const active = this.activePoll;
    if (!active || active.poll.id !== pollId) return null;
    if (active.timer) clearTimeout(active.timer);

    const results: PollResults = { ...this.pollTally(), closed: true };

    this.activePoll = null;
    this.io.to(this.roomName()).emit('pollResults', results);
    this.io.to(this.roomName()).emit('pollClosed', { pollId });
    this.recorder?.record({ type: 'pollResults', results });
    this.recorder?.record({ type: 'pollClosed', pollId });
    return results;
  }

  /** Current tally for the open poll. Every option is present, even at zero. */
  private pollTally(): PollResults {
    const active = this.activePoll;
    if (!active) {
      return {
        pollId: '',
        question: '',
        options: [],
        distribution: {},
        totalVotes: 0,
        closed: true,
      };
    }

    const distribution: Record<string, number> = {};
    for (const opt of active.poll.options) distribution[opt.id] = 0;
    for (const optionId of active.votes.values()) {
      distribution[optionId] = (distribution[optionId] ?? 0) + 1;
    }

    return {
      pollId: active.poll.id,
      question: active.poll.question,
      options: active.poll.options,
      distribution,
      totalVotes: active.votes.size,
      closed: false,
    };
  }

  getActivePoll(): PublicPoll | null {
    return this.activePoll?.poll ?? null;
  }

  /** The tally for the open poll, or null when nothing is running. */
  getPollResults(): PollResults | null {
    return this.activePoll ? this.pollTally() : null;
  }

  /* ── Q&A ─────────────────────────────────────────────────── */

  /**
   * Adds a question to the queue.
   *
   * The queue is small (tens of rows, not thousands) so every change rebroadcasts
   * the whole list rather than sending deltas. That keeps the client trivial and
   * makes ordering — pinned first, then most upvoted, then newest — a single
   * server-side decision instead of something each client has to reproduce.
   */
  async askQuestion(peer: Peer, text: string): Promise<QaQuestionPayload> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Question cannot be empty');
    if (trimmed.length > 500) throw new Error('Question is too long');

    const row = await prisma.qaQuestion.create({
      data: { webinarId: this.webinarId, userId: peer.userId, text: trimmed },
    });

    const question: QaQuestionPayload = {
      id: row.id,
      userId: peer.userId,
      name: peer.name,
      role: peer.role,
      text: row.text,
      upvotes: 0,
      answered: false,
      pinned: false,
      ts: Date.now(),
      upvotedByMe: false,
    };

    this.recorder?.record({ type: 'qaAsked', question });
    await this.broadcastQuestions();
    return question;
  }

  /**
   * Toggles the caller's upvote. Upvoting twice removes the vote — a second
   * click on a button that is already lit should turn it off, not silently
   * do nothing.
   */
  async upvoteQuestion(peer: Peer, questionId: string): Promise<{ upvotes: number; upvoted: boolean }> {
    const existing = await prisma.qaQuestionVote.findUnique({
      where: { questionId_userId: { questionId, userId: peer.userId } },
    });

    if (existing) {
      await prisma.qaQuestionVote.delete({ where: { id: existing.id } });
    } else {
      await prisma.qaQuestionVote.create({ data: { questionId, userId: peer.userId } });
    }

    const upvotes = await prisma.qaQuestionVote.count({ where: { questionId } });
    await prisma.qaQuestion.update({ where: { id: questionId }, data: { upvotes } });

    await this.broadcastQuestions();
    return { upvotes, upvoted: !existing };
  }

  /** Staff only — marks a question answered, or reopens it. */
  async answerQuestion(questionId: string, answered: boolean): Promise<void> {
    await prisma.qaQuestion.update({
      where: { id: questionId },
      data: { answered, answeredAt: answered ? new Date() : null },
    });
    this.recorder?.record({ type: 'qaAnswered', questionId });
    await this.broadcastQuestions();
  }

  /** Staff only — pins a question to the top of the queue. */
  async pinQuestion(questionId: string, pinned: boolean): Promise<void> {
    await prisma.qaQuestion.update({ where: { id: questionId }, data: { pinned } });
    this.recorder?.record({ type: 'qaPinned', questionId, pinned });
    await this.broadcastQuestions();
  }

  /** Staff only — removes a question and its votes. */
  async deleteQuestion(questionId: string): Promise<void> {
    await prisma.qaQuestion.deleteMany({ where: { id: questionId } });
    await this.broadcastQuestions();
  }

  /**
   * The queue as one viewer sees it. `upvotedByMe` is per-viewer, which is why
   * this takes a userId rather than returning a single shared list.
   */
  async getQuestions(userId: string): Promise<QaQuestionPayload[]> {
    const rows = await prisma.qaQuestion.findMany({
      where: { webinarId: this.webinarId },
      orderBy: [{ pinned: 'desc' }, { upvotes: 'desc' }, { createdAt: 'desc' }],
      take: 200,
      include: {
        user: { select: { id: true, name: true, role: true } },
        votes: { where: { userId }, select: { id: true } },
      },
    });

    return rows.map((q) => ({
      id: q.id,
      userId: q.userId,
      name: q.user.name,
      role: q.user.role as Role,
      text: q.text,
      upvotes: q.upvotes,
      answered: q.answered,
      pinned: q.pinned,
      ts: q.createdAt.getTime(),
      upvotedByMe: q.votes.length > 0,
    }));
  }

  /**
   * Sends every peer its own view of the queue. One query per peer is fine at
   * this size, and it avoids leaking one viewer's vote state to another.
   */
  async broadcastQuestions(): Promise<void> {
    for (const peer of this.peers.values()) {
      const questions = await this.getQuestions(peer.userId);
      this.io.to(peer.socketId).emit('qaList', questions);
    }
  }

  /* ── CTA ─────────────────────────────────────────────────── */

  async showCta(ctaId: string): Promise<CtaPayload> {
    const cta = await prisma.cta.findUnique({
      where: { id: ctaId },
      include: CTA_INCLUDE,
    });
    if (!cta) throw new Error('Offer not found');

    const payload = serializeCta(cta as never, {
      clickCount: await countClicks(cta.id),
      clickedByMe: false,
    });

    this.activeCta = payload;
    this.io.to(this.roomName()).emit('ctaShown', payload);
    this.recorder?.record({ type: 'ctaShown', cta: payload });
    return payload;
  }

  hideCta() {
    this.activeCta = null;
    this.io.to(this.roomName()).emit('ctaHidden');
    this.recorder?.record({ type: 'ctaHidden' });
  }

  getActiveCta(): CtaPayload | null {
    return this.activeCta;
  }

  /**
   * Someone opened the offer.
   *
   * The tally goes to staff only. A participant seeing "37 people clicked" is
   * social proof the host never asked for, and it would leak the offer's
   * conversion rate to the whole room.
   */
  async recordCtaClick(
    ctaId: string,
    peer: { userId: string },
    responses: Record<string, unknown> = {}
  ): Promise<number> {
    const cta = await prisma.cta.findUnique({
      where: { id: ctaId },
      include: CTA_INCLUDE,
    });
    if (!cta) throw new Error('Offer not found');

    // A bare click carries no answers, and that is the normal case: the card
    // records the click the moment someone opens it, before they have filled
    // anything in. Validating an empty submission against required fields
    // would reject the very click the host is counting. Only a submission that
    // actually carries answers is held to the form's rules.
    const answers =
      Object.keys(responses).length > 0
        ? validateCtaResponses(serializeForm(cta as never), responses)
        : {};
    const clickCount = await recordClick(cta.id, cta.webinarId, peer.userId, answers);

    // Keep the cached payload honest so a late joiner's snapshot agrees with
    // the live tally the host is looking at.
    if (this.activeCta?.id === cta.id) {
      this.activeCta = { ...this.activeCta, clickCount };
    }

    for (const staff of this.peers.values()) {
      if (staff.isStaff) {
        this.io.to(staff.socketId).emit('ctaClicks', { ctaId: cta.id, clickCount });
      }
    }

    return clickCount;
  }

  /* ── spotlight & mute-all ────────────────────────────────── */

  /**
   * Pins one peer to the large tile for everyone. `null` clears it.
   *
   * Spotlight is room state, not per-viewer state: the point is that the host
   * decides what the audience is looking at, so it is broadcast rather than
   * stored on the requesting socket.
   */
  setSpotlight(peerId: string | null): void {
    if (peerId && !this.peers.has(peerId)) {
      throw new Error('That participant has left');
    }
    this.spotlightedPeerId = peerId;
    this.io.to(this.roomName()).emit('spotlightChanged', { peerId });
  }

  getSpotlight(): string | null {
    return this.spotlightedPeerId;
  }

  /**
   * Mutes every non-staff microphone.
   *
   * The server cannot mute a client's hardware, so this asks each affected
   * peer to pause its audio producers. The count returned is how many were
   * actually asked, which is what the host's toast reports.
   */
  muteAll(): number {
    let muted = 0;
    for (const peer of this.peers.values()) {
      if (isStaffRole(peer.role)) continue;
      if (!peer.isApprovedSpeaker) continue;
      this.io.to(peer.socketId).emit('forceMute');
      muted += 1;
    }
    return muted;
  }

  /* ── recording ───────────────────────────────────────────── */

  get isRecording(): boolean {
    return Boolean(this.recorder?.isRecording);
  }

  /**
   * Starts capturing the session.
   *
   * The timeline is always recorded. Media is attempted only when a host
   * video producer exists, because there is nothing to mux otherwise — and
   * spawning FFmpeg against an empty RTP port just produces a zero-byte file.
   */
  async startRecording(): Promise<string> {
    if (this.recorder?.isRecording) {
      throw new Error('Already recording');
    }

    const recorder = new Recorder(this.webinarId);
    this.recorder = recorder;

    const id = await recorder.begin();

    // Announce before the media attempt so the REC badge appears immediately
    // rather than after FFmpeg's startup delay.
    this.io.to(this.roomName()).emit('recordingState', {
      recording: true,
      startedAt: recorder.startedAt,
    });
    this.pushSystemMessage('Recording started');

    void this.attachMedia(recorder);

    return id;
  }

  /**
   * Best-effort media capture. Runs detached so a slow or missing FFmpeg never
   * delays the host's `recordingStart` acknowledgement.
   */
  private async attachMedia(recorder: Recorder): Promise<void> {
    try {
      const host = this.peers.get(this.hostPeerId() ?? '');
      const videoProducer = host
        ? [...host.producers.values()].find((p) => p.kind === 'video')
        : undefined;

      if (!videoProducer) {
        log.info(`No host video to record for "${this.slug}" — timeline only`);
        return;
      }

      const plain = await this.createPlainTransport();
      if (!plain) return;

      await plain.transport.consume({
        producerId: videoProducer.id,
        rtpCapabilities: this.router!.rtpCapabilities,
        paused: false,
      });

      const sdp = buildSdp(plain.port);
      const ok = await recorder.startMedia(sdp, plain.port);
      if (!ok) {
        plain.transport.close();
        return;
      }

      // Keep the transport alive for the duration of the recording.
      this.recordingTransports.push(plain.transport);
    } catch (err) {
      log.warn('Could not attach media recording', err);
    }
  }

  private hostPeerId(): string | null {
    for (const peer of this.peers.values()) {
      if (peer.userId === this.hostId) return peer.peerId;
    }
    return null;
  }

  /**
   * Creates a PlainTransport that sends RTP to a local UDP port FFmpeg reads.
   * Returns null when the router is not ready or the transport cannot be made.
   */
  private async createPlainTransport(): Promise<{
    transport: import('mediasoup/types').PlainTransport;
    port: number;
  } | null> {
    const router = this.router;
    if (!router) return null;

    const port = await findFreeUdpPort();
    const transport = await router.createPlainTransport({
      listenIp: '127.0.0.1',
      rtcpMux: true,
      comedia: false,
    });

    await transport.connect({ ip: '127.0.0.1', port });

    return { transport, port };
  }

  async stopRecording(): Promise<{ recordingId: string; durationMs: number }> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('Not recording');

    const result = await recorder.stop();
    this.recorder = null;

    for (const transport of this.recordingTransports) {
      transport.close();
    }
    this.recordingTransports = [];

    this.io.to(this.roomName()).emit('recordingState', { recording: false });
    this.pushSystemMessage('Recording stopped');

    return result;
  }

  /* ── snapshot ────────────────────────────────────────────── */

  snapshotFor(peer: Peer): RoomSnapshot {
    const policy = this.visibilityPolicy();
    const visiblePeers = [...this.peers.values()]
      .filter((p) => p.peerId !== peer.peerId)
      .filter((p) => canSeePeer(peer, p, policy))
      .map((p) => p.toInfo());

    return {
      webinarId: this.webinarId,
      slug: this.slug,
      title: this.title,
      status: this.status as RoomSnapshot['status'],
      settings: this.settings,
      self: peer.toInfo(),
      peers: visiblePeers,
      viewerCount: this.peers.size,
      hands: isStaffRole(peer.role) ? this.getHandList() : [],
      activeQuiz: this.getActiveQuiz(),
      activePoll: this.getActivePoll(),
      activeCta: this.getActiveCta(),
      // The snapshot is synchronous, so the queue is filled in by the caller
      // right after join — see `sendQuestionsTo`.
      questions: [],
      spotlightedPeerId: this.spotlightedPeerId,
      recording: this.isRecording,
      startedAt: this.startedAt,
      // A watermark is only useful if the viewer cannot switch it off, so the
      // flag travels with the snapshot and the client renders it unconditionally.
      watermark: this.settings.watermarkEnabled
        ? { enabled: true, label: peer.name, userId: peer.userId }
        : null,
    };
  }

  /** Pushes the Q&A queue to one peer. Called after join, once the socket is
   *  in the room and can receive the broadcast. */
  async sendQuestionsTo(peer: Peer): Promise<void> {
    const questions = await this.getQuestions(peer.userId);
    this.io.to(peer.socketId).emit('qaList', questions);
  }

  broadcastViewerCount() {
    // A host may hide the headcount from the audience. Staff always see it —
    // they need it to run the room — so the broadcast is split rather than
    // suppressed.
    if (this.settings.showLiveUsersCount) {
      this.io.to(this.roomName()).emit('viewerCount', this.peers.size);
      return;
    }

    for (const peer of this.peers.values()) {
      if (isStaffRole(peer.role)) {
        this.io.to(peer.socketId).emit('viewerCount', this.peers.size);
      }
    }
  }

  broadcastPeerUpdated(peer: Peer) {
    // `peerUpdated` goes to the peer itself as well: the client keeps its own
    // entry in the same map as everyone else, and a peer that never hears its
    // own state change would show a stale mic/camera badge.
    this.broadcastPeerToVisible(peer, 'peerUpdated', { includeSelf: true });
  }

  /**
   * Sends a peer's info only to the peers allowed to see them.
   *
   * A room-wide broadcast would leak the roster: with
   * `showParticipantsToEachOther` off, a participant must not learn that
   * another participant exists, let alone their name. The snapshot already
   * filters this way, so the live events have to match or the two disagree the
   * moment someone joins.
   */
  broadcastPeerToVisible(
    peer: Peer,
    event: 'peerJoined' | 'peerUpdated',
    opts: { includeSelf?: boolean } = {}
  ) {
    const policy = this.visibilityPolicy();
    const info = peer.toInfo();
    for (const viewer of this.peers.values()) {
      const isSelf = viewer.peerId === peer.peerId;
      if (isSelf && !opts.includeSelf) continue;
      // A peer always sees itself — `canSeePeer` answers "may this viewer see
      // that other person", and a participant is not a stranger to themselves.
      if (!isSelf && !canSeePeer(viewer, peer, policy)) continue;
      this.io.to(viewer.socketId).emit(event, info);
    }
  }

  /**
   * Asks one participant to turn their mic or camera on.
   *
   * Deliberately a request rather than a command. The server cannot enable a
   * device it does not control, and turning on a stranger's camera without
   * their consent would be a serious privacy violation — so the participant
   * gets a prompt and decides. Returns the target's name so the host's toast
   * can say who was asked.
   */
  requestMedia(userId: string, kind: 'mic' | 'cam', byName: string): string {
    const target = this.getPeerByUserId(userId);
    if (!target) throw new Error('That participant has left');
    this.io.to(target.socketId).emit('mediaRequested', { kind, by: byName });
    return target.name;
  }

  endWebinar() {
    this.status = 'ENDED';
    this.io.to(this.roomName()).emit('webinarEnded');
  }

  /**
   * Opens the session for everyone waiting in the room.
   *
   * Idempotent: a host who double-clicks, or a second host who arrives late,
   * must not reset the clock or re-fire the event — participants would see the
   * waiting screen flash back over a session that is already running.
   */
  startWebinar(): number {
    if (this.startedAt !== null) return this.startedAt;

    this.startedAt = Date.now();
    this.status = 'LIVE';
    this.io.to(this.roomName()).emit('webinarStarted', { startedAt: this.startedAt });
    this.pushSystemMessage('The webinar has started');
    return this.startedAt;
  }

  /** True once the host has opened the session. */
  get hasStarted(): boolean {
    return this.startedAt !== null;
  }

  /**
   * Re-reads the start state from the database.
   *
   * A Room outlives the row it was built from: an admin can reset a webinar
   * back to its waiting state while people are still connected. Without this
   * the in-memory clock would keep reporting the old start and the reset would
   * appear to do nothing until the last peer left.
   */
  syncStartedAt(startedAt: Date | null | undefined, status: string) {
    if (startedAt) this.startedAt = startedAt.getTime();
    else if (status === 'LIVE') this.startedAt ??= Date.now();
    else this.startedAt = null;
  }
}

/* ── recording helpers ─────────────────────────────────────── */

/**
 * Picks a free UDP port for the PlainTransport.
 *
 * Binding a throwaway socket and reading back the assigned port is the only
 * reliable way to avoid a collision — probing with a fixed range races against
 * anything else on the machine.
 */
async function findFreeUdpPort(): Promise<number> {
  const { createSocket } = await import('node:dgram');
  return new Promise<number>((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.on('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = typeof address === 'object' ? address.port : 0;
      socket.close(() => resolve(port));
    });
  });
}

/**
 * Builds the SDP that tells FFmpeg where to listen.
 *
 * The payload type and codec name must match what mediasoup negotiated, or
 * FFmpeg will discard every packet as an unknown format. VP8 is the codec the
 * router is configured with, so it is hard-coded here rather than guessed.
 */
function buildSdp(port: number): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=NexaLive recording',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    'm=video ' + port + ' RTP/AVP 96',
    'a=rtpmap:96 VP8/90000',
    'a=recvonly',
    '',
  ].join('\r\n');
}
