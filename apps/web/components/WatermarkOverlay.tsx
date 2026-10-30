'use client';

import { useRoomStore } from '@/store/roomStore';

/**
 * A faint, non-dismissible label drawn over the stage.
 *
 * The host turns this on when the content is worth leaking. It carries the
 * viewer's own name and id, so a screen recording that escapes the room can be
 * traced back to the account that made it — which is the entire point. It is
 * deliberately not a modal: it must never block the session, only mark it.
 *
 * `pointer-events-none` keeps it from stealing clicks from the video controls,
 * and `select-none` stops it being copied out of the DOM by hand.
 */
export function WatermarkOverlay() {
  const watermark = useRoomStore((s) => s.watermark);
  if (!watermark?.enabled) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 select-none overflow-hidden"
    >
      {/* Two diagonal bands rather than a single centred mark: one is easy to
          crop out of a recording, two are not. */}
      <div className="absolute inset-0 flex flex-col justify-around opacity-[0.13]">
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className="flex -rotate-12 justify-around whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.3em] text-white"
          >
            {[0, 1, 2, 3].map((col) => (
              <span key={col}>
                {watermark.label} · {watermark.userId.slice(-6)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
