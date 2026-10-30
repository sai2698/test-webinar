'use client';

import { useEffect, useState } from 'react';
import { useRoomStore } from '@/store/roomStore';
import type { AppSocket } from '@/lib/socket';
import type { PublicQuiz } from '@webinar/shared';

interface QuizModalProps {
  socket: React.MutableRefObject<AppSocket | null>;
}

/**
 * The quiz popup, shown to participants only. The host drives the quiz from
 * Host tools — a full-screen popup over their own stage would just get in the
 * way, and they already see the live tally there.
 */
export function QuizModal({ socket }: QuizModalProps) {
  const quiz = useRoomStore((s) => s.activeQuiz);
  const results = useRoomStore((s) => s.quizResults);
  const role = useRoomStore((s) => s.role);

  const [selected, setSelected] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [feedback, setFeedback] = useState<{ correct: boolean } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  /**
   * `activeQuiz` is cleared as soon as the host closes the quiz, which used to
   * unmount this modal before the answer was revealed. Keep the last quiz so
   * the results panel can stay on screen.
   */
  const [lastQuiz, setLastQuiz] = useState<PublicQuiz | null>(null);

  const isStaff = role === 'HOST' || role === 'ADMIN' || role === 'MODERATOR';

  useEffect(() => {
    if (!quiz) return;
    setLastQuiz(quiz);
    setSelected(null);
    setSubmitted(false);
    setFeedback(null);
    setDismissed(false);
    setRemaining(quiz.timeLimitSecs);
  }, [quiz?.id]);

  useEffect(() => {
    // The clock belongs to the quiz, not to the viewer's answer. Stopping it on
    // submit used to freeze the bar at whatever second the participant happened
    // to answer on, which made a 30-second quiz look like it had ended early and
    // left the remaining time meaningless for everyone who answered quickly.
    if (!quiz) return;
    const id = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [quiz]);

  // Live quiz, or the revealed answers of the quiz that just closed.
  const shown = quiz ?? (results?.quizId === lastQuiz?.id ? lastQuiz : null);

  if (isStaff || !shown || dismissed) return null;

  function submit(optionId: string) {
    if (submitted || !socket.current) return;
    setSelected(optionId);
    setSubmitted(true);
    socket.current.emit('quizAnswer', { quizId: shown!.id, optionId }, (res) => {
      if (res.ok) setFeedback({ correct: res.data.correct });
    });
  }

  const closed = Boolean(results) && !quiz;
  const pct = shown.timeLimitSecs > 0 ? (remaining / shown.timeLimitSecs) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/80 p-4 backdrop-blur-md">
      <div className="w-full max-w-lg animate-fade-up overflow-hidden rounded-2xl border border-white/10 bg-ink-850 shadow-2xl">
        {/* timer bar */}
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
            <span className="chip border-brand-400/30 bg-brand-500/15 text-brand-200">
              {closed ? 'Quiz closed' : 'Live quiz'}
            </span>
            <span className="font-mono text-sm font-bold tabular-nums text-slate-300">
              {closed ? '' : `${remaining}s`}
            </span>
          </div>

          <h2 className="text-lg font-semibold leading-snug text-white">{shown.question}</h2>

          <div className="mt-5 space-y-2">
            {shown.options.map((opt) => {
              const isSelected = selected === opt.id;
              const isCorrect = results?.correctOptionId === opt.id;
              const showResult = Boolean(results);

              let cls =
                'border-white/10 bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.08]';
              if (showResult && isCorrect) cls = 'border-mint-400/60 bg-mint-500/15';
              else if (showResult && isSelected && !isCorrect)
                cls = 'border-red-500/50 bg-red-500/15';
              else if (isSelected) cls = 'border-brand-400/70 bg-brand-500/20';

              return (
                <button
                  key={opt.id}
                  onClick={() => submit(opt.id)}
                  disabled={submitted || closed || remaining === 0}
                  className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all disabled:cursor-default ${cls}`}
                >
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                      isSelected ? 'bg-brand-500 text-white' : 'bg-white/10 text-slate-400'
                    }`}
                  >
                    {opt.id.toUpperCase()}
                  </span>
                  <span className="text-sm text-slate-200">{opt.text}</span>
                  {showResult && isCorrect && <span className="ml-auto text-mint-400">✓</span>}
                </button>
              );
            })}
          </div>

          {feedback && (
            <div
              className={`mt-4 rounded-xl px-4 py-3 text-sm font-medium ${
                feedback.correct
                  ? 'bg-mint-500/15 text-mint-400'
                  : 'bg-red-500/15 text-red-400'
              }`}
            >
              {feedback.correct ? 'Correct! 🎉' : 'Not quite — hang tight for the answer.'}
            </div>
          )}

          {results && (
            <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-3 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-300">Live results</span>
                <span className="text-slate-500">
                  {results.correctCount}/{results.totalAnswers} correct
                </span>
              </div>
              <div className="space-y-2">
                {shown.options.map((opt) => {
                  const count = results.distribution[opt.id] ?? 0;
                  const total = Math.max(1, results.totalAnswers);
                  const width = (count / total) * 100;
                  const correct = results.correctOptionId === opt.id;
                  return (
                    <div key={opt.id} className="flex items-center gap-2">
                      <span className="w-4 text-[10px] font-bold text-slate-500">
                        {opt.id.toUpperCase()}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                        <div
                          className={`h-full rounded-full transition-all duration-700 ${
                            correct ? 'bg-mint-400' : 'bg-brand-500/60'
                          }`}
                          style={{ width: `${width}%` }}
                        />
                      </div>
                      <span className="w-6 text-right text-[10px] tabular-nums text-slate-500">
                        {count}
                      </span>
                    </div>
                  );
                })}
              </div>

              {results.topScorers.length > 0 && (
                <div className="mt-4 border-t border-white/10 pt-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Fastest correct
                  </p>
                  <ol className="space-y-1">
                    {results.topScorers.map((s, i) => (
                      <li
                        key={s.userId}
                        className="flex items-center gap-2 text-xs text-slate-300"
                      >
                        <span className="w-4 text-[10px] font-bold text-slate-500">
                          {i + 1}
                        </span>
                        <span className="truncate">{s.name}</span>
                        <span className="ml-auto tabular-nums text-[10px] text-slate-500">
                          {(s.elapsedMs / 1000).toFixed(1)}s
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}

          {closed && (
            <button onClick={() => setDismissed(true)} className="btn-ghost mt-5 w-full">
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
