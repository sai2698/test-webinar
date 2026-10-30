'use client';

import { useState } from 'react';
import { useRoomStore } from '@/store/roomStore';
import type { AppSocket } from '@/lib/socket';

interface QaPanelProps {
  socket: React.MutableRefObject<AppSocket | null>;
}

/**
 * The sidebar Q&A tab.
 *
 * Chat is a stream — it scrolls away and nobody expects an answer. Q&A is a
 * queue: questions accumulate upvotes, the host works through them, and the
 * best ones rise. That is why this is a separate tab with its own ordering
 * rather than a filter over chat.
 */
export function QaPanel({ socket }: QaPanelProps) {
  const questions = useRoomStore((s) => s.questions);
  const role = useRoomStore((s) => s.role);
  const userId = useRoomStore((s) => s.userId);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isStaff = role === 'HOST' || role === 'ADMIN' || role === 'MODERATOR';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !socket.current || sending) return;

    setSending(true);
    setError(null);
    socket.current.emit('qaAsk', { text }, (res) => {
      setSending(false);
      if (res.ok) {
        setDraft('');
      } else {
        setError(res.error);
      }
    });
  }

  function upvote(questionId: string) {
    socket.current?.emit('qaUpvote', { questionId }, () => {});
  }

  const open = questions.filter((q) => !q.answered);
  const answered = questions.filter((q) => q.answered);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">Q&amp;A</h3>
        <span className="chip py-0.5 text-[10px]">
          {open.length} open
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {questions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-white/5 text-slate-500">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M9.1 9a3 3 0 1 1 4.2 2.7c-.8.4-1.3 1.2-1.3 2.1v.4" strokeLinecap="round" />
                <circle cx="12" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            </span>
            <p className="text-xs text-slate-500">No questions yet.</p>
            <p className="text-[11px] text-slate-600">Ask the first one below.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {open.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
                isStaff={isStaff}
                isMine={q.userId === userId}
                onUpvote={() => upvote(q.id)}
                onAnswer={() =>
                  socket.current?.emit('qaAnswer', { questionId: q.id, answered: true }, () => {})
                }
                onPin={() =>
                  socket.current?.emit('qaPin', { questionId: q.id, pinned: !q.pinned }, () => {})
                }
                onDelete={() =>
                  socket.current?.emit('qaDelete', { questionId: q.id }, () => {})
                }
              />
            ))}

            {answered.length > 0 && (
              <>
                <p className="pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Answered
                </p>
                {answered.map((q) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    isStaff={isStaff}
                    isMine={q.userId === userId}
                    onUpvote={() => upvote(q.id)}
                    onAnswer={() =>
                      socket.current?.emit('qaAnswer', { questionId: q.id, answered: false }, () => {})
                    }
                    onPin={() =>
                      socket.current?.emit('qaPin', { questionId: q.id, pinned: !q.pinned }, () => {})
                    }
                    onDelete={() =>
                      socket.current?.emit('qaDelete', { questionId: q.id }, () => {})
                    }
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <form onSubmit={submit} className="border-t border-white/10 p-3">
        {error && <p className="mb-2 text-[11px] text-rose-400">{error}</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter makes a new line — the convention
              // every chat box has trained people to expect.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(e);
              }
            }}
            rows={2}
            maxLength={500}
            placeholder="Ask a question…"
            className="input min-h-[44px] flex-1 resize-none py-2 text-[13px]"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            className="btn-primary h-[44px] px-3 text-xs disabled:opacity-40"
          >
            Ask
          </button>
        </div>
      </form>
    </div>
  );
}

interface QuestionCardProps {
  question: {
    id: string;
    name: string;
    role: string;
    text: string;
    upvotes: number;
    answered: boolean;
    pinned: boolean;
    upvotedByMe: boolean;
  };
  isStaff: boolean;
  isMine: boolean;
  onUpvote: () => void;
  onAnswer: () => void;
  onPin: () => void;
  onDelete: () => void;
}

function QuestionCard({
  question,
  isStaff,
  isMine,
  onUpvote,
  onAnswer,
  onPin,
  onDelete,
}: QuestionCardProps) {
  const staff = question.role === 'HOST' || question.role === 'ADMIN' || question.role === 'MODERATOR';

  return (
    <div
      className={`rounded-lg border p-2.5 transition-colors ${
        question.pinned
          ? 'border-brand-400/40 bg-brand-500/10'
          : question.answered
            ? 'border-white/5 bg-white/[0.02] opacity-70'
            : 'border-white/10 bg-white/[0.04]'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <button
          onClick={onUpvote}
          aria-label={question.upvotedByMe ? 'Remove upvote' : 'Upvote question'}
          className={`flex w-9 shrink-0 flex-col items-center rounded-md border py-1 transition-colors ${
            question.upvotedByMe
              ? 'border-brand-400/60 bg-brand-500/20 text-brand-300'
              : 'border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200'
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[11px] font-semibold tabular-nums">{question.upvotes}</span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[11px] font-medium text-slate-300">{question.name}</span>
            {staff && (
              <span className="chip border-brand-400/30 bg-brand-500/15 py-0 text-[9px] text-brand-300">
                Host
              </span>
            )}
            {question.pinned && (
              <span className="chip border-amber-400/30 bg-amber-500/15 py-0 text-[9px] text-amber-300">
                Pinned
              </span>
            )}
            {question.answered && (
              <span className="chip border-emerald-400/30 bg-emerald-500/15 py-0 text-[9px] text-emerald-300">
                Answered
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-snug text-slate-200">
            {question.text}
          </p>

          {(isStaff || isMine) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {isStaff && (
                <>
                  <button onClick={onAnswer} className="text-[10px] text-slate-400 hover:text-white">
                    {question.answered ? 'Reopen' : 'Mark answered'}
                  </button>
                  <span className="text-[10px] text-slate-700">·</span>
                  <button onClick={onPin} className="text-[10px] text-slate-400 hover:text-white">
                    {question.pinned ? 'Unpin' : 'Pin'}
                  </button>
                </>
              )}
              {isStaff && (
                <>
                  <span className="text-[10px] text-slate-700">·</span>
                  <button onClick={onDelete} className="text-[10px] text-rose-400 hover:text-rose-300">
                    Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
