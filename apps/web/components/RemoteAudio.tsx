'use client';

import { useEffect, useRef } from 'react';
import { useRoomStore } from '@/store/roomStore';

/**
 * Plays every remote audio producer.
 *
 * Audio and video arrive as **separate** mediasoup producers, so the video
 * tiles carry no audio at all — `VideoTile` is deliberately muted. Without a
 * component like this one, remote audio is consumed, stored in the room store,
 * and then never attached to anything: the participant sees the host's face but
 * hears nothing, and no error is logged anywhere because nothing failed.
 *
 * One `<audio>` element per audio producer, keyed by producer id, so a peer
 * with a microphone and a screen-share audio track gets two independent sinks.
 */
export function RemoteAudio() {
  const remoteStreams = useRoomStore((s) => s.remoteStreams);

  const audioStreams = Object.values(remoteStreams).filter((rs) => rs.kind === 'audio');

  return (
    <>
      {audioStreams.map((rs) => (
        <AudioSink key={rs.producerId} stream={rs.stream} paused={rs.paused} />
      ))}
    </>
  );
}

function AudioSink({ stream, paused }: { stream: MediaStream; paused: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (el.srcObject !== stream) el.srcObject = stream;

    /**
     * Autoplay with sound is blocked until the page has been interacted with.
     *
     * Unlike video, we cannot simply mute our way out of this — the whole point
     * is to hear the host. So: try immediately, and if the browser refuses,
     * retry on the first gesture anywhere in the document. A participant who
     * clicked "Join" has already produced a gesture, so in practice the first
     * attempt succeeds; the listener is for a tab that was opened directly.
     */
    const tryPlay = () => {
      el.play().catch(() => {
        const unlock = () => {
          el.play().catch(() => {
            /* still blocked — the next gesture will try again */
          });
        };
        document.addEventListener('pointerdown', unlock, { once: true });
        document.addEventListener('keydown', unlock, { once: true });
      });
    };

    tryPlay();

    return () => {
      // Detach so a removed producer's element does not keep the track alive.
      if (el.srcObject === stream) el.srcObject = null;
    };
  }, [stream]);

  // A paused producer still has a live track; muting is the honest way to
  // reflect "the host muted themselves" without tearing down the element.
  return <audio ref={ref} autoPlay playsInline muted={paused} className="hidden" />;
}
