'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { RecordingSummary } from '@webinar/shared';
import { endpoints } from '@/lib/api';

/**
 * Recordings for one webinar.
 *
 * A recording is only useful if the host can find it again, so this panel is
 * deliberately plain: status, length, how much happened, and a link to watch.
 */
export function RecordingsPanel({
  webinarId,
  premiereRecordingId,
  premiereStartedAt,
  onPremiereChange,
}: {
  webinarId: string;
  /** The recording currently attached as the premiere, if any. */
  premiereRecordingId?: string | null;
  /** ISO timestamp of the running premiere clock, or null. */
  premiereStartedAt?: string | null;
  /** Called after attach/detach/start/stop so the parent can refresh. */
  onPremiereChange?: () => void;
}) {
  const [rows, setRows] = useState<RecordingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await endpoints.recordings(webinarId);
      setRows(res.recordings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load recordings');
    } finally {
      setLoading(false);
    }
  }, [webinarId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: string) {
    setDeleting(id);
    try {
      await endpoints.deleteRecording(id);
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the recording');
    } finally {
      setDeleting(null);
    }
  }

  /**
   * Premiere actions. A premiere is a recording presented as a live session:
   * the recording is the content, the schedule is the event. Attaching one
   * turns the webinar into a pre-recorded session; starting it sets the clock
   * every viewer's position is derived from.
   */
  async function premiere(action: 'attach' | 'detach' | 'start' | 'stop', id?: string) {
    setBusy(action + (id ?? ''));
    setError(null);
    try {
      if (action === 'attach' && id) await endpoints.attachPremiere(webinarId, id);
      else if (action === 'detach') await endpoints.detachPremiere(webinarId);
      else if (action === 'start') await endpoints.startPremiere(webinarId);
      else await endpoints.stopPremiere(webinarId);
      onPremiereChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the premiere');
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p className="py-8 text-center text-xs text-subtle">Loading recordings…</p>;

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {error}
        </p>
      )}

      {rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center">
          <p className="text-xs font-semibold text-fg">No recordings yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[11px] text-subtle">
            Join the room as host and press <span className="text-fg">Start recording</span> in
            Host tools. Chat, quizzes and offers are captured automatically.
          </p>
        </div>
      )}

      {/* ── premiere status ─────────────────────────────── */}
      {premiereRecordingId && (
        <div className="rounded-xl border border-brand-500/30 bg-brand-500/[0.07] px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-fg">
                {premiereStartedAt ? 'Premiere is live' : 'Premiere ready'}
              </p>
              <p className="mt-0.5 text-[11px] text-subtle">
                {premiereStartedAt
                  ? `Started ${new Date(premiereStartedAt).toLocaleString()} — viewers join at the same point in the recording.`
                  : 'This webinar will play the attached recording instead of hosting live media.'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => premiere(premiereStartedAt ? 'start' : 'start')}
                disabled={busy !== null}
                className="btn-primary px-3 py-1.5 text-[11px] disabled:opacity-50"
              >
                {busy === 'start'
                  ? 'Starting…'
                  : premiereStartedAt
                    ? 'Re-run premiere'
                    : 'Start premiere'}
              </button>
              {premiereStartedAt && (
                <button
                  onClick={() => premiere('stop')}
                  disabled={busy !== null}
                  className="btn-ghost px-2.5 py-1.5 text-[11px] disabled:opacity-50"
                >
                  {busy === 'stop' ? 'Ending…' : 'End'}
                </button>
              )}
              <button
                onClick={() => premiere('detach')}
                disabled={busy !== null}
                className="btn-ghost px-2.5 py-1.5 text-[11px] text-red-500 hover:text-red-600 disabled:opacity-50 dark:text-red-400"
              >
                {busy === 'detach' ? 'Detaching…' : 'Detach'}
              </button>
            </div>
          </div>
        </div>
      )}

      {rows.map((r) => (
        <div
          key={r.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel-2 px-4 py-3"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusPill status={r.status} />
              <span className="font-mono text-[11px] text-muted">{formatClock(r.durationMs)}</span>
              <span className="text-[11px] text-line">·</span>
              <span className="text-[11px] text-subtle">{r.eventCount} events</span>
              {r.mediaKind === 'video' && r.mediaBytes ? (
                <>
                  <span className="text-[11px] text-line">·</span>
                  <span className="text-[11px] text-subtle">{formatBytes(r.mediaBytes)}</span>
                </>
              ) : (
                <>
                  <span className="text-[11px] text-line">·</span>
                  <span className="text-[11px] text-subtle">timeline only</span>
                </>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-subtle">
              {new Date(r.startedAt).toLocaleString()}
            </p>
            {r.error && (
              <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">{r.error}</p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {r.status === 'READY' && (
              <Link href={`/replay/${r.id}`} className="btn-primary px-3 py-1.5 text-[11px]">
                Watch replay
              </Link>
            )}
            {r.status === 'READY' && premiereRecordingId !== r.id && (
              <button
                onClick={() => premiere('attach', r.id)}
                disabled={busy !== null}
                className="btn-ghost px-2.5 py-1.5 text-[11px] disabled:opacity-50"
                title="Play this recording as a scheduled live session"
              >
                {busy === 'attach' + r.id ? 'Attaching…' : 'Use as premiere'}
              </button>
            )}
            {premiereRecordingId === r.id && (
              <span className="chip py-1 text-[10px] text-brand-600 dark:text-brand-300">
                Premiere
              </span>
            )}
            <button
              onClick={() => remove(r.id)}
              disabled={deleting === r.id}
              className="btn-ghost px-2.5 py-1.5 text-[11px] text-red-500 hover:text-red-600 disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
            >
              {deleting === r.id ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: RecordingSummary['status'] }) {
  const styles: Record<RecordingSummary['status'], string> = {
    RECORDING: 'border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-300',
    PROCESSING: 'border-sky-500/30 bg-sky-500/15 text-sky-600 dark:text-sky-300',
    READY: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    FAILED: 'border-red-500/30 bg-red-500/15 text-red-600 dark:text-red-300',
  };
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${styles[status]}`}>
      {status}
    </span>
  );
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
