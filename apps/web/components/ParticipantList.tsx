'use client';

import { useMemo, useState } from 'react';
import { useRoomStore } from '@/store/roomStore';
import type { AppSocket } from '@/lib/socket';
import type { PeerInfo } from '@webinar/shared';

interface ParticipantListProps {
  socket: React.MutableRefObject<AppSocket | null>;
}

export function ParticipantList({ socket }: ParticipantListProps) {
  const peers = useRoomStore((s) => s.peers);
  const self = useRoomStore((s) => s.self);
  const hands = useRoomStore((s) => s.hands);
  const role = useRoomStore((s) => s.role);
  const selfPeerId = useRoomStore((s) => s.peerId);

  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const isStaff = role === 'HOST' || role === 'ADMIN' || role === 'MODERATOR';

  // Filtering happens before the grouping so a search that matches one speaker
  // does not leave empty "Speakers" and "Audience" headings behind.
  const list = useMemo(() => {
    // The roster includes you. The server leaves self out of `peers` because
    // the video grid draws the local tile from `localStream`, but a list that
    // omits you makes a one-person room look empty and hides your own state.
    const all = [...(self ? [self] : []), ...Object.values(peers)];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((p) => p.name.toLowerCase().includes(q));
  }, [peers, self, query]);

  const staff = list.filter((p) => p.role !== 'PARTICIPANT');
  const speakers = list.filter((p) => p.role === 'PARTICIPANT' && p.isApprovedSpeaker);
  const audience = list.filter((p) => p.role === 'PARTICIPANT' && !p.isApprovedSpeaker);

  const total = Object.keys(peers).length + (self ? 1 : 0);

  function approve(userId: string) {
    socket.current?.emit('handApprove', { userId }, () => {});
  }
  function deny(userId: string) {
    socket.current?.emit('handDeny', { userId }, () => {});
  }
  function mute(userId: string) {
    socket.current?.emit('modMute', { userId }, () => {});
  }
  function kick(userId: string) {
    socket.current?.emit('modKick', { userId }, () => {});
  }

  /**
   * Ask a participant to turn their mic or camera on.
   *
   * A request, not a command — the participant gets a prompt and decides. The
   * toast reports who was asked so the host knows the message went out.
   */
  function requestMedia(userId: string, kind: 'mic' | 'cam') {
    socket.current?.emit('mediaRequest', { userId, kind }, (res) => {
      if (!res?.ok) {
        setNotice(res?.error ?? 'Could not send the request');
        return;
      }
      const name = (res.data as { name?: string } | undefined)?.name ?? 'The participant';
      setNotice(`Asked ${name} to turn on their ${kind === 'mic' ? 'microphone' : 'camera'}`);
      window.setTimeout(() => setNotice(null), 4000);
    });
  }

  const Row = ({ peer, showActions }: { peer: PeerInfo; showActions?: boolean }) => {
    const hand = hands.find((h) => h.userId === peer.userId);
    const isSelf = peer.peerId === selfPeerId;

    // A peer with no audio producer at all has never published, so "muted" is
    // the honest label — there is nothing to unmute, only something to start.
    const hasAudio = peer.producers.some((p) => p.kind === 'audio');
    const hasVideo = peer.producers.some((p) => p.kind === 'video');

    return (
      <div className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/[0.05]">
        <div className="relative shrink-0">
          <div
            className={`grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold ${
              peer.role !== 'PARTICIPANT'
                ? 'bg-gradient-to-br from-brand-400 to-brand-700 text-white'
                : 'bg-white/10 text-slate-300'
            }`}
          >
            {peer.name.slice(0, 2).toUpperCase()}
          </div>
          {/* A live-mic dot on the avatar, so the state is readable at a glance
              without scanning the icon row. */}
          {peer.micOn && (
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-900 bg-mint-400" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-slate-200">
              {peer.name}
              {isSelf && <span className="ml-1 text-slate-500">(you)</span>}
            </span>
            {hand && <span className="text-[11px]">✋</span>}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500">
            <span>
              {peer.role === 'HOST'
                ? 'Host'
                : peer.role === 'ADMIN'
                  ? 'Admin'
                  : peer.role === 'MODERATOR'
                    ? 'Moderator'
                    : peer.isApprovedSpeaker
                      ? 'Speaker'
                      : 'Viewer'}
            </span>
            <span className="text-slate-700">·</span>
            <MediaIcons
              micOn={peer.micOn}
              camOn={peer.camOn}
              hasAudio={hasAudio}
              hasVideo={hasVideo}
            />
          </div>
        </div>

        {showActions && isStaff && !isSelf && (
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            {hand && (
              <>
                <button
                  onClick={() => approve(peer.userId)}
                  className="rounded bg-mint-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-mint-400 hover:bg-mint-500/30"
                >
                  Allow
                </button>
                <button
                  onClick={() => deny(peer.userId)}
                  className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300 hover:bg-white/20"
                >
                  Deny
                </button>
              </>
            )}

            {/* Ask for the mic only when it is actually off — a request to
                unmute someone who is already speaking is noise. */}
            {!peer.micOn && (
              <button
                onClick={() => requestMedia(peer.userId, 'mic')}
                title="Ask this participant to unmute"
                className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300 hover:bg-white/20"
              >
                Ask mic
              </button>
            )}
            {!peer.camOn && (
              <button
                onClick={() => requestMedia(peer.userId, 'cam')}
                title="Ask this participant to turn their camera on"
                className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300 hover:bg-white/20"
              >
                Ask cam
              </button>
            )}

            {peer.isApprovedSpeaker && peer.micOn && (
              <button
                onClick={() => mute(peer.userId)}
                className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300 hover:bg-white/20"
              >
                Mute
              </button>
            )}
            <button
              onClick={() => kick(peer.userId)}
              className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-400 hover:bg-red-500/30"
            >
              Remove
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">Participants</h3>
        <span className="chip py-0.5 text-[10px]">
          {query ? `${list.length}/${total}` : total}
        </span>
      </div>

      {/* ── search ─────────────────────────────────────── */}
      <div className="border-b border-white/10 px-3 py-2">
        <div className="relative">
          <svg
            viewBox="0 0 24 24"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search participants…"
            aria-label="Search participants"
            className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-1.5 pl-8 pr-7 text-xs text-slate-200 placeholder:text-slate-600 focus:border-brand-400/50 focus:outline-none focus:ring-1 focus:ring-brand-400/30"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-slate-500 hover:bg-white/10 hover:text-slate-300"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {notice && (
        <p className="border-b border-white/10 bg-brand-500/10 px-4 py-1.5 text-[10px] text-brand-200">
          {notice}
        </p>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
        {hands.length > 0 && isStaff && (
          <section>
            <h4 className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-accent-400">
              Hand raised ({hands.length})
            </h4>
            {hands.map((h) => {
              const peer = Object.values(peers).find((p) => p.userId === h.userId);
              if (!peer) return null;
              return (
                <div
                  key={h.userId}
                  className="flex items-center gap-2 rounded-lg bg-accent-500/10 px-2 py-1.5"
                >
                  <span className="text-sm">✋</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-200">
                    {h.name}
                  </span>
                  <button
                    onClick={() => approve(h.userId)}
                    className="rounded bg-mint-500/25 px-2 py-0.5 text-[10px] font-bold text-mint-400 hover:bg-mint-500/40"
                  >
                    Allow
                  </button>
                  <button
                    onClick={() => deny(h.userId)}
                    className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-bold text-slate-300 hover:bg-white/20"
                  >
                    Deny
                  </button>
                </div>
              );
            })}
          </section>
        )}

        {staff.length > 0 && (
          <section>
            <h4 className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Hosts & moderators
            </h4>
            {staff.map((p) => (
              <Row key={p.peerId} peer={p} showActions />
            ))}
          </section>
        )}

        {speakers.length > 0 && (
          <section>
            <h4 className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Speakers
            </h4>
            {speakers.map((p) => (
              <Row key={p.peerId} peer={p} showActions />
            ))}
          </section>
        )}

        {audience.length > 0 && (
          <section>
            <h4 className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Audience ({audience.length})
            </h4>
            {audience.slice(0, 100).map((p) => (
              <Row key={p.peerId} peer={p} showActions />
            ))}
            {audience.length > 100 && (
              <p className="px-2 pt-1 text-[10px] text-slate-600">
                +{audience.length - 100} more viewers
              </p>
            )}
          </section>
        )}

        {list.length === 0 && (
          <p className="pt-8 text-center text-xs text-slate-600">
            {query ? `No one matching “${query}”` : 'Nobody here yet'}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Mic and camera state for one participant.
 *
 * Three states, not two: on, off, and never-published. A viewer who has never
 * turned their camera on is not the same as one who turned it off, and the host
 * needs to tell them apart before asking.
 */
function MediaIcons({
  micOn,
  camOn,
  hasAudio,
  hasVideo,
}: {
  micOn: boolean;
  camOn: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        title={micOn ? 'Microphone on' : hasAudio ? 'Muted' : 'No microphone'}
        className={micOn ? 'text-mint-400' : 'text-slate-600'}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="9" y="2" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v4" strokeLinecap="round" />
          {!micOn && <path d="M3 3l18 18" strokeLinecap="round" />}
        </svg>
      </span>

      <span
        title={camOn ? 'Camera on' : hasVideo ? 'Camera off' : 'No camera'}
        className={camOn ? 'text-mint-400' : 'text-slate-600'}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="2" y="6" width="13" height="12" rx="2" />
          <path d="M15 10.5 22 7v10l-7-3.5" strokeLinecap="round" strokeLinejoin="round" />
          {!camOn && <path d="M3 3l18 18" strokeLinecap="round" />}
        </svg>
      </span>
    </span>
  );
}
