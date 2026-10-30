'use client';

import { useState } from 'react';
import { endpoints } from '@/lib/api';
import {
  PanelButton,
  PanelEmpty,
  PanelInput,
  PanelNote,
  PanelSection,
  PanelToggle,
  copyText,
  errorText,
  usePanelData,
} from './PanelKit';

interface EmbedState {
  enabled: boolean;
  allowedOrigins: string[];
}

/**
 * Embeddable player.
 *
 * The allow-list is the security boundary: an embed that accepts any origin is
 * an embed any site can frame, so a wildcard is refused here as well as on the
 * server.
 */
export function EmbedPanel({ webinarId }: { webinarId: string }) {
  const { data, loading, error, reload } = usePanelData(
    () =>
      endpoints.embed(webinarId) as Promise<{ embed: EmbedState; snippet: string }>,
    [webinarId]
  );

  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const embed = data?.embed ?? { enabled: false, allowedOrigins: [] };
  const snippet = data?.snippet ?? '';

  async function save(next: Partial<EmbedState>) {
    setBusy(true);
    try {
      await endpoints.setEmbed(webinarId, {
        enabled: next.enabled ?? embed.enabled,
        allowedOrigins: next.allowedOrigins ?? embed.allowedOrigins,
      });
      setNotice(null);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not save the embed settings'));
    } finally {
      setBusy(false);
    }
  }

  async function addOrigin() {
    const value = origin.trim().replace(/\/$/, '');
    if (!value) return;
    if (value === '*' || value.includes('*')) {
      setNotice('A wildcard origin is the same as no allow-list. Name the site explicitly.');
      return;
    }
    if (!/^https?:\/\//.test(value)) {
      setNotice('Include the scheme, for example https://example.com');
      return;
    }
    await save({ allowedOrigins: [...embed.allowedOrigins, value] });
    setOrigin('');
  }

  async function removeOrigin(value: string) {
    await save({ allowedOrigins: embed.allowedOrigins.filter((o) => o !== value) });
  }

  async function copySnippet() {
    const ok = await copyText(snippet);
    setCopied(ok);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <PanelSection
      title="Embed"
      description="Put the player on your own site. Only the origins you list may frame it."
    >
      {error && <PanelNote tone="error">{error}</PanelNote>}
      {notice && <PanelNote tone="warn">{notice}</PanelNote>}

      {loading ? (
        <PanelEmpty>Loading…</PanelEmpty>
      ) : (
        <>
          <PanelToggle
            checked={embed.enabled}
            onChange={(next) => void save({ enabled: next })}
            label="Allow embedding"
            hint="Off by default — a webinar is not public just because it has a link."
          />

          <div className="space-y-2">
            <p className="text-xs font-semibold text-fg">Allowed origins</p>
            {embed.allowedOrigins.length === 0 ? (
              <PanelNote tone="warn">
                No origins listed. Embedding stays blocked until you add at least one.
              </PanelNote>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {embed.allowedOrigins.map((value) => (
                  <li key={value} className="flex items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">
                      {value}
                    </span>
                    <PanelButton
                      variant="danger"
                      onClick={() => removeOrigin(value)}
                      disabled={busy}
                    >
                      Remove
                    </PanelButton>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <PanelInput
                value={origin}
                onChange={setOrigin}
                placeholder="https://example.com"
                className="min-w-[200px] flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addOrigin();
                }}
              />
              <PanelButton onClick={addOrigin} disabled={busy}>
                Add origin
              </PanelButton>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-fg">Embed snippet</p>
              <PanelButton onClick={copySnippet} disabled={!snippet}>
                {copied ? 'Copied' : 'Copy'}
              </PanelButton>
            </div>
            <pre className="overflow-x-auto rounded-xl border border-line bg-panel-2/60 p-3 font-mono text-[11px] leading-relaxed text-muted">
              {snippet || 'Enable embedding to generate a snippet.'}
            </pre>
          </div>
        </>
      )}
    </PanelSection>
  );
}
