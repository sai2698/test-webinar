'use client';

import { useEffect, useRef, useState } from 'react';
import { useRoomStore } from '@/store/roomStore';

/**
 * A short-lived banner over the stage announcing a purchase.
 *
 * The chat line is the durable record; this is the moment of delight. It is
 * driven off the same `enrollment` system message rather than a second socket
 * event, so the two can never disagree about who enrolled.
 *
 * Anchored to the stage container (not `position: fixed`) so it sits over the
 * video and not over the sidebar or the control bar.
 */
export function EnrollmentBanner() {
  const messages = useRoomStore((s) => s.messages);
  const [banner, setBanner] = useState<{ id: string; text: string } | null>(null);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    const latest = [...messages]
      .reverse()
      .find((m) => m.system && m.kind === 'enrollment');
    if (!latest || latest.id === seen.current) return;

    seen.current = latest.id;
    // The toast is a sentence about what just happened, so it reads
    // differently from the chat card's "Congratulations! … for Enrolling".
    // `actor` is absent on lines replayed from an older recording, where the
    // server's own sentence is the only thing available.
    setBanner({
      id: latest.id,
      text: latest.actor ? `${latest.actor} just enrolled in the course.` : latest.text,
    });

    const timer = setTimeout(() => setBanner(null), 6000);
    return () => clearTimeout(timer);
  }, [messages]);

  if (!banner) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
      <div className="animate-fade-up flex items-center gap-2 rounded-full border border-brand-400/40 bg-brand-600/90 px-4 py-2 shadow-lg backdrop-blur">
        <span className="text-sm">👑</span>
        <p className="text-[12px] font-semibold text-white">{banner.text}</p>
      </div>
    </div>
  );
}
