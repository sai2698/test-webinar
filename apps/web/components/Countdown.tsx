'use client';

import { useEffect, useMemo, useState } from 'react';

interface CountdownProps {
  target: string | number | Date;
  onComplete?: () => void;
  compact?: boolean;
}

function pad(n: number) {
  return String(Math.max(0, n)).padStart(2, '0');
}

export function Countdown({ target, onComplete, compact = false }: CountdownProps) {
  const targetMs = useMemo(
    () => (target instanceof Date ? target.getTime() : new Date(target).getTime()),
    [target]
  );

  const [now, setNow] = useState(() => Date.now());
  const [done, setDone] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const diff = Math.max(0, targetMs - now);

  useEffect(() => {
    if (diff === 0 && !done) {
      setDone(true);
      onComplete?.();
    }
  }, [diff, done, onComplete]);

  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);

  if (compact) {
    return (
      <span className="font-mono text-sm tabular-nums text-slate-300">
        {days > 0 && `${days}d `}
        {pad(hours)}:{pad(minutes)}:{pad(seconds)}
      </span>
    );
  }

  const cells = [
    { label: 'Days', value: days },
    { label: 'Hours', value: hours },
    { label: 'Minutes', value: minutes },
    { label: 'Seconds', value: seconds },
  ];

  return (
    <div className="flex items-stretch gap-2 sm:gap-3">
      {cells.map((cell, i) => (
        <div key={cell.label} className="flex items-stretch gap-2 sm:gap-3">
          <div className="group relative min-w-[68px] overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.09] to-white/[0.02] px-3 py-3 text-center shadow-card backdrop-blur-xl sm:min-w-[84px] sm:px-4 sm:py-4">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
            <div className="font-mono text-2xl font-bold tabular-nums tracking-tight text-white sm:text-3xl">
              {pad(cell.value)}
            </div>
            <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              {cell.label}
            </div>
          </div>
          {i < cells.length - 1 && (
            <div className="flex items-center text-xl font-bold text-white/20">:</div>
          )}
        </div>
      ))}
    </div>
  );
}
