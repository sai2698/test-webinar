'use client';

import { useMemo } from 'react';
import { useRoomStore } from '@/store/roomStore';
import { VideoTile } from './VideoTile';

export function VideoGrid() {
  const peers = useRoomStore((s) => s.peers);
  const remoteStreams = useRoomStore((s) => s.remoteStreams);
  const localStream = useRoomStore((s) => s.localStream);
  const screenStream = useRoomStore((s) => s.screenStream);
  const selfPeerId = useRoomStore((s) => s.peerId);
  const self = useRoomStore((s) => s.self);
  const micOn = useRoomStore((s) => s.micOn);
  const camOn = useRoomStore((s) => s.camOn);
  const spotlightedPeerId = useRoomStore((s) => s.spotlightedPeerId);

  const { tiles, screenTile } = useMemo(() => {
    const list: {
      key: string;
      peerId: string;
      name: string;
      role: string;
      stream: MediaStream | null;
      isLocal: boolean;
      micOn: boolean;
      camOn: boolean;
      paused: boolean;
      isScreen: boolean;
      producerId?: string;
    }[] = [];
    let screen: (typeof list)[number] | null = null;

    /**
     * The server's snapshot deliberately omits you from `peers` — you are not
     * a remote participant to yourself. Anything that renders a roster has to
     * add `self` back, or a host alone in the room sees an empty grid and
     * concludes the page is broken.
     */
    const everyone = [...Object.values(peers)];
    if (self && selfPeerId && !everyone.some((p) => p.peerId === selfPeerId)) {
      everyone.push({ ...self, peerId: selfPeerId });
    }

    for (const peer of everyone) {
      const isLocal = peer.peerId === selfPeerId;
      const videoStreams = Object.values(remoteStreams).filter(
        (rs) => rs.peerId === peer.peerId && rs.kind === 'video'
      );

      if (isLocal) {
        // Your own screen share takes the stage; your camera stays in the strip.
        if (screenStream) {
          screen = {
            key: `${peer.peerId}:screen`,
            peerId: peer.peerId,
            name: peer.name,
            role: peer.role,
            stream: screenStream,
            isLocal: true,
            micOn,
            camOn: true,
            paused: false,
            isScreen: true,
          };
        }

        list.push({
          key: peer.peerId,
          peerId: peer.peerId,
          name: peer.name,
          role: peer.role,
          stream: localStream,
          isLocal: true,
          micOn,
          camOn,
          paused: false,
          isScreen: false,
        });
        continue;
      }

      if (videoStreams.length === 0) {
        // Audio-only peer — still show a tile so they are visible.
        list.push({
          key: peer.peerId,
          peerId: peer.peerId,
          name: peer.name,
          role: peer.role,
          stream: null,
          isLocal: false,
          micOn: true,
          camOn: false,
          paused: false,
          isScreen: false,
        });
        continue;
      }

      for (const rs of videoStreams) {
        const tile = {
          key: rs.producerId,
          peerId: peer.peerId,
          name: peer.name,
          role: peer.role,
          stream: rs.stream,
          isLocal: false,
          micOn: true,
          camOn: true,
          paused: rs.paused,
          isScreen: rs.source === 'screen',
          producerId: rs.producerId,
        };

        if (tile.isScreen) {
          // Only one presentation is on stage at a time — first one wins.
          if (!screen) screen = tile;
          else list.push(tile);
        } else {
          list.push(tile);
        }
      }
    }

    // Staff first, then speakers, then everyone else.
    const rank = (r: string) => (r === 'HOST' ? 0 : r === 'ADMIN' ? 1 : r === 'MODERATOR' ? 2 : 3);
    list.sort((a, b) => rank(a.role) - rank(b.role));
    return { tiles: list, screenTile: screen as (typeof list)[number] | null };
  }, [peers, self, remoteStreams, localStream, screenStream, selfPeerId, micOn, camOn]);
  if (tiles.length === 0 && !screenTile) {
    return (
      <div className="grid h-full place-items-center rounded-2xl border border-white/10 bg-ink-900/60">
        <div className="text-center">
          <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-brand-400" />
          <p className="text-sm text-slate-500">Waiting for the host to start…</p>
        </div>
      </div>
    );
  }

  /* ── presentation layout: screen on stage, cameras in a filmstrip ── */
  if (screenTile) {
    return (
      <div className="flex h-full flex-col gap-3">
        <div className="min-h-0 flex-1">
          <VideoTile
            stream={screenTile.stream}
            name={screenTile.name}
            role={screenTile.role}
            isLocal={screenTile.isLocal}
            micOn={screenTile.micOn}
            camOn={screenTile.camOn}
            paused={screenTile.paused}
            isScreen
            className="h-full"
          />
        </div>

        {tiles.length > 0 && (
          <div className="flex shrink-0 gap-3 overflow-x-auto pb-1">
            {tiles.map((tile) => (
              <VideoTile
                key={tile.key}
                stream={tile.stream}
                name={tile.name}
                role={tile.role}
                isLocal={tile.isLocal}
                micOn={tile.micOn}
                camOn={tile.camOn}
                paused={tile.paused}
                producerId={tile.producerId}
                layer={0}
                className="h-24 w-40 shrink-0 sm:h-28 sm:w-48"
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const cols =
    tiles.length === 1
      ? 'grid-cols-1'
      : tiles.length === 2
        ? 'grid-cols-1 sm:grid-cols-2'
        : tiles.length <= 4
          ? 'grid-cols-1 sm:grid-cols-2'
          : 'grid-cols-2 lg:grid-cols-3';

  /* ── spotlight layout: one peer on stage, everyone else in a strip ── */
  const spotlightTile = spotlightedPeerId
    ? tiles.find((t) => t.peerId === spotlightedPeerId)
    : undefined;

  if (spotlightTile) {
    const rest = tiles.filter((t) => t.key !== spotlightTile.key);
    return (
      <div className="flex h-full flex-col gap-3">
        <div className="min-h-0 flex-1">
          <VideoTile
            stream={spotlightTile.stream}
            name={spotlightTile.name}
            role={spotlightTile.role}
            isLocal={spotlightTile.isLocal}
            micOn={spotlightTile.micOn}
            camOn={spotlightTile.camOn}
            paused={spotlightTile.paused}
            producerId={spotlightTile.producerId}
            layer={2}
            className="h-full"
          />
        </div>

        {rest.length > 0 && (
          <div className="flex shrink-0 gap-3 overflow-x-auto pb-1">
            {rest.map((tile) => (
              <VideoTile
                key={tile.key}
                stream={tile.stream}
                name={tile.name}
                role={tile.role}
                isLocal={tile.isLocal}
                micOn={tile.micOn}
                camOn={tile.camOn}
                paused={tile.paused}
                producerId={tile.producerId}
                layer={0}
                className="h-24 w-40 shrink-0 sm:h-28 sm:w-48"
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Up to six tiles fit on screen at a comfortable size, so the grid can
  // stretch to fill the stage. Past that the grid scrolls with a fixed row
  // height — which is also what makes the per-tile lazy loading worthwhile.
  const crowded = tiles.length > 6;

  return (
    <div
      className={`grid gap-3 ${cols} ${
        crowded ? 'h-full auto-rows-[minmax(160px,1fr)] overflow-y-auto pr-1' : 'h-full auto-rows-fr'
      }`}
    >
      {tiles.map((tile) => (
        <VideoTile
          key={tile.key}
          stream={tile.stream}
          name={tile.name}
          role={tile.role}
          isLocal={tile.isLocal}
          micOn={tile.micOn}
          camOn={tile.camOn}
          paused={tile.paused}
          producerId={tile.producerId}
          // Small grids get the high layer; once the grid is crowded every
          // tile is small enough that the middle layer is indistinguishable.
          layer={tiles.length <= 4 ? 2 : 1}
          className="min-h-[160px]"
        />
      ))}
    </div>
  );
}
