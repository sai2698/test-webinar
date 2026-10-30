'use client';

import { useEffect, useState } from 'react';
import { useRoomStore } from '@/store/roomStore';
import type { AppSocket } from '@/lib/socket';
import type { PublicPoll } from '@webinar/shared';

interface PollModalProps {
  socket: React.MutableRefObject<AppSocket | null>;
}

/**
 * The poll popup. Deliberately simpler than `QuizModal`: there is no right
 * answer, so there is no feedback state and no scorer board — just the
 * question, the choices, and a tally that moves as the room votes.
 *
 * Staff never see this: the host already has the same controls in Host tools,
 * and a popup covering their own stage while they are presenting is noise.
 */
export function PollModal({ socket }: PollModalProps) {
  const poll = useRoomStore((s) => s.activePoll);
  const results = useRoomStore((s) => s.pollResults);
  const role = useRoomStore((s) => s.role);

  const [selected, setSelected] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  /**
   * The last poll we saw. `activePoll` is cleared the moment the host closes
   * the poll, which used to unmount this modal before anyone could read the
   * final tally — so keep a copy and render that instead.
   */
  const [lastPoll, setLastPoll] = useState<PublicPoll | null>(null);

  const isStaff = role === 'HOST' || role === 'ADMIN' || role === 'MODERATOR';

  useEffect(() => {
    if (!poll) return;
    setLastPoll(poll);
    setSelected(null);
    setDismissed(false);
    setRemaining(poll.timeLimitSecs);
  }, [poll?.id]);

  useEffect(() => {
    if (!poll || poll.timeLimitSecs === 0) return;
    const id = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(id);
  }, [poll]);

  // Live poll, or the final tally of the poll that just closed.
  const shown = poll ?? (results?.closed && results.pollId === lastPoll?.id ? lastPoll : null);

  if (isStaff || !shown || dismissed) return null;

  function vote(optionId: string) {
    if (!socket.current) return;
    setSelected(optionId);
    socket.current.emit('pollVote', { pollId: shown!.id, optionId }, () => {});
  }

  const closed = results?.closed ?? false;
  const total = results?.totalVotes ?? 0;
  const pct = shown.timeLimitSecs > 0 ? (remaining / shown.timeLimitSecs) * 100 : 100;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/80 p-4 backdrop-blur-md">
      <div className="w-full max-w-lg animate-fade-up overflow-hidden rounded-2xl border border-white/10 bg-ink-850 shadow-2xl">
        <div className="h-1 w-full bg-white/5">
          <div
            className={`h-full transition-all duration-1000 ease-linear ${
              pct > 40 ? 'bg-mint-400' : pct > 15 ? 'bg-accent-500' : 'bg-red-500'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <span className="chip border-accent-500/30 bg-accent-500/15 text-accent-400">
              {closed ? 'Poll closed' : 'Live poll'}
            </span>
            <div className="flex items-center gap-3">
              <span className="text-[11px] tabular-nums text-slate-500">
                {total} {total === 1 ? 'vote' : 'votes'}
              </span>
              {!closed && shown.timeLimitSecs > 0 && (
                <span className="font-mono text-sm font-bold tabular-nums text-slate-300">
                  {remaining}s
                </span>
              )}
            </div>
          </div>

          <h2 className="text-lg font-semibold leading-snug text-white">{shown.question}</h2>

          <div className="mt-5 space-y-2">
            {shown.options.map((opt) => {
              const isSelected = selected === opt.id;
              const count = results?.distribution[opt.id] ?? 0;
              const width = total > 0 ? (count / total) * 100 : 0;

              return (
                <button
                  key={opt.id}
                  onClick={() => vote(opt.id)}
                  disabled={closed}
                  className={`relative flex w-full items-center gap-3 overflow-hidden rounded-xl border px-4 py-3 text-left transition-all disabled:cursor-default ${
                    isSelected
                      ? 'border-brand-400/70 bg-brand-500/20'
                      : 'border-white/10 bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.08]'
                  }`}
                >
                  {/* tally fill sits behind the label */}
                  <span
                    className="absolute inset-y-0 left-0 bg-brand-500/15 transition-all duration-700"
                    style={{ width: `${width}%` }}
                    aria-hidden
                  />
                  <span
                    className={`relative grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                      isSelected ? 'bg-brand-500 text-white' : 'bg-white/10 text-slate-400'
                    }`}
                  >
                    {opt.id.toUpperCase()}
                  </span>
                  <span className="relative text-sm text-slate-200">{opt.text}</span>
                  <span className="relative ml-auto text-[11px] tabular-nums text-slate-400">
                    {total > 0 ? `${Math.round(width)}%` : ''}
                  </span>
                </button>
              );
            })}
          </div>

          {selected && !closed && (
            <p className="mt-4 text-center text-[11px] text-slate-500">
              Vote recorded — pick another option to change it.
            </p>
          )}

          <div className="mt-5 flex gap-2">
            <button onClick={() => setDismissed(true)} className="btn-ghost flex-1">
              {closed ? 'Close' : 'Hide'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
