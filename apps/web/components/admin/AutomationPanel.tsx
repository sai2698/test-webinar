'use client';

import { useRef, useState } from 'react';
import { endpoints } from '@/lib/api';
import {
  PanelButton,
  PanelEmpty,
  PanelNote,
  PanelSection,
  errorText,
  usePanelData,
} from './PanelKit';

interface Cue {
  id: string;
  kind: string;
  atMs: number;
  payload: Record<string, unknown>;
  enabled: boolean;
  firedAt: string | null;
}

function formatOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Automation bundle.
 *
 * A bundle is imported as a whole and validated strictly — a typo'd key would
 * otherwise import "successfully" and quietly do nothing, which is worse than a
 * rejection.
 */
export function AutomationPanel({ webinarId }: { webinarId: string }) {
  const { data, loading, error, reload } = usePanelData(
    () => endpoints.automationCues(webinarId) as Promise<{ cues: Cue[] }>,
    [webinarId]
  );

  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tone, setTone] = useState<'info' | 'warn' | 'error' | 'success'>('info');

  const cues = data?.cues ?? [];

  async function importFile(file: File) {
    setBusy(true);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as unknown;
      const result = await endpoints.importAutomation(webinarId, bundle);
      setTone('success');
      setNotice(
        `Imported ${result.summary.cues} cues, ${result.summary.personas} personas and ${result.summary.chatLines} chat lines.`
      );
      await reload();
    } catch (err) {
      setTone('error');
      setNotice(
        err instanceof SyntaxError
          ? 'That file is not valid JSON.'
          : errorText(err, 'Could not import that bundle')
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggle(cue: Cue) {
    setBusy(true);
    try {
      await endpoints.updateAutomationCue(cue.id, { enabled: !cue.enabled });
      await reload();
    } catch (err) {
      setTone('error');
      setNotice(errorText(err, 'Could not update that cue'));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await endpoints.resetAutomation(webinarId);
      setTone('info');
      setNotice('Cues reset — they will fire again on the next run.');
      await reload();
    } catch (err) {
      setTone('error');
      setNotice(errorText(err, 'Could not reset the cues'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelSection
      title="Automation"
      description="Scripted chat, Q&A, attendance and cues that replay a busy room."
      actions={
        <>
          <PanelButton onClick={() => window.open(endpoints.automationExportUrl(webinarId), '_blank')}>
            Export
          </PanelButton>
          <PanelButton onClick={reset} disabled={busy || cues.length === 0}>
            Reset cues
          </PanelButton>
          <PanelButton variant="primary" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? 'Working…' : 'Import bundle'}
          </PanelButton>
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importFile(file);
          e.target.value = '';
        }}
      />

      {error && <PanelNote tone="error">{error}</PanelNote>}
      {notice && <PanelNote tone={tone}>{notice}</PanelNote>}

      {loading ? (
        <PanelEmpty>Loading cues…</PanelEmpty>
      ) : cues.length === 0 ? (
        <PanelEmpty>No automation imported for this webinar.</PanelEmpty>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {cues.map((cue) => (
            <li key={cue.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span className="w-12 shrink-0 font-mono text-[11px] text-subtle">
                {formatOffset(cue.atMs)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-fg">{cue.kind}</p>
                <p className="truncate text-[11px] text-subtle">
                  {String(cue.payload.question ?? cue.payload.title ?? cue.payload.text ?? '—')}
                </p>
              </div>
              {cue.firedAt && (
                <span className="text-[10px] text-mint-600 dark:text-mint-300">fired</span>
              )}
              <PanelButton onClick={() => toggle(cue)} disabled={busy}>
                {cue.enabled ? 'Disable' : 'Enable'}
              </PanelButton>
            </li>
          ))}
        </ul>
      )}

      <PanelNote>
        A bundle is validated strictly on import — an unknown key is rejected rather than ignored,
        because a silently dropped cue looks like a working one.
      </PanelNote>
    </PanelSection>
  );
}
