'use client';

import { useState } from 'react';
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

interface Token {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * Public API tokens.
 *
 * The plaintext is shown exactly once, at creation. Only a hash is stored, so a
 * database dump cannot hand an attacker working credentials — which also means
 * a lost token cannot be recovered, only replaced.
 */
export function ApiTokensPanel() {
  const { data, loading, error, reload } = usePanelData(
    () => endpoints.apiTokens() as Promise<{ tokens: Token[] }>,
    []
  );

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [plaintext, setPlaintext] = useState<string | null>(null);

  const tokens = data?.tokens ?? [];

  async function create() {
    if (!name.trim()) {
      setNotice('Give the token a name so you can tell it apart later.');
      return;
    }
    setBusy(true);
    try {
      const result = await endpoints.createApiToken(name.trim());
      setPlaintext(result.plaintext);
      setName('');
      setNotice(null);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not create that token'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await endpoints.revokeApiToken(id);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not revoke that token'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelSection
      title="API tokens"
      description="Read-only access to your webinars over the public API."
    >
      {error && <PanelNote tone="error">{error}</PanelNote>}
      {notice && <PanelNote tone="warn">{notice}</PanelNote>}

      {plaintext && (
        <div className="rounded-xl border border-mint-500/30 bg-mint-500/10 p-3">
          <p className="text-xs font-semibold text-mint-700 dark:text-mint-300">
            Copy this now — it is not shown again
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-panel px-2 py-1.5 font-mono text-[11px] text-fg">
              {plaintext}
            </code>
            <PanelButton onClick={() => void copyText(plaintext)}>Copy</PanelButton>
            <PanelButton onClick={() => setPlaintext(null)}>Dismiss</PanelButton>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">
            Send it as <code className="font-mono">Authorization: Bearer &lt;token&gt;</code> to{' '}
            <code className="font-mono">/api/v1</code>.
          </p>
        </div>
      )}

      {loading ? (
        <PanelEmpty>Loading tokens…</PanelEmpty>
      ) : tokens.length === 0 ? (
        <PanelEmpty>No API tokens yet.</PanelEmpty>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {tokens.map((token) => (
            <li key={token.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-fg">{token.name}</p>
                <p className="font-mono text-[11px] text-subtle">
                  {token.prefix}••••••••
                  {token.lastUsedAt
                    ? ` · last used ${new Date(token.lastUsedAt).toLocaleDateString()}`
                    : ' · never used'}
                </p>
              </div>
              {token.revokedAt ? (
                <span className="text-[10px] text-subtle">revoked</span>
              ) : (
                <PanelButton variant="danger" onClick={() => revoke(token.id)} disabled={busy}>
                  Revoke
                </PanelButton>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 rounded-xl border border-line bg-panel-2/40 p-3">
        <PanelInput
          value={name}
          onChange={setName}
          placeholder="Token name, e.g. Zapier"
          className="min-w-[200px] flex-1"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
        />
        <PanelButton variant="primary" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : 'Create token'}
        </PanelButton>
      </div>
    </PanelSection>
  );
}
