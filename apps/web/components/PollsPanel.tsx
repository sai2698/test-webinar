'use client';

import { useEffect, useState } from 'react';
import { useRoomStore } from '@/store/roomStore';
import type { AppSocket } from '@/lib/socket';

interface PollsPanelProps {
  socket: React.MutableRefObject<AppSocket | null>;
}

/**
 * The sidebar Polls tab. It shows the poll that is currently open (if any) and
 * lets the viewer vote without the popup getting in the way — useful when the
 * host has launched a poll and the viewer dismissed the modal.
 */
export function PollsPanel({ socket }: PollsPanelProps) {
  const poll = useRoomStore((s) => s.activePoll);
  const results = useRoomStore((s) => s.pollResults);
  const role = useRoomStore((s) => s.role);

  const [selected, setSelected] = useState<string | null>(null);

  const isStaff = role === 'HOST' || role === 'ADMIN' || role === 'MODERATOR';

  useEffect(() => {
    setSelected(null);
  }, [poll?.id]);

  function vote(optionId: string) {
    if (!socket.current || !poll) return;
    setSelected(optionId);
    socket.current.emit('pollVote', { pollId: poll.id, optionId }, () => {});
  }

  const total = results?.totalVotes ?? 0;
  const closed = results?.closed ?? false;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">Polls</h3>
        {poll && (
          <span className="chip py-0.5 text-[10px]">
            {total} {total === 1 ? 'vote' : 'votes'}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {!poll ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-white/5 text-slate-500">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" strokeLinecap="round" />
              </svg>
            </span>
            <p className="text-xs text-slate-500">No poll running right now.</p>
            <p className="text-[11px] text-slate-600">
              The host can launch one from Host tools.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="chip border-accent-500/30 bg-accent-500/15 py-0.5 text-[10px] text-accent-400">
                  {closed ? 'Closed' : 'Live'}
                </span>
              </div>
              <p className="text-sm font-medium leading-snug text-white">{poll.question}</p>
            </div>

            <div className="space-y-2">
              {poll.options.map((opt) => {
                const count = results?.distribution[opt.id] ?? 0;
                const width = total > 0 ? (count / total) * 100 : 0;
                const isSelected = selected === opt.id;

                return (
                  <button
                    key={opt.id}
                    onClick={() => vote(opt.id)}
                    disabled={closed}
                    className={`relative flex w-full items-center gap-2.5 overflow-hidden rounded-lg border px-3 py-2.5 text-left transition-all disabled:cursor-default ${
                      isSelected
                        ? 'border-brand-400/70 bg-brand-500/20'
                        : 'border-white/10 bg-white/[0.04] hover:border-white/25'
                    }`}
                  >
                    <span
                      className="absolute inset-y-0 left-0 bg-brand-500/15 transition-all duration-700"
                      style={{ width: `${width}%` }}
                      aria-hidden
                    />
                    <span
                      className={`relative grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                        isSelected ? 'bg-brand-500 text-white' : 'bg-white/10 text-slate-400'
                      }`}
                    >
                      {opt.id.toUpperCase()}
                    </span>
                    <span className="relative flex-1 text-[13px] text-slate-200">{opt.text}</span>
                    <span className="relative text-[10px] tabular-nums text-slate-400">
                      {total > 0 ? `${Math.round(width)}%` : ''}
                    </span>
                  </button>
                );
              })}
            </div>

            {selected && !closed && (
              <p className="text-center text-[11px] text-slate-500">
                Vote recorded — pick another option to change it.
              </p>
            )}

            {isStaff && !closed && (
              <button
                onClick={() => socket.current?.emit('pollClose', { pollId: poll.id }, () => {})}
                className="btn-ghost w-full py-2 text-xs"
              >
                Close poll
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
