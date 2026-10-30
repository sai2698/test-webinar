'use client';

import { useRoomStore } from '@/store/roomStore';

/**
 * The participant's side of a host media request.
 *
 * The host can ask, but only the participant can turn a device on — the server
 * has no access to their hardware, and enabling a stranger's camera without
 * consent would be indefensible. So this is a prompt, not a command: it names
 * who is asking, says what they want, and offers Accept and Dismiss.
 *
 * Accepting calls the same toggle the control bar uses, so the resulting state
 * is identical to the participant pressing the button themselves.
 */
export function MediaRequestPrompt({
  onAccept,
}: {
  onAccept: (kind: 'mic' | 'cam') => void;
}) {
  const request = useRoomStore((s) => s.mediaRequest);
  const set = useRoomStore((s) => s.set);

  if (!request) return null;

  const what = request.kind === 'mic' ? 'microphone' : 'camera';

  return (
    <div className="fixed inset-x-0 top-16 z-50 mx-auto w-[min(92vw,26rem)] animate-fade-up">
      <div className="rounded-xl border border-brand-400/30 bg-ink-800/95 p-4 shadow-pop backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-500/20 text-brand-300">
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v4" strokeLinecap="round" />
            </svg>
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-white">
              {request.by} is asking you to turn on your {what}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Nothing is enabled until you accept.
            </p>

            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => {
                  onAccept(request.kind);
                  set({ mediaRequest: null });
                }}
                className="btn-primary px-3 py-1.5 text-[11px]"
              >
                Turn on {what}
              </button>
              <button
                onClick={() => set({ mediaRequest: null })}
                className="btn-ghost px-2.5 py-1.5 text-[11px]"
              >
                Not now
              </button>
            </div>
          </div>

          <button
            onClick={() => set({ mediaRequest: null })}
            aria-label="Dismiss"
            className="shrink-0 rounded p-1 text-slate-500 hover:bg-white/10 hover:text-slate-300"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
