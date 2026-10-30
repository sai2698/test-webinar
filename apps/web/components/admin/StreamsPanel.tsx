'use client';

import { useState } from 'react';
import { STREAM_PLATFORMS } from '@webinar/shared';
import { endpoints } from '@/lib/api';
import {
  PanelButton,
  PanelEmpty,
  PanelInput,
  PanelNote,
  PanelSection,
  copyText,
  errorText,
  usePanelData,
} from './PanelKit';

interface Destination {
  id: string;
  platform: string;
  keyHint: string;
  rtmpUrl: string | null;
  createdAt: string;
}

const PLATFORM_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  facebook: 'Facebook Live',
  linkedin: 'LinkedIn Live',
  twitch: 'Twitch',
  custom: 'Custom RTMP',
};

/**
 * Simulcast destinations.
 *
 * The stream key is write-only: the server returns only the last four
 * characters, because a key in a list response is a key in a browser cache, a
 * screenshot and a support ticket.
 */
export function StreamsPanel({ webinarId, isLive }: { webinarId: string; isLive: boolean }) {
  const { data, loading, error, reload } = usePanelData(
    () =>
      endpoints.streamDestinations(webinarId) as Promise<{
        destinations: Destination[];
        locked: boolean;
      }>,
    [webinarId]
  );

  const [platform, setPlatform] = useState('youtube');
  const [streamKey, setStreamKey] = useState('');
  const [rtmpUrl, setRtmpUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const destinations = data?.destinations ?? [];
  const locked = data?.locked ?? isLive;

  async function add() {
    if (!streamKey.trim()) {
      setNotice('Paste the stream key from the platform.');
      return;
    }
    setBusy(true);
    try {
      await endpoints.addStreamDestination(webinarId, {
        platform,
        streamKey: streamKey.trim(),
        rtmpUrl: rtmpUrl.trim() || undefined,
      });
      setStreamKey('');
      setRtmpUrl('');
      setNotice(null);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not save that destination'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await endpoints.deleteStreamDestination(id);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not remove that destination'));
    } finally {
      setBusy(false);
    }
  }

  async function copyCommand() {
    const { command } = await endpoints.streamFfmpeg(webinarId);
    const ok = await copyText(command);
    setCopied(ok);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <PanelSection
      title="Simulcast"
      description="Push the session to YouTube, Facebook, LinkedIn or any RTMP endpoint."
      actions={
        <PanelButton onClick={copyCommand} disabled={destinations.length === 0}>
          {copied ? 'Copied' : 'Copy FFmpeg command'}
        </PanelButton>
      }
    >
      {error && <PanelNote tone="error">{error}</PanelNote>}
      {notice && <PanelNote tone="warn">{notice}</PanelNote>}

      {locked && (
        <PanelNote tone="warn">
          Destinations are locked while the session is live. Changing a stream key mid-broadcast
          would silently kill the feed, so stop the session first.
        </PanelNote>
      )}

      {loading ? (
        <PanelEmpty>Loading destinations…</PanelEmpty>
      ) : destinations.length === 0 ? (
        <PanelEmpty>No destinations yet.</PanelEmpty>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {destinations.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-fg">
                  {PLATFORM_LABELS[d.platform] ?? d.platform}
                </p>
                <p className="font-mono text-[11px] text-subtle">
                  key ••••{d.keyHint}
                  {d.rtmpUrl && ` · ${d.rtmpUrl}`}
                </p>
              </div>
              <PanelButton variant="danger" onClick={() => remove(d.id)} disabled={busy || locked}>
                Remove
              </PanelButton>
            </li>
          ))}
        </ul>
      )}

      {!locked && (
        <div className="space-y-2 rounded-xl border border-line bg-panel-2/40 p-3">
          <div className="flex flex-wrap gap-2">
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="h-8 rounded-lg border border-line bg-panel px-2 text-xs text-fg outline-none focus:border-brand-500/50"
            >
              {STREAM_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABELS[p] ?? p}
                </option>
              ))}
            </select>
            <PanelInput
              value={streamKey}
              onChange={setStreamKey}
              placeholder="Stream key"
              type="password"
              className="min-w-[180px] flex-1"
            />
            {platform === 'custom' && (
              <PanelInput
                value={rtmpUrl}
                onChange={setRtmpUrl}
                placeholder="rtmp://host/app"
                className="min-w-[180px] flex-1"
              />
            )}
            <PanelButton variant="primary" onClick={add} disabled={busy}>
              {busy ? 'Saving…' : 'Add destination'}
            </PanelButton>
          </div>
          <p className="text-[11px] text-subtle">
            The key is stored write-only — this page will only ever show its last four characters.
          </p>
        </div>
      )}
    </PanelSection>
  );
}
