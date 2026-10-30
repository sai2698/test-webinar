'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useRoomStore } from '@/store/roomStore';
import { useMediasoup } from '@/lib/useMediasoup';
import { VideoGrid } from '@/components/VideoGrid';
import { RemoteAudio } from '@/components/RemoteAudio';
import { ChatPanel } from '@/components/ChatPanel';
import { ParticipantList } from '@/components/ParticipantList';
import { ControlsBar } from '@/components/ControlsBar';
import { QuizModal } from '@/components/QuizModal';
import { PollModal } from '@/components/PollModal';
import { PollsPanel } from '@/components/PollsPanel';
import { QaPanel } from '@/components/QaPanel';
import { CtaOverlay } from '@/components/CtaOverlay';
import { EnrollmentBanner } from '@/components/EnrollmentBanner';
import { HostPanel } from '@/components/HostPanel';
import { JoinGate } from '@/components/JoinGate';
import { MediaRequestPrompt } from '@/components/MediaRequestPrompt';
import { PendingApproval } from '@/components/PendingApproval';
import { WaitingRoom } from '@/components/WaitingRoom';
import { WatermarkOverlay } from '@/components/WatermarkOverlay';
import { Logo } from '@/components/Logo';
import { endpoints } from '@/lib/api';
import { roomToken } from '@/lib/session';

type Tab = 'chat' | 'people' | 'qa' | 'polls';

