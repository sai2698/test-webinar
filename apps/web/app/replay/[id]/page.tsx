'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type {
  ChatMessagePayload,
  CtaPayload,
  PollResults,
  PublicPoll,
  PublicQuiz,
  QaQuestionPayload,
  QuizResults,
  RecordingDetail,
  Role,
  TimelineEvent,
} from '@webinar/shared';
import { Logo } from '@/components/Logo';
import { useFullscreen } from '@/lib/useRoomUi';
import { API_URL, endpoints } from '@/lib/api';

/** Playback speeds offered in the transport bar. */
const SPEEDS = [0.5, 1, 1.5, 2] as const;

type Tab = 'chat' | 'people' | 'qa' | 'polls';

/**
 * Replay of a recorded session, presented as a live room.
 *
 * The recording is a timeline, not a video: every chat message, quiz, poll,
 * offer and hand raise carries a millisecond offset from the start of the
 * session. Playing the replay means advancing a clock and applying each event
 * as the clock passes it.
 *
 * The page deliberately reuses the live room's chrome — the same header, the
 * same stage, the same Chat / People / Polls sidebar, the same control bar —
 * because a replay that looks like a transcript page reads as an archive. A
 * replay that looks like the room reads as a session you are attending. It
 * auto-plays on load for the same reason: a visitor arriving on the link should
 * walk into a session in progress, not a paused player.
 *
 * Media is optional. When the host published video and FFmpeg was available the
 * MP4 is the master clock, so the timeline stays in sync with the picture. When
 * there is no media the timeline drives itself off a wall clock at the same
 * speed, and the stage shows a presenter card instead of a black rectangle.
 */
