'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoomStore } from '@/store/roomStore';
import { useMediaDevices } from '@/lib/useRoomUi';
import type { AppSocket } from '@/lib/socket';

interface ChatPanelProps {
  socket: React.MutableRefObject<AppSocket | null>;
  disabled?: boolean;
  /** The webinar slug, used to build the invite link and key the notes. */
  slug?: string;
  /** Swaps the active microphone. Absent for viewers who cannot publish. */
  onSwitchDevice?: (kind: 'audio' | 'video', deviceId: string) => void;
}

function timeAgo(ts: number) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

/** Which secondary sheet the action grid has opened, if any. */
type Sheet = 'leaderboard' | 'notes' | 'devices' | 'support' | null;

export function ChatPanel({ socket, disabled, slug, onSwitchDevice }: ChatPanelProps) {
  const messages = useRoomStore((s) => s.messages);
  const selfUserId = useRoomStore((s) => s.userId);
  const role = useRoomStore((s) => s.role);
  const hands = useRoomStore((s) => s.hands);
  const quizResults = useRoomStore((s) => s.quizResults);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isStaffRole = role === 'HOST' || role === 'ADMIN' || role === 'MODERATOR';

  const handRaised = useMemo(
    () => Boolean(selfUserId && hands.some((h) => h.userId === selfUserId)),
    [hands, selfUserId]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function remove(id: string) {
    socket.current?.emit('chatDelete', { id }, (res) => {
      if (!res.ok) setError(res.error);
    });
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || !socket.current) return;

    setSending(true);
    setError(null);
    socket.current.emit('chatSend', { text: value }, (res) => {
      setSending(false);
      if (res.ok) setText('');
      else setError(res.error);
    });
  }

  function toggleHand() {
    if (!socket.current) return;
    if (handRaised) socket.current.emit('handLower', () => {});
    else socket.current.emit('handRaise', () => {});
    setActionsOpen(false);
  }

  async function invite() {
    // The public landing page, not the room URL: a forwarded room link would
    // drop the recipient straight into a live session with no name on file.
    const url = `${window.location.origin}/w/${slug ?? ''}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access is blocked in some embedded browsers; showing the
      // link is still useful even when copying is not possible.
      setError(url);
    }
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">Live chat</h3>
        <span className="chip py-0.5 text-[10px]">{messages.length}</span>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="pt-8 text-center text-xs text-slate-600">
            No messages yet. Say hello 👋
          </p>
        )}

        {messages.map((msg) => {
          if (msg.system) {
            // An enrollment is the room's best social proof, so it gets a
            // celebratory card rather than the grey pill used for housekeeping
            // lines like "Recording started". Same data, different weight.
            if (msg.kind === 'enrollment') {
              // The feed's phrasing, not the toast's. A chat line is read in a
              // list of other chat lines, so it leads with the congratulation
              // and names the person — "Congratulations! Tamanna for
              // Enrolling" — where the toast over the video is a sentence
              // about what just happened. `actor` is absent on lines replayed
              // from an older recording, so fall back to the server's text.
              return (
                <div
                  key={msg.id}
                  className="flex items-center gap-2.5 rounded-full border border-amber-400/40 bg-gradient-to-r from-amber-500/20 via-amber-500/10 to-transparent px-3 py-2"
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-amber-400/25 text-sm">
                    🎉
                  </span>
                  <p className="text-[12px] font-semibold leading-snug text-amber-200">
                    {msg.actor ? (
                      <>
                        Congratulations! <span className="text-amber-100">{msg.actor}</span> for
                        Enrolling
                      </>
                    ) : (
                      msg.text
                    )}
                  </p>
                </div>
              );
            }

            return (
              <div key={msg.id} className="text-center">
                <span className="inline-block rounded-full bg-white/[0.06] px-3 py-1 text-[11px] text-slate-400">
                  {msg.text}
                </span>
              </div>
            );
          }

          const mine = msg.userId === selfUserId;
          const isStaff = msg.role !== 'PARTICIPANT';
          // Staff can delete anyone's message; nobody can delete a system line.
          const canModerate = isStaffRole && !msg.system;

          return (
            <div key={msg.id} className={`group flex gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
              <div
                className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                  isStaff
                    ? 'bg-gradient-to-br from-brand-400 to-brand-700 text-white'
                    : 'bg-white/10 text-slate-300'
                }`}
              >
                {msg.name.slice(0, 2).toUpperCase()}
              </div>

              <div className={`min-w-0 max-w-[80%] ${mine ? 'items-end text-right' : ''}`}>
                <div className={`flex items-center gap-1.5 ${mine ? 'justify-end' : ''}`}>
                  <span className="truncate text-[11px] font-semibold text-slate-300">
                    {msg.name}
                  </span>
                  {isStaff && (
                    <span className="rounded bg-brand-500/70 px-1 py-px text-[8px] font-bold uppercase text-white">
                      {msg.role === 'HOST' ? 'Host' : msg.role === 'ADMIN' ? 'Admin' : 'Mod'}
                    </span>
                  )}
                  {msg.enrolled && (
                    <span className="rounded bg-mint-500/20 px-1 py-px text-[8px] font-bold uppercase text-mint-400">
                      Enrolled
                    </span>
                  )}
                  <span className="text-[10px] text-slate-600">{timeAgo(msg.ts)}</span>
                  {canModerate && (
                    <button
                      onClick={() => remove(msg.id)}
                      aria-label={`Delete message from ${msg.name}`}
                      title="Delete message"
                      className="text-[10px] text-slate-600 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                    >
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </div>
                <div
                  className={`mt-1 inline-block break-words rounded-xl px-3 py-2 text-[13px] leading-snug ${
                    mine
                      ? 'bg-brand-600/80 text-white'
                      : 'bg-white/[0.06] text-slate-200'
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── action grid ─────────────────────────────────────── */}
      {/* Anchored above the composer rather than over the whole room: these are
          chat-adjacent tools, and a full-screen sheet would hide the messages
          the participant opened the sidebar to read. */}
      {actionsOpen && (
        <div className="border-t border-white/10 bg-ink-900/95 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Quick actions
            </p>
            <button
              onClick={() => setActionsOpen(false)}
              aria-label="Close quick actions"
              className="text-slate-500 transition hover:text-white"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <ActionTile
              label="Leader Board"
              icon="🏆"
              onClick={() => setSheet('leaderboard')}
            />
            {!isStaffRole && (
              <ActionTile
                label={handRaised ? 'Lower Hand' : 'Raise Hand'}
                icon="✋"
                active={handRaised}
                onClick={toggleHand}
              />
            )}
            <ActionTile label="Class Notes" icon="📝" onClick={() => setSheet('notes')} />
            <ActionTile
              label={copied ? 'Link copied' : 'Invite Others'}
              icon="💬"
              onClick={() => void invite()}
            />
            <ActionTile label="Audio Device" icon="🔊" onClick={() => setSheet('devices')} />
            <ActionTile label="Support" icon="🎧" onClick={() => setSheet('support')} />
          </div>
        </div>
      )}

      {sheet && (
        <ChatSheet
          sheet={sheet}
          onClose={() => setSheet(null)}
          quizResults={quizResults}
          slug={slug}
          onSwitchDevice={onSwitchDevice}
        />
      )}

      <form onSubmit={send} className="border-t border-white/10 p-3">
        {error && <p className="mb-2 break-all text-[11px] text-red-400">{error}</p>}
        <div className="flex items-center gap-2">
          <input
            className="input py-2 text-[13px]"
            placeholder={disabled ? 'Chat is disabled' : 'Send a message…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={disabled || sending}
            maxLength={1000}
          />
          <button
            type="button"
            onClick={() => {
              setActionsOpen((v) => !v);
              setSheet(null);
            }}
            aria-label="More chat actions"
            title="More actions"
            className={`btn-ghost shrink-0 px-2.5 py-2 ${actionsOpen ? 'text-white' : ''}`}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>
          <button
            type="submit"
            className="btn-primary shrink-0 px-3 py-2"
            disabled={disabled || sending || !text.trim()}
            aria-label="Send message"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m4 12 16-8-6 16-2.5-6.5L4 12Z" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}

/** One square in the quick-action grid. */
function ActionTile({
  label,
  icon,
  onClick,
  active,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border px-1 py-3 text-center transition ${
        active
          ? 'border-accent-500/50 bg-accent-500/15 text-accent-300'
          : 'border-white/10 bg-white/[0.04] text-slate-300 hover:border-white/25 hover:bg-white/[0.08] hover:text-white'
      }`}
    >
      <span className="text-lg leading-none">{icon}</span>
      <span className="text-[10px] font-semibold leading-tight">{label}</span>
    </button>
  );
}

/**
 * The sheet behind one quick action.
 *
 * Rendered inline rather than as a portal: it covers the message list but stays
 * inside the sidebar, so the composer and the room controls remain reachable
 * while it is open.
 */
function ChatSheet({
  sheet,
  onClose,
  quizResults,
  slug,
  onSwitchDevice,
}: {
  sheet: Exclude<Sheet, null>;
  onClose: () => void;
  quizResults: ReturnType<typeof useRoomStore.getState>['quizResults'];
  slug?: string;
  onSwitchDevice?: (kind: 'audio' | 'video', deviceId: string) => void;
}) {
  const { microphones, refresh } = useMediaDevices();
  const [note, setNote] = useState('');
  const storageKey = `notes:${slug ?? 'room'}`;

  useEffect(() => {
    if (sheet !== 'notes') return;
    try {
      setNote(localStorage.getItem(storageKey) ?? '');
    } catch {
      /* private mode */
    }
  }, [sheet, storageKey]);

  useEffect(() => {
    if (sheet === 'devices') void refresh();
  }, [sheet, refresh]);

  function saveNote(value: string) {
    setNote(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      /* private mode — the note still lives for this session */
    }
  }

  const titles: Record<Exclude<Sheet, null>, string> = {
    leaderboard: 'Leader board',
    notes: 'Class notes',
    devices: 'Audio device',
    support: 'Support',
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-ink-900/95 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h4 className="text-xs font-semibold text-white">{titles[sheet]}</h4>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-slate-500 transition hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {sheet === 'leaderboard' &&
          (quizResults && quizResults.topScorers.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[11px] text-slate-500">
                Fastest correct answers on “{quizResults.question}”
              </p>
              {quizResults.topScorers.map((s, i) => (
                <div
                  key={s.userId}
                  className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2"
                >
                  <span className="w-5 text-center text-[11px] font-bold text-slate-500">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">
                    {s.name}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-mint-400">
                    {(s.elapsedMs / 1000).toFixed(1)}s
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="pt-6 text-center text-[11px] text-slate-600">
              No quiz results yet. The board fills in once a quiz closes.
            </p>
          ))}

        {sheet === 'notes' && (
          <div className="flex h-full flex-col">
            <p className="mb-2 text-[11px] text-slate-500">
              Private to this device. Nothing here is shared with the host.
            </p>
            <textarea
              value={note}
              onChange={(e) => saveNote(e.target.value)}
              placeholder="Jot down anything worth remembering…"
              className="input min-h-[180px] flex-1 resize-none py-2 text-[12px] leading-relaxed"
            />
          </div>
        )}

        {sheet === 'devices' && (
          <div className="space-y-1">
            {!onSwitchDevice && (
              <p className="text-[11px] text-slate-500">
                You are not publishing audio, so there is nothing to switch.
              </p>
            )}
            {onSwitchDevice && microphones.length === 0 && (
              <p className="text-[11px] text-slate-500">No microphone found.</p>
            )}
            {onSwitchDevice &&
              microphones.map((d) => (
                <button
                  key={d.deviceId}
                  onClick={() => {
                    onSwitchDevice('audio', d.deviceId);
                    onClose();
                  }}
                  className="block w-full truncate rounded-lg px-2 py-2 text-left text-[12px] text-slate-300 transition hover:bg-white/10 hover:text-white"
                >
                  {d.label}
                </button>
              ))}
          </div>
        )}

        {sheet === 'support' && (
          <div className="space-y-3 text-[12px] text-slate-300">
            <p>Stuck? Reach the team running this session.</p>
            <a
              href="mailto:support@webinar.local?subject=Help%20with%20a%20live%20session"
              className="btn-ghost block w-full py-2 text-center text-[12px]"
            >
              Email support
            </a>
            <p className="text-[11px] text-slate-500">
              Include the webinar name and roughly what time it happened — it
              makes the session easy to find.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
