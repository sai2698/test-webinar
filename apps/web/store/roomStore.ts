'use client';

import { create } from 'zustand';
import type {
  ChatMessagePayload,
  HandRaiseEntry,
  MediaSource,
  PeerInfo,
  QuizResults,
  PublicQuiz,
  PublicPoll,
  PollResults,
  CtaPayload,
  QaQuestionPayload,
  Role,
} from '@webinar/shared';
import type { BackgroundMode } from '@/lib/backgroundEffects';
import type { VideoFit } from '@/lib/mediaPrefs';

export interface RemoteStream {
  peerId: string;
  userId: string;
  producerId: string;
  kind: 'audio' | 'video';
  source: MediaSource;
  stream: MediaStream;
  paused: boolean;
}

interface RoomState {
  /* identity */
  peerId: string | null;
  userId: string | null;
  name: string | null;
  role: Role | null;
  isApprovedSpeaker: boolean;
  /** Webinar being attended — needed by the host panel to load quizzes/CTAs. */
  webinarId: string | null;
  /** The webinar's title, shown on the waiting screen and in the header. */
  title: string | null;

  /* connection */
  connected: boolean;
  joining: boolean;
  error: string | null;

  /* peers & media */
  peers: Record<string, PeerInfo>;
  /**
   * This viewer's own peer record.
   *
   * The server's snapshot deliberately leaves self out of `peers` — the video
   * grid renders the local tile from `localStream` instead. The participant
   * list, though, is a roster: leaving yourself out of it makes a room with one
   * person in it look empty, and hides your own mic/camera state from you.
   */
  self: PeerInfo | null;
  remoteStreams: Record<string, RemoteStream>;
  localStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  screenSharing: boolean;
  /** Local display-capture stream, used for the sharer's own preview. */
  screenStream: MediaStream | null;

  /* media effects */
  /**
   * The virtual background currently applied to the outgoing camera.
   *
   * `off` is the honest default: an effect that failed to load falls back to
   * it, so the UI never claims a blur that is not happening.
   */
  backgroundMode: BackgroundMode;
  /** True while the segmentation model is loading or a mode change is in flight. */
  backgroundBusy: boolean;
  /** Set when an effect could not be applied, so the panel can explain why. */
  backgroundError: string | null;
  /** Whether the spectral-gate worklet is processing the microphone. */
  noiseSuppression: boolean;
  /** Native browser echo cancellation. */
  echoCancellation: boolean;
  /** Native browser automatic gain control. */
  autoGainControl: boolean;
  /** Requested camera frame rate, applied as a track constraint. */
  frameRate: number;
  /** How the local preview and remote tiles fit the video into their box. */
  videoFit: VideoFit;
  /** Mirrors the local preview only — peers always see the unmirrored frame. */
  mirror: boolean;

  /* engagement */
  messages: ChatMessagePayload[];
  hands: HandRaiseEntry[];
  viewerCount: number;
  /**
   * Per-viewer watermark, or `null` when the host has not enabled one. The
   * label carries this viewer's own name so a leaked screen recording can be
   * traced back to the account that made it.
   */
  watermark: { enabled: boolean; label: string; userId: string } | null;
  /**
   * When false the host has hidden the headcount from participants. Staff still
   * receive it — they need the number to run the room — so the chip is hidden
   * per-role rather than the value being suppressed.
   */
  showLiveUsersCount: boolean;
  /**
   * Which sidebar tabs the audience may see. Staff always see all of them, so
   * these are read only when the viewer is a participant.
   */
  showPeopleTab: boolean;
  showQaTab: boolean;
  showPollsTab: boolean;
  /**
   * Whether the audience may see and hear each other. Off by default — a
   * webinar is a broadcast. Staff are mutually visible either way.
   */
  showParticipantsToEachOther: boolean;
  activeQuiz: PublicQuiz | null;
  quizResults: QuizResults | null;
  activePoll: PublicPoll | null;
  pollResults: PollResults | null;
  activeCta: CtaPayload | null;
  /**
   * Live click tallies per offer id, staff only.
   *
   * Kept beside `activeCta` rather than inside it because the host panel lists
   * every offer, not just the one on screen — a tally that only existed on the
   * active offer would go stale the moment the host hid it.
   */
  ctaClickCounts: Record<string, number>;
  /** The Q&A queue, already ordered by the server: pinned, then upvotes, then newest. */
  questions: QaQuestionPayload[];
  /** The peer the host has pinned to the big tile, if any. */
  spotlightedPeerId: string | null;
  /**
   * A pending request from a host to turn on this peer's mic or camera.
   * Cleared when the participant accepts or dismisses it.
   */
  mediaRequest: { kind: 'mic' | 'cam'; by: string } | null;
  ended: boolean;
  /** True while the host is capturing the session — drives the REC badge. */
  recording: boolean;
  /**
   * When the host opened the session, or `null` while it is still waiting.
   *
   * Participants are let into the room before the host starts, so the UI has
   * to tell "the room is empty" apart from "the session has not begun".
   */
  startedAt: number | null;