export default function ReplayPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  const [data, setData] = useState<RecordingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState<Tab>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /**
   * Premiere mode. A pre-recorded webinar is the same recording presented as a
   * live session: the position comes from the server's premiere clock instead
   * of from a play button, and the transport bar is hidden because there is
   * nothing to scrub — you are attending, not reviewing.
   */
  const [live, setLive] = useState(false);
  const [liveStartedAt, setLiveStartedAt] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(stageRef);

  // Premiere mode is opt-in through the query string so one page serves both a
  // plain replay and a scheduled pre-recorded session. Reading it from
  // `window.location` rather than `useSearchParams` keeps the page out of a
  // Suspense boundary, which Next requires for that hook.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('live') !== '1') return;
    const startedAt = Number(q.get('startedAt'));
    setLive(true);
    setLiveStartedAt(Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null);
  }, []);

  /* ── load ─────────────────────────────────────────────────── */

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await endpoints.replayById(id);
        if (!cancelled) setData(res.recording);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the replay');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const durationMs = data?.durationMs ?? 0;
  const hasVideo = data?.mediaKind === 'video';

  /* ── clock ────────────────────────────────────────────────── */

  const tick = useCallback(() => {
    const video = videoRef.current;

    if (live && liveStartedAt) {
      // The premiere clock is absolute, so there is nothing to accumulate.
      setPositionMs(Math.min(Math.max(0, Date.now() - liveStartedAt), durationMs));
    } else if (video && hasVideo) {
      setPositionMs(video.currentTime * 1000);
    } else {
      const now = performance.now();
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;
      setPositionMs((prev) => Math.min(prev + delta * speed, durationMs));
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [hasVideo, durationMs, speed, live, liveStartedAt]);

  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }

    lastTickRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, tick]);

  // Stop at the end rather than spinning forever past the last event. A
  // premiere keeps running — the room is still open even after the recording
  // finishes, exactly as a live session would be.
  useEffect(() => {
    if (live) return;
    if (playing && durationMs > 0 && positionMs >= durationMs) {
      setPlaying(false);
      videoRef.current?.pause();
    }
  }, [playing, positionMs, durationMs, live]);

  // Playback speed applies to both clocks: the video element has its own rate,
  // the wall clock multiplies its delta in `tick`.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, hasVideo]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (playing) {
      video?.pause();
      setPlaying(false);
      return;
    }
    // Restarting from the end should replay from the top, not sit at the end.
    if (durationMs > 0 && positionMs >= durationMs) {
      setPositionMs(0);
      if (video) video.currentTime = 0;
    }
    void video?.play().catch(() => undefined);
    setPlaying(true);
  }, [playing, positionMs, durationMs]);

  const seek = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(ms, durationMs));
      setPositionMs(clamped);
      const video = videoRef.current;
      if (video) video.currentTime = clamped / 1000;
    },
    [durationMs]
  );

  // Walk into a session already in progress. Browsers block autoplay with
  // sound, so a video replay may stay paused until the visitor clicks — the
  // play overlay covers that case.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!data || startedRef.current) return;
    startedRef.current = true;

    // A premiere is already in progress, so join it where the room is rather
    // than at zero. This is the whole difference between a replay and a
    // premiere: the clock belongs to the event, not to the viewer.
    if (live && liveStartedAt) {
      const at = Math.min(Math.max(0, Date.now() - liveStartedAt), data.durationMs);
      setPositionMs(at);
      if (videoRef.current) videoRef.current.currentTime = at / 1000;
    }

    setPlaying(true);
    void videoRef.current?.play().catch(() => setPlaying(false));
  }, [data, live, liveStartedAt]);

  // Keep a premiere in step with the room clock. Drift is small but real — a
  // backgrounded tab throttles rAF — and a viewer who falls behind should
  // catch up rather than stay behind for the rest of the session.
  useEffect(() => {
    if (!live || !liveStartedAt || !data) return;
    const timer = window.setInterval(() => {
      const at = Math.min(Math.max(0, Date.now() - liveStartedAt), data.durationMs);
      setPositionMs(at);
      const video = videoRef.current;
      if (video && Math.abs(video.currentTime * 1000 - at) > 2000) {
        video.currentTime = at / 1000;
      }
    }, 15000);
    return () => window.clearInterval(timer);
  }, [live, liveStartedAt, data]);

  /* ── derived replay state ─────────────────────────────────── */

  // Quantise the clock for the derived state. The transport still shows the
  // exact position, but re-filtering the whole timeline 60 times a second to
  // move a progress bar is wasted work — 10 Hz is imperceptible here. The
  // first bucket keeps the exact position so a very short recording (a few
  // hundred milliseconds) still reveals the events it captured.
  const bucket = positionMs < 100 ? positionMs : Math.floor(positionMs / 100) * 100;

  const applied = useMemo(
    () => (data ? data.timeline.filter((e) => e.t <= bucket) : []),
    [data, bucket]
  );

  const chat = useMemo(
    () => applied.filter((e): e is Extract<TimelineEvent, { type: 'chat' }> => e.type === 'chat'),
    [applied]
  );

  // Same shape as the poll: the quiz stays on screen after it closes so the
  // final distribution is readable instead of flashing past.
  const activeQuiz = useMemo(() => {
    let quiz: PublicQuiz | null = null;
    let results: QuizResults | null = null;
    let closed = false;
    for (const e of applied) {
      if (e.type === 'quizStarted') {
        quiz = e.quiz;
        results = null;
        closed = false;
      } else if (e.type === 'quizResults') {
        results = e.results;
      } else if (e.type === 'quizClosed') {
        closed = true;
      }
    }
    return { quiz, results, closed };
  }, [applied]);

  const activeCta = useMemo(() => {
    let cta: CtaPayload | null = null;
    for (const e of applied) {
      if (e.type === 'ctaShown') cta = e.cta;
      else if (e.type === 'ctaHidden') cta = null;
    }
    return cta;
  }, [applied]);

  // A poll replays like a quiz: the question appears when it was launched, the
  // tally updates on every recorded vote, and closing freezes it. The poll is
  // kept after the close so the final result stays readable — a replay that
  // blanked the moment the host closed would hide the only interesting part.
  const activePoll = useMemo(() => {
    let poll: PublicPoll | null = null;
    let results: PollResults | null = null;
    let closed = false;
    for (const e of applied) {
      if (e.type === 'pollStarted') {
        poll = e.poll;
        results = null;
        closed = false;
      } else if (e.type === 'pollResults') {
        results = e.results;
        closed = e.results.closed;
      } else if (e.type === 'pollClosed') {
        closed = true;
      }
    }
    return { poll, results, closed };
  }, [applied]);

  const hands = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of applied) {
      if (e.type === 'handRaised') map.set(e.userId, e.name);
      else if (e.type === 'handLowered') map.delete(e.userId);
    }
    return [...map.values()];
  }, [applied]);

  // The room's participant list, rebuilt from the join/leave events. Names are
  // the only identity the timeline carries, so a name that leaves and rejoins
  // collapses into one row — which is what a viewer would expect anyway.
  const people = useMemo(() => {
    const map = new Map<string, Role>();
    for (const e of applied) {
      if (e.type === 'peerJoined') map.set(e.name, e.role);
      else if (e.type === 'peerLeft') map.delete(e.name);
    }
    return [...map.entries()].map(([name, role]) => ({ name, role }));
  }, [applied]);

  const viewers = people.length;

  // Every poll the session ran, with the tally it finished on. The sidebar tab
  // is a record of the session, so it lists polls that already closed too.
  const pollHistory = useMemo(() => {
    const order: string[] = [];
    const byId = new Map<string, { poll: PublicPoll; results: PollResults | null }>();
    for (const e of applied) {
      if (e.type === 'pollStarted') {
        if (!byId.has(e.poll.id)) order.push(e.poll.id);
        byId.set(e.poll.id, { poll: e.poll, results: null });
      } else if (e.type === 'pollResults') {
        const entry = byId.get(e.results.pollId);
        if (entry) entry.results = e.results;
      }
    }
    return order.map((pid) => byId.get(pid)!);
  }, [applied]);

  const presenter = useMemo(() => {
    const host = people.find((p) => p.role === 'HOST' || p.role === 'ADMIN');
    return host?.name ?? 'Presenter';
  }, [people]);

  // The Q&A queue as it stood at this point in the session. Questions arrive
  // over time and get answered later, so the panel has to replay both the
  // arrival and the answer rather than just listing the final state.
  const qaHistory = useMemo(() => {
    const order: string[] = [];
    const byId = new Map<
      string,
      { question: QaQuestionPayload; answered: boolean; pinned: boolean }
    >();
    for (const e of applied) {
      if (e.type === 'qaAsked') {
        if (!byId.has(e.question.id)) order.push(e.question.id);
        byId.set(e.question.id, { question: e.question, answered: false, pinned: false });
      } else if (e.type === 'qaAnswered') {
        const entry = byId.get(e.questionId);
        if (entry) entry.answered = true;
      } else if (e.type === 'qaPinned') {
        const entry = byId.get(e.questionId);
        if (entry) entry.pinned = e.pinned;
      }
    }
    return order.map((id) => byId.get(id)!);
  }, [applied]);

  const ended = durationMs > 0 && positionMs >= durationMs;

  /* ── render ───────────────────────────────────────────────── */

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-ink-950">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-2 border-white/10 border-t-brand-400" />
          <p className="text-sm text-slate-400">Loading the replay…</p>
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="grid min-h-screen place-items-center bg-ink-950 px-6">
        <div className="card max-w-md p-8 text-center">
          <h1 className="text-lg font-semibold text-white">Replay unavailable</h1>
          <p className="mt-2 text-sm text-slate-400">
            {error ?? 'This recording could not be found.'}
          </p>
          <Link href="/" className="btn-primary mt-6">
            Back to home
          </Link>
        </div>
      </main>
    );
  }

  const mediaUrl = `${API_URL}/api/recordings/${data.id}/media`;

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-ink-950">
      {/* ── top bar ─────────────────────────────────────── */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-ink-900/60 px-4 py-2.5 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-3">
          <Logo href="/" />
          <div className="hidden h-5 w-px bg-white/10 sm:block" />
          <div className="hidden min-w-0 sm:block">
            <p className="truncate text-xs font-medium text-slate-300">
              {data.webinar?.title ?? 'Recorded session'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="chip border-brand-500/30 bg-brand-500/15 py-1 text-[10px] text-brand-200">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-400" />
            </span>
            {live ? 'LIVE' : 'REPLAY'}
          </span>

          {/* A replay is not a room, so a headcount of "0" is noise rather
              than information. The chip only earns its place when the
              timeline actually recorded people joining. */}
          {viewers > 0 && (
            <span className="chip hidden py-1 text-[10px] sm:inline-flex">
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" strokeLinecap="round" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" strokeLinecap="round" />
              </svg>
              {viewers}
            </span>
          )}

          {data.webinar && (
            <Link
              href={`/w/${data.webinar.slug}`}
              className="btn-ghost hidden px-2.5 py-1.5 text-xs sm:inline-flex"
            >
              Webinar page
            </Link>
          )}

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

      <div className="relative flex min-h-0 flex-1">
        {/* ── stage column ──────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 p-3">
            <div
              ref={stageRef}
              className="relative h-full overflow-hidden rounded-2xl border border-white/10 bg-black"
            >
              {hasVideo ? (
                <video
                  ref={videoRef}
                  src={mediaUrl}
                  className="h-full w-full bg-black object-contain"
                  playsInline
                  onEnded={() => setPlaying(false)}
                />
              ) : (
                <PresenterCard
                  title={data.webinar?.title ?? 'Recorded session'}
                  presenter={presenter}
                />
              )}

              {/* overlays */}
              {activeQuiz.quiz && (
                <ReplayQuiz
                  quiz={activeQuiz.quiz}
                  results={activeQuiz.results}
                  closed={activeQuiz.closed}
                />
              )}
              {activePoll.poll && (
                <ReplayPoll
                  poll={activePoll.poll}
                  results={activePoll.results}
                  closed={activePoll.closed}
                />
              )}
              {activeCta && <ReplayCta cta={activeCta} />}

              {/* paused / ended veil — a premiere has no pause button */}
              {!playing && !live && (
                <button
                  onClick={togglePlay}
                  className="absolute inset-0 grid place-items-center bg-black/40 transition hover:bg-black/30"
                  aria-label={ended ? 'Replay from the start' : 'Play replay'}
                >
                  <span className="flex flex-col items-center gap-3">
                    <span className="grid h-16 w-16 place-items-center rounded-full bg-white/90 shadow-xl">
                      {ended ? (
                        <svg
                          viewBox="0 0 24 24"
                          className="h-7 w-7 text-black"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" className="ml-1 h-7 w-7 text-black" fill="currentColor">
                          <path d="M8 5.5v13l11-6.5-11-6.5Z" />
                        </svg>
                      )}
                    </span>
                    <span className="rounded-full bg-black/60 px-3 py-1 text-[11px] font-medium text-white">
                      {ended ? 'Replay from the start' : 'Resume replay'}
                    </span>
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* ── transport ───────────────────────────────── */}
          <div className="shrink-0 px-3 pb-3">
            {live ? (
              // A premiere has no transport: you cannot scrub a live session,
              // and offering the controls would break the illusion the whole
              // feature exists to create.
              <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-ink-850/80 px-4 py-2.5 backdrop-blur-xl">
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-red-300">
                  Live
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-brand-400 transition-[width] duration-1000"
                    style={{ width: `${durationMs ? (positionMs / durationMs) * 100 : 0}%` }}
                  />
                </div>
                <span className="shrink-0 font-mono text-[11px] text-slate-500">
                  {formatClock(positionMs)} / {formatClock(durationMs)}
                </span>
                <button
                  onClick={toggleFullscreen}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-slate-400 transition hover:bg-white/[0.12] hover:text-white"
                  aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path
                      d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ) : (
            <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-ink-850/80 px-3 py-2.5 backdrop-blur-xl">
              <button
                onClick={togglePlay}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-500 text-white transition hover:bg-brand-400"
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="ml-0.5 h-4 w-4" fill="currentColor">
                    <path d="M8 5.5v13l11-6.5-11-6.5Z" />
                  </svg>
                )}
              </button>

              <span className="shrink-0 font-mono text-[11px] text-slate-400">
                {formatClock(positionMs)}
              </span>

              <input
                type="range"
                min={0}
                max={Math.max(durationMs, 1)}
                value={positionMs}
                onChange={(e) => seek(Number(e.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-brand-400"
                aria-label="Seek"
              />

              <span className="shrink-0 font-mono text-[11px] text-slate-500">
                {formatClock(durationMs)}
              </span>

              <div className="hidden items-center gap-1 sm:flex">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={`rounded-md px-1.5 py-1 font-mono text-[10px] transition ${
                      speed === s
                        ? 'bg-white/15 text-white'
                        : 'text-slate-500 hover:bg-white/[0.07] hover:text-slate-300'
                    }`}
                    aria-label={`Playback speed ${s}x`}
                  >
                    {s}×
                  </button>
                ))}
              </div>

              <button
                onClick={toggleFullscreen}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-slate-400 transition hover:bg-white/[0.12] hover:text-white"
                aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  {isFullscreen ? (
                    <path
                      d="M9 3H5a2 2 0 0 0-2 2v4m18 0V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4m10-6v4a2 2 0 0 1-2 2h-4"
                      strokeLinecap="round"
                    />
                  ) : (
                    <path
                      d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"
                      strokeLinecap="round"
                    />
                  )}
                </svg>
              </button>
            </div>
            )}
          </div>
        </div>

        {/* ── sidebar ───────────────────────────────────── */}
        <aside
          className={`${
            sidebarOpen ? 'absolute inset-0 z-30 flex' : 'hidden'
          } w-full flex-col border-l border-white/10 bg-ink-900 lg:static lg:flex lg:w-[340px] lg:bg-ink-900/50`}
        >
          <div className="flex items-stretch border-b border-white/10">
            {(['chat', 'people', 'qa', 'polls'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider transition ${
                  tab === t
                    ? 'border-b-2 border-brand-400 text-white'
                    : 'border-b-2 border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                {t === 'chat'
                  ? `Chat${chat.length ? ` (${chat.length})` : ''}`
                  : t === 'people'
                    ? `People${viewers ? ` (${viewers})` : ''}`
                    : t === 'qa'
                      ? `Q&A${qaHistory.length ? ` (${qaHistory.length})` : ''}`
                      : 'Polls'}
              </button>
            ))}
            <button
              onClick={() => setSidebarOpen(false)}
              className="px-3 text-slate-500 hover:text-white lg:hidden"
              aria-label="Close sidebar"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === 'chat' && <ReplayChat messages={chat} />}
            {tab === 'people' && <ReplayPeople people={people} hands={hands} />}
            {tab === 'qa' && <ReplayQa questions={qaHistory} />}
            {tab === 'polls' && <ReplayPolls polls={pollHistory} />}
          </div>

          <div className="shrink-0 border-t border-white/10 px-4 py-2.5">
            <p className="text-[10px] text-slate-600">
              Recorded {new Date(data.startedAt).toLocaleString()} · {data.eventCount} events
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