export default function RoomPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params?.slug ?? '';

  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Set when the visitor arrived on a shared link and we still need a name and
  // mobile before the socket may connect.
  const [gateToken, setGateToken] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  // On a phone the sidebar is a full-screen overlay, so opening it by default
  // would hide the video entirely — start closed there and open on desktop.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // The stage element is what goes fullscreen — not the whole page, so the
  // chat sidebar and control bar stay out of the presentation.
  const stageRef = useRef<HTMLDivElement | null>(null);

  const store = useRoomStore;
  const connected = useRoomStore((s) => s.connected);
  const joining = useRoomStore((s) => s.joining);
  const error = useRoomStore((s) => s.error);
  const ended = useRoomStore((s) => s.ended);
  const viewerCount = useRoomStore((s) => s.viewerCount);
  const showLiveUsersCount = useRoomStore((s) => s.showLiveUsersCount);
  const recording = useRoomStore((s) => s.recording);
  const hands = useRoomStore((s) => s.hands);
  const role = useRoomStore((s) => s.role);
  const userId = useRoomStore((s) => s.userId);
  const startedAt = useRoomStore((s) => s.startedAt);
  const webinarTitle = useRoomStore((s) => s.title);
  const title = useRoomStore((s) => s.peers[s.peerId ?? '']?.name ?? '');

  const handRaised = useMemo(
    () => Boolean(userId && hands.some((h) => h.userId === userId)),
    [hands, userId]
  );

  const questions = useRoomStore((s) => s.questions);
  const openQuestions = useMemo(
    () => questions.filter((q) => !q.answered).length,
    [questions]
  );

  const isStaff = role === 'HOST' || role === 'ADMIN' || role === 'MODERATOR';

  /**
   * Which sidebar tabs this viewer may open.
   *
   * Staff always get all four — they need the roster, the question queue and
   * the poll list to run the room. The audience only gets what the host turned
   * on when creating the webinar, and all three default to off: a broadcast
   * should not hand every viewer the attendee list, and an empty Q&A queue or
   * poll list reads as a broken feature rather than an unused one.
   */
  const showPeopleTab = useRoomStore((s) => s.showPeopleTab);
  const showQaTab = useRoomStore((s) => s.showQaTab);
  const showPollsTab = useRoomStore((s) => s.showPollsTab);
  const canSeePeople = isStaff || showPeopleTab;
  const canSeeQa = isStaff || showQaTab;
  const canSeePolls = isStaff || showPollsTab;

  /**
   * The tab actually rendered.
   *
   * The snapshot arrives after the first paint, so `tab` can point at a tab
   * that turns out to be hidden — a participant who reloads while on Q&A would
   * otherwise land on a blank panel with no way back. Falling back to chat
   * keeps the sidebar always showing something.
   */
  const activeTab: Tab =
    (tab === 'people' && !canSeePeople) ||
    (tab === 'qa' && !canSeeQa) ||
    (tab === 'polls' && !canSeePolls)
      ? 'chat'
      : tab;

  /**
   * Whether this viewer may publish media at all.
   *
   * Subscribed rather than read from `getState()` so the chat's device picker
   * and the control bar agree the moment a host approves a speaker — a
   * participant who has not been approved has no microphone to switch, and
   * offering one would be a dead control.
   */
  const isApprovedSpeaker = useRoomStore((s) => s.isApprovedSpeaker);
  const canPublish = role !== 'PARTICIPANT' || isApprovedSpeaker;

  /**
   * Participants may join before the host opens the session. Until then the
   * stage shows a waiting screen instead of an empty video grid — an empty
   * grid with a spinner reads as a broken page, not as "not started yet".
   * Staff always see the real room so they can get ready.
   */
  const waiting = !isStaff && startedAt === null;

  /**
   * The badge describes the session, not the viewer.
   *
   * Staff see the real room while it is still closed, so keying the badge off
   * `waiting` would show them a red pulsing LIVE over a session nobody has
   * opened yet — and they are the one person who can tell it is not true.
   */
  const notStarted = startedAt === null;

  useEffect(() => {
    // A join link from a confirmation or reminder email carries the token in
    // the query string, because the recipient may be on a device that has
    // never seen this site. Adopt it into localStorage so a refresh — or a
    // later visit without the query string — still works, then strip it from
    // the address bar so the token does not linger in history or get pasted
    // into a chat by accident.
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    if (fromQuery) {
      // A shared link always goes through the gate: the recipient may be on a
      // device that has never seen this site, and we want a name and mobile on
      // file before they enter the room.
      window.history.replaceState(null, '', window.location.pathname);
      setGateToken(fromQuery);
      return;
    }

    const t = roomToken();
    if (!t) {
      router.replace(`/w/${slug}`);
      return;
    }
    setToken(t);
    setReady(true);
  }, [router, slug]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const {
    join,
    toggleMic,
    toggleCam,
    toggleScreenShare,
    switchDevice,
    setBackground,
    uploadBackground,
    setNoiseSuppression,
    setEchoCancellation,
    setAutoGainControl,
    setFrameRate,
    setVideoFit,
    setMirror,
    socket,
  } = useMediasoup({
    slug,
    token: token ?? '',
    onError: showToast,
  });

  useEffect(() => {
    if (ready && token) void join();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, token]);

  /**
   * The scheduled start time, for the waiting-room countdown.
   *
   * It is not in `RoomSnapshot` — the snapshot describes the live session, and
   * the schedule is a property of the webinar, not of the room. Fetching it
   * here keeps the socket contract unchanged and costs one request that the
   * participant's browser would make anyway.
   *
   * A failure is swallowed: a missing countdown is a cosmetic loss, and the
   * waiting room still says the host will begin shortly.
   */
  const [startsAt, setStartsAt] = useState<string | null>(null);
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    endpoints
      .publicWebinar(slug)
      .then((res) => {
        if (!cancelled) setStartsAt(res.webinar.startsAt || null);
      })
      .catch(() => {
        /* the countdown is optional */
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // The sidebar is a permanent column from `lg` up and an overlay below it.
  // Match the initial state to the viewport so a desktop visitor still lands
  // on chat, and a phone visitor lands on the video.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setSidebarOpen(window.matchMedia('(min-width: 1024px)').matches);
  }, []);

  function leave() {
    store.getState().reset();
    router.push(`/w/${slug}`);
  }

  if (gateToken) {
    return (
      <JoinGate
        slug={slug}
        token={gateToken}
        onReady={(jwt) => {
          setGateToken(null);
          setToken(jwt);
          setReady(true);
        }}
      />
    );
  }

  if (!ready || joining) {
    return (
      <main className="grid min-h-screen place-items-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-12 w-12 animate-spin rounded-full border-2 border-white/10 border-t-brand-400" />
          </div>
          <p className="text-sm text-slate-400">Connecting to the live room…</p>
        </div>
      </main>
    );
  }

  if (error && !connected) {
    // A pending registration is not a failure — it is a queue. Showing the
    // generic error card here would read like a bug and invite a support call.
    if (/awaiting host approval|not approved/i.test(error)) {
      return <PendingApproval slug={slug} title={webinarTitle ?? undefined} />;
    }

    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="card max-w-md p-8 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-red-500/15 text-red-400">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5m0 3.5v.5" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-white">Could not join</h1>
          <p className="mt-2 text-sm text-slate-400">{error}</p>
          <Link href={`/w/${slug}`} className="btn-ghost mt-6">
            Back to webinar page
          </Link>
        </div>
      </main>
    );
  }

  if (ended) {
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="card max-w-md p-8 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-brand-500/15 text-brand-300">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M5 12h14M12 5v14" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-white">Session ended</h1>
          <p className="mt-2 text-sm text-slate-400">
            {error ?? 'Thanks for joining — see you at the next one.'}
          </p>
          <Link href="/" className="btn-primary mt-6">
            Explore more webinars
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-ink-950">
      {/* ── top bar ─────────────────────────────────────── */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-ink-900/60 px-4 py-2.5 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-3">
          <Logo href="/" />
          <div className="hidden h-5 w-px bg-white/10 sm:block" />
          <div className="hidden min-w-0 sm:block">
            <p className="truncate text-xs font-medium text-slate-300">{title || 'Live room'}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* The badge has to tell the truth: a session nobody has opened is
              not live, and a red pulsing LIVE chip would contradict the
              waiting screen in front of a participant. */}
          {notStarted ? (
            <span className="chip border-white/15 bg-white/5 py-1 text-[10px] text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
              WAITING
            </span>
          ) : (
            <span className="chip border-red-500/30 bg-red-500/15 py-1 text-[10px] text-red-300">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-400" />
              </span>
              LIVE
            </span>
          )}
          {recording && (
            <span
              className="chip border-amber-500/30 bg-amber-500/15 py-1 text-[10px] text-amber-300"
              title="This session is being recorded"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              REC
            </span>
          )}
          {/* The host can hide the headcount from the audience. Staff still get
              the number — they need it to run the room — so this is a per-role
              hide, not a suppressed value. */}
          {(showLiveUsersCount || isStaff) && (
            <span className="chip py-1 text-[10px]">
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="8.5" r="3.5" />
                <path d="M5 19.5c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" strokeLinecap="round" />
              </svg>
              {viewerCount}
            </span>
          )}
          {isStaff && <HostPanel socket={socket} />}
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="btn-ghost px-2.5 py-1.5 text-xs lg:hidden"
            aria-label="Toggle sidebar"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── body ────────────────────────────────────────── */}
      {/* `relative` anchors the mobile sidebar overlay to the room body rather
          than the viewport, so it never covers the header. */}
      <div className="relative flex min-h-0 flex-1">
        {/* stage */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* `relative` is what the offer card anchors to. It has to be the
              stage rather than the page: a viewport-fixed card ignores the
              sidebar and covers the control bar on a phone. */}
          <div className="relative min-h-0 flex-1 p-3" ref={stageRef}>
            {waiting ? <WaitingRoom title={webinarTitle ?? ''} startsAt={startsAt} /> : <VideoGrid />}
            {/* Remote audio is a separate producer from remote video, so it
                needs its own sink. Mounted outside the grid on purpose: it must
                keep playing while the stage shows the waiting room, and it must
                not unmount when a tile scrolls out of view. */}
            <RemoteAudio />
            <WatermarkOverlay />
            <EnrollmentBanner />
            <CtaOverlay />
          </div>

          <div className="shrink-0 px-3 pb-3">
            <ControlsBar
              socket={socket}
              onToggleMic={toggleMic}
              onToggleCam={toggleCam}
              onShareScreen={toggleScreenShare}
              onLeave={leave}
              canPublish={canPublish}
              handRaised={handRaised}
              onSwitchDevice={switchDevice}
              stageRef={stageRef}
              onSetBackground={setBackground}
              onUploadBackground={uploadBackground}
              onSetNoiseSuppression={setNoiseSuppression}
              onSetEchoCancellation={setEchoCancellation}
              onSetAutoGainControl={setAutoGainControl}
              onSetFrameRate={setFrameRate}
              onSetVideoFit={setVideoFit}
              onSetMirror={setMirror}
            />
          </div>
        </div>

        {/* sidebar */}
        {/* Below `lg` this is a full-screen overlay over the stage; from `lg`
            up it is a permanent column. The breakpoint matches the header
            toggle (`lg:hidden`) and the initial-state effect. */}
        <aside
          className={`shrink-0 border-l border-white/10 bg-ink-900 backdrop-blur-xl transition-all duration-300 lg:bg-ink-900/50 ${
            sidebarOpen ? 'w-full lg:w-[340px]' : 'w-0 overflow-hidden'
          } ${sidebarOpen ? 'absolute inset-0 z-30 lg:static' : ''}`}
        >
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-stretch border-b border-white/10">
              <button
                onClick={() => setTab('chat')}
                className={`flex-1 px-4 py-2.5 text-xs font-semibold transition ${
                  activeTab === 'chat'
                    ? 'border-b-2 border-brand-400 text-white'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Chat
              </button>
              {canSeePeople && (
                <button
                  onClick={() => setTab('people')}
                  className={`flex-1 px-4 py-2.5 text-xs font-semibold transition ${
                    activeTab === 'people'
                      ? 'border-b-2 border-brand-400 text-white'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  People
                  {hands.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-accent-500/25 px-1.5 py-px text-[9px] font-bold text-accent-400">
                      {hands.length}
                    </span>
                  )}
                </button>
              )}
              {canSeeQa && (
                <button
                  onClick={() => setTab('qa')}
                  className={`flex-1 px-3 py-2.5 text-xs font-semibold transition ${
                    activeTab === 'qa'
                      ? 'border-b-2 border-brand-400 text-white'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Q&amp;A
                  {openQuestions > 0 && (
                    <span className="ml-1.5 rounded-full bg-brand-500/25 px-1.5 py-px text-[9px] font-bold text-brand-300">
                      {openQuestions}
                    </span>
                  )}
                </button>
              )}
              {canSeePolls && (
                <button
                  onClick={() => setTab('polls')}
                  className={`flex-1 px-3 py-2.5 text-xs font-semibold transition ${
                    activeTab === 'polls'
                      ? 'border-b-2 border-brand-400 text-white'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Polls
                </button>
              )}
              <button
                onClick={() => setSidebarOpen(false)}
                className="shrink-0 px-3 text-slate-500 transition hover:text-white lg:hidden"
                aria-label="Close sidebar"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="min-h-0 flex-1">
              {activeTab === 'chat' ? (
                <ChatPanel
                  socket={socket}
                  slug={slug}
                  onSwitchDevice={canPublish ? switchDevice : undefined}
                />
              ) : activeTab === 'people' ? (
                <ParticipantList socket={socket} />
              ) : activeTab === 'qa' ? (
                <QaPanel socket={socket} />
              ) : (
                <PollsPanel socket={socket} />
              )}
            </div>
          </div>
        </aside>
      </div>

      <QuizModal socket={socket} />
      <PollModal socket={socket} />

      {/* A host asked this participant to turn something on. Accepting runs the
          same toggle the control bar uses, so the result is identical to the
          participant pressing the button themselves. */}
      <MediaRequestPrompt
        onAccept={(kind) => {
          if (kind === 'mic') void toggleMic(true);
          else void toggleCam();
        }}
      />

      {toast && (
        <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-up rounded-xl border border-white/10 bg-ink-800 px-4 py-2.5 text-xs font-medium text-slate-200 shadow-xl">
          {toast}
        </div>
      )}
    </main>
  );
}