  /* actions */
  set: (patch: Partial<RoomState>) => void;
  reset: () => void;
  upsertPeer: (peer: PeerInfo) => void;
  removePeer: (peerId: string) => void;
  addMessage: (msg: ChatMessagePayload) => void;
  removeMessage: (id: string) => void;
  setEnrolled: (userId: string, enrolled: boolean) => void;
  setRemoteStream: (s: RemoteStream) => void;
  removeRemoteStream: (producerId: string) => void;
  removeStreamsFromPeer: (peerId: string) => void;
  setCtaClickCount: (ctaId: string, count: number) => void;
}

const initial = {
  peerId: null,
  userId: null,
  name: null,
  role: null,
  isApprovedSpeaker: false,
  webinarId: null,
  title: null,
  connected: false,
  joining: false,
  error: null,
  peers: {},
  self: null,
  remoteStreams: {},
  localStream: null,
  micOn: false,
  camOn: false,
  screenSharing: false,
  screenStream: null,
  backgroundMode: 'off' as BackgroundMode,
  backgroundBusy: false,
  backgroundError: null,
  noiseSuppression: false,
  echoCancellation: true,
  autoGainControl: true,
  frameRate: 30,
  videoFit: 'cover' as VideoFit,
  mirror: true,
  messages: [],
  hands: [],
  viewerCount: 0,
  watermark: null,
  showLiveUsersCount: true,
  showPeopleTab: false,
  showQaTab: false,
  showPollsTab: false,
  showParticipantsToEachOther: false,
  activeQuiz: null,
  quizResults: null,
  activePoll: null,
  pollResults: null,
  activeCta: null,
  ctaClickCounts: {},
  questions: [],
  spotlightedPeerId: null,
  mediaRequest: null,
  ended: false,
  recording: false,
  startedAt: null,
};

export const useRoomStore = create<RoomState>((set) => ({
  ...initial,

  set: (patch) => set(patch),
  reset: () => set({ ...initial }),

  upsertPeer: (peer) =>
    set((s) =>
      // A peerUpdated for our own peerId is our own state coming back to us.
      // Keep `self` in step so the roster row for "you" stays honest.
      peer.peerId === s.peerId
        ? { self: peer }
        : { peers: { ...s.peers, [peer.peerId]: peer } }
    ),

  removePeer: (peerId) =>
    set((s) => {
      const peers = { ...s.peers };
      delete peers[peerId];
      const remoteStreams: Record<string, RemoteStream> = {};
      for (const [id, rs] of Object.entries(s.remoteStreams)) {
        if (rs.peerId !== peerId) remoteStreams[id] = rs;
      }
      return { peers, remoteStreams };
    }),

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages.slice(-299), msg] })),

  removeMessage: (id) =>
    set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),

  // The enrolled badge is per-user, but it is rendered per-message, so a
  // purchase has to rewrite every message that user already sent.
  setEnrolled: (userId, enrolled) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.userId === userId ? { ...m, enrolled } : m)),
    })),

  setRemoteStream: (rs) =>
    set((s) => ({ remoteStreams: { ...s.remoteStreams, [rs.producerId]: rs } })),

  removeRemoteStream: (producerId) =>
    set((s) => {
      const remoteStreams = { ...s.remoteStreams };
      delete remoteStreams[producerId];
      return { remoteStreams };
    }),

  removeStreamsFromPeer: (peerId) =>
    set((s) => {
      const remoteStreams: Record<string, RemoteStream> = {};
      for (const [id, rs] of Object.entries(s.remoteStreams)) {
        if (rs.peerId !== peerId) remoteStreams[id] = rs;
      }
      return { remoteStreams };
    }),

  setCtaClickCount: (ctaId, count) =>
    set((s) => ({ ctaClickCounts: { ...s.ctaClickCounts, [ctaId]: count } })),
}));