/* ── sidebar panels ─────────────────────────────────────────── */

function ReplayChat({ messages }: { messages: Extract<TimelineEvent, { type: 'chat' }>[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div ref={scrollRef} className="h-full space-y-3 overflow-y-auto px-4 py-4">
      {messages.length === 0 && (
        <p className="pt-8 text-center text-xs text-slate-600">
          No messages yet at this point in the session.
        </p>
      )}

      {messages.map((e) => {
        const msg: ChatMessagePayload = e.message;
        const staff = msg.role !== 'PARTICIPANT';

        return (
          <div key={msg.id} className="flex gap-2">
            <div
              className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                staff
                  ? 'bg-gradient-to-br from-brand-400 to-brand-700 text-white'
                  : 'bg-white/10 text-slate-300'
              }`}
            >
              {msg.name.slice(0, 2).toUpperCase()}
            </div>

            <div className="min-w-0 max-w-[85%]">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[11px] font-semibold text-slate-300">{msg.name}</span>
                {staff && (
                  <span className="rounded bg-brand-500/70 px-1 py-px text-[8px] font-bold uppercase text-white">
                    {msg.role === 'HOST' ? 'Host' : msg.role === 'ADMIN' ? 'Admin' : 'Mod'}
                  </span>
                )}
                <span className="font-mono text-[10px] text-slate-600">{formatClock(e.t)}</span>
              </div>
              <div className="mt-1 inline-block break-words rounded-xl bg-white/[0.06] px-3 py-2 text-[13px] leading-snug text-slate-200">
                {msg.text}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReplayPeople({
  people,
  hands,
}: {
  people: { name: string; role: Role }[];
  hands: string[];
}) {
  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      {people.length === 0 && (
        <p className="pt-8 text-center text-xs text-slate-600">Nobody has joined yet.</p>
      )}

      <div className="space-y-1">
        {people.map((p) => {
          const staff = p.role !== 'PARTICIPANT';
          const handUp = hands.includes(p.name);
          return (
            <div
              key={p.name}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/[0.04]"
            >
              <div
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                  staff
                    ? 'bg-gradient-to-br from-brand-400 to-brand-700 text-white'
                    : 'bg-white/10 text-slate-300'
                }`}
              >
                {p.name.slice(0, 2).toUpperCase()}
              </div>
              <span className="min-w-0 flex-1 truncate text-[12px] text-slate-300">{p.name}</span>
              {handUp && (
                <span className="text-[11px] text-amber-300" title="Hand raised">
                  ✋
                </span>
              )}
              {staff && (
                <span className="rounded bg-brand-500/70 px-1 py-px text-[8px] font-bold uppercase text-white">
                  {p.role === 'HOST' ? 'Host' : p.role === 'ADMIN' ? 'Admin' : 'Mod'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReplayQa({
  questions,
}: {
  questions: { question: QaQuestionPayload; answered: boolean; pinned: boolean }[];
}) {
  return (
    <div className="h-full space-y-2.5 overflow-y-auto px-4 py-4">
      {questions.length === 0 && (
        <p className="pt-8 text-center text-xs text-slate-600">
          No questions have been asked yet at this point.
        </p>
      )}

      {questions.map(({ question, answered, pinned }) => (
        <div
          key={question.id}
          className={`rounded-lg border p-2.5 ${
            pinned
              ? 'border-brand-400/40 bg-brand-500/10'
              : answered
                ? 'border-white/5 bg-white/[0.02] opacity-70'
                : 'border-white/10 bg-white/[0.04]'
          }`}
        >
          <div className="flex items-start gap-2.5">
            <div className="flex w-9 shrink-0 flex-col items-center rounded-md border border-white/10 py-1 text-slate-400">
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              >
                <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-[11px] font-semibold tabular-nums">{question.upvotes}</span>
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="truncate text-[11px] font-medium text-slate-300">
                  {question.name}
                </span>
                {pinned && (
                  <span className="rounded bg-amber-500/20 px-1 py-px text-[8px] font-bold uppercase text-amber-300">
                    Pinned
                  </span>
                )}
                {answered && (
                  <span className="rounded bg-emerald-500/20 px-1 py-px text-[8px] font-bold uppercase text-emerald-300">
                    Answered
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-[12px] leading-snug text-slate-200">
                {question.text}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReplayPolls({ polls }: { polls: { poll: PublicPoll; results: PollResults | null }[] }) {
  return (
    <div className="h-full space-y-3 overflow-y-auto px-4 py-4">
      {polls.length === 0 && (
        <p className="pt-8 text-center text-xs text-slate-600">
          No polls have run yet at this point.
        </p>
      )}

      {polls.map(({ poll, results }) => {
        const total = results?.totalVotes ?? 0;
        return (
          <div key={poll.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] font-semibold text-white">{poll.question}</p>
              <span className="shrink-0 text-[10px] text-slate-500">
                {total} {total === 1 ? 'vote' : 'votes'}
              </span>
            </div>

            <div className="mt-2 space-y-1.5">
              {poll.options.map((o) => {
                const count = results?.distribution[o.id] ?? 0;
                const pct = total ? Math.round((count / total) * 100) : 0;
                return (
                  <div key={o.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] text-slate-400">{o.text}</span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-500">{pct}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-brand-400" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── stage pieces ───────────────────────────────────────────── */

/**
 * Stand-in for the video feed when the session was captured as a timeline only.
 * A black rectangle reads as "broken"; a presenter card reads as "camera off",
 * which is what actually happened.
 */
function PresenterCard({ title, presenter }: { title: string; presenter: string }) {
  return (
    <div className="relative grid h-full w-full place-items-center overflow-hidden bg-gradient-to-br from-ink-900 via-ink-950 to-black">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'radial-gradient(circle at 30% 20%, rgba(99,102,241,0.25), transparent 55%), radial-gradient(circle at 75% 80%, rgba(16,185,129,0.18), transparent 55%)',
        }}
      />

      <div className="relative flex flex-col items-center gap-4 px-6 text-center">
        <div className="grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-700 text-2xl font-bold text-white shadow-glow">
          {presenter.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <p className="text-sm font-semibold text-white">{presenter}</p>
          <p className="mt-1 max-w-md text-xs text-slate-400">{title}</p>
        </div>
        <span className="chip py-1 text-[10px] text-slate-400">
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
            <path
              d="M15 10l4.5-2.5v9L15 14M4 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Camera off
        </span>
      </div>
    </div>
  );
}

/* ── read-only overlays ─────────────────────────────────────── */

function ReplayQuiz({
  quiz,
  results,
  closed,
}: {
  quiz: PublicQuiz;
  results: QuizResults | null;
  closed: boolean;
}) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/95 p-5 shadow-2xl">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-brand-300">
          {closed ? 'Quiz closed' : 'Quiz'}
        </p>
        <p className="mt-1 text-sm font-semibold text-white">{quiz.question}</p>

        <div className="mt-3 space-y-1.5">
          {quiz.options.map((o) => {
            const isCorrect = results?.correctOptionId === o.id;
            return (
              <div
                key={o.id}
                className={`rounded-lg border px-3 py-2 text-[11px] ${
                  isCorrect
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                    : 'border-white/10 bg-white/[0.03] text-slate-300'
                }`}
              >
                {o.text}
              </div>
            );
          })}
        </div>

        {results && (
          <p className="mt-3 text-[10px] text-slate-500">
            {results.correctCount}/{results.totalAnswers} correct
          </p>
        )}
      </div>
    </div>
  );
}

function ReplayPoll({
  poll,
  results,
  closed,
}: {
  poll: PublicPoll;
  results: PollResults | null;
  closed: boolean;
}) {
  const total = results?.totalVotes ?? 0;
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/95 p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-brand-300">
            {closed ? 'Poll closed' : 'Poll'}
          </p>
          <p className="text-[10px] text-slate-500">
            {total} {total === 1 ? 'vote' : 'votes'}
          </p>
        </div>
        <p className="mt-1 text-sm font-semibold text-white">{poll.question}</p>

        <div className="mt-3 space-y-1.5">
          {poll.options.map((o) => {
            const count = results?.distribution[o.id] ?? 0;
            const pct = total ? Math.round((count / total) * 100) : 0;
            return (
              <div key={o.id} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-slate-300">{o.text}</span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">
                    {count} · {pct}%
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-brand-400" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReplayCta({ cta }: { cta: CtaPayload }) {
  return (
    <div className="absolute inset-x-0 bottom-0 p-3">
      <div className="rounded-xl border border-brand-400/30 bg-slate-900/95 p-3 shadow-2xl backdrop-blur">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-brand-300">Offer</p>
        <p className="mt-0.5 text-xs font-semibold text-white">{cta.title}</p>
        {cta.description && (
          <p className="mt-0.5 line-clamp-2 text-[10px] text-slate-400">{cta.description}</p>
        )}
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] font-bold text-white">
            {cta.priceInPaise > 0 ? formatPrice(cta.priceInPaise, cta.currency) : 'Free'}
          </span>
          <span className="rounded-lg bg-brand-500 px-2.5 py-1 text-[10px] font-semibold text-white">
            {cta.buttonText}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── helpers ────────────────────────────────────────────────── */

/** `m:ss` for short sessions, `h:mm:ss` once it runs past an hour. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatPrice(paise: number, currency: string): string {
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : '';
  return `${symbol}${(paise / 100).toLocaleString('en-IN')}`;
}
