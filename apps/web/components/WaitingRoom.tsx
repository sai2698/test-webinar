'use client';

import { useEffect, useState } from 'react';
import { useRoomStore } from '@/store/roomStore';

interface WaitingRoomProps {
  /** The webinar title, so the screen is not anonymous. */
  title: string;
  /** Scheduled start, used to show a countdown when it is still in the future. */
  startsAt?: string | null;
}

/**
 * What a participant sees between joining and the host opening the session.
 *
 * The room is real — the socket is connected, chat works, the roster is live —
 * but nothing is being presented yet. Showing an empty video grid with a
 * spinner would read as a broken page, so this says plainly that the session
 * has not started and that the host will begin shortly.
 *
 * Staff never see this: they are the ones who start the session, and they need
 * the room to get their camera and slides ready.
 */
export function WaitingRoom({ title, startsAt }: WaitingRoomProps) {
  const viewerCount = useRoomStore((s) => s.viewerCount);
  const role = useRoomStore((s) => s.role);

  // A countdown is only meaningful while the scheduled time is still ahead.
  // Once it passes, "starting shortly" is the honest message — the host is
  // late, and a clock counting up from zero would look like a fault.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const target = startsAt ? new Date(startsAt).getTime() : null;
  const remaining = target !== null && target > now ? target - now : null;

  const isStaff = role === 'HOST' || role === 'ADMIN' || role === 'MODERATOR';

  return (
    <div className="grid h-full place-items-center rounded-2xl border border-white/10 bg-ink-900/60 px-6">
      <div className="w-full max-w-md text-center">
        {/* A slow pulse rather than a spinner: nothing is loading, we are
            waiting on a person. A spinner would imply the page is stuck. */}
        <div className="relative mx-auto mb-6 grid h-16 w-16 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/20" />
          <span className="relative grid h-16 w-16 place-items-center rounded-full border border-brand-400/30 bg-brand-500/10">
            <svg
              viewBox="0 0 24 24"
              className="h-7 w-7 text-brand-300"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>

        <h2 className="text-lg font-semibold text-white">The webinar hasn&apos;t started yet</h2>
        <p className="mt-2 text-sm text-slate-400">
          {isStaff
            ? 'You are in the room. Start the session when you are ready.'
            : 'You are in the room. The host will begin shortly — no need to refresh.'}
        </p>

        {title && (
          <p className="mt-4 truncate text-xs font-medium text-slate-500" title={title}>
            {title}
          </p>
        )}

        {remaining !== null && (
          <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">Starts in</span>
            <span className="font-mono text-sm font-semibold text-white">
              {formatCountdown(remaining)}
            </span>
          </div>
        )}

        <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-slate-500">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          {viewerCount === 1
            ? 'You are the first one here'
            : `${viewerCount} people are waiting`}
        </div>

        <p className="mt-4 text-[11px] text-slate-600">
          You can use the chat while you wait.
        </p>
      </div>
    </div>
  );
}

/** `1h 04m` / `4m 12s` / `38s` — coarse enough to read at a glance. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}
