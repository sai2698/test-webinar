'use client';

import { useState } from 'react';
import { endpoints, type WebhookDeliveryRow } from '@/lib/api';
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

interface Endpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

interface Delivery {
  id: string;
  event: string;
  status: string;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
}

type DeliveryRow = WebhookDeliveryRow;

/**
 * Webhook endpoints.
 *
 * Deliveries are an outbox, not an inline POST — a slow customer endpoint must
 * never block a socket handler — so this panel shows the retry log rather than
 * pretending a send is synchronous.
 */
export function WebhooksPanel() {
  const { data, loading, error, reload } = usePanelData(
    () => endpoints.webhooks() as Promise<{ endpoints: Endpoint[] }>,
    []
  );
  const { data: catalogue } = usePanelData(
    () => endpoints.webhookEvents() as Promise<{ events: string[] }>,
    []
  );

  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<string[]>(['*']);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);

  const endpointsList = data?.endpoints ?? [];
  const events = catalogue?.events ?? [];

  async function create() {
    if (!/^https?:\/\//.test(url.trim())) {
      setNotice('The URL must start with http:// or https://');
      return;
    }
    if (selected.length === 0) {
      setNotice('Pick at least one event.');
      return;
    }
    setBusy('create');
    try {
      const result = await endpoints.createWebhook({ url: url.trim(), events: selected });
      setSecret(result.secret);
      setUrl('');
      setSelected(['*']);
      setNotice(null);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not create that endpoint'));
    } finally {
      setBusy(null);
    }
  }

  async function rotate(id: string) {
    setBusy(id);
    try {
      const result = await endpoints.rotateWebhook(id);
      setSecret(result.secret);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not rotate the secret'));
    } finally {
      setBusy(null);
    }
  }

  async function toggleActive(endpoint: Endpoint) {
    setBusy(endpoint.id);
    try {
      await endpoints.updateWebhook(endpoint.id, { active: !endpoint.active });
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not update that endpoint'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await endpoints.deleteWebhook(id);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not delete that endpoint'));
    } finally {
      setBusy(null);
    }
  }

  async function showLog(id: string) {
    if (openLog === id) {
      setOpenLog(null);
      return;
    }
    setOpenLog(id);
    try {
      const result = await endpoints.webhookDeliveries(id);
      setDeliveries(result.deliveries);
    } catch (err) {
      setNotice(errorText(err, 'Could not load the delivery log'));
    }
  }

  return (
    <PanelSection
      title="Webhooks"
      description="POST a signed JSON body to your own server when something happens."
    >
      {error && <PanelNote tone="error">{error}</PanelNote>}
      {notice && <PanelNote tone="warn">{notice}</PanelNote>}

      {secret && (
        <div className="rounded-xl border border-mint-500/30 bg-mint-500/10 p-3">
          <p className="text-xs font-semibold text-mint-700 dark:text-mint-300">
            Signing secret — shown once
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-panel px-2 py-1.5 font-mono text-[11px] text-fg">
              {secret}
            </code>
            <PanelButton onClick={() => void copyText(secret)}>Copy</PanelButton>
            <PanelButton onClick={() => setSecret(null)}>Dismiss</PanelButton>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">
            Verify each request with <code className="font-mono">X-Webinar-Signature</code> — an
            HMAC-SHA256 of the raw body.
          </p>
        </div>
      )}

      {loading ? (
        <PanelEmpty>Loading endpoints…</PanelEmpty>
      ) : endpointsList.length === 0 ? (
        <PanelEmpty>No webhook endpoints yet.</PanelEmpty>
      ) : (
        <ul className="space-y-2">
          {endpointsList.map((endpoint) => (
            <li key={endpoint.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11px] text-fg">{endpoint.url}</p>
                  <p className="text-[11px] text-subtle">
                    {endpoint.events.includes('*')
                      ? 'all events'
                      : `${endpoint.events.length} events`}
                    {!endpoint.active && ' · paused'}
                  </p>
                </div>
                <PanelButton onClick={() => showLog(endpoint.id)} disabled={busy === endpoint.id}>
                  {openLog === endpoint.id ? 'Hide log' : 'Log'}
                </PanelButton>
                <PanelButton onClick={() => toggleActive(endpoint)} disabled={busy === endpoint.id}>
                  {endpoint.active ? 'Pause' : 'Resume'}
                </PanelButton>
                <PanelButton onClick={() => rotate(endpoint.id)} disabled={busy === endpoint.id}>
                  Rotate secret
                </PanelButton>
                <PanelButton
                  variant="danger"
                  onClick={() => remove(endpoint.id)}
                  disabled={busy === endpoint.id}
                >
                  Delete
                </PanelButton>
              </div>

              {openLog === endpoint.id && (
                <div className="mt-2.5 overflow-x-auto rounded-lg border border-line">
                  {deliveries.length === 0 ? (
                    <p className="px-3 py-3 text-center text-[11px] text-subtle">
                      Nothing delivered yet.
                    </p>
                  ) : (
                    <table className="w-full text-left text-[11px]">
                      <thead>
                        <tr className="border-b border-line text-[10px] uppercase tracking-wider text-subtle">
                          <th className="px-2 py-1.5 font-medium">Event</th>
                          <th className="px-2 py-1.5 font-medium">Status</th>
                          <th className="px-2 py-1.5 font-medium">Tries</th>
                          <th className="px-2 py-1.5 font-medium">Response</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {deliveries.map((d) => (
                          <tr key={d.id}>
                            <td className="px-2 py-1.5 font-mono text-fg">{d.event}</td>
                            <td className="px-2 py-1.5">
                              <span
                                className={
                                  d.status === 'DELIVERED'
                                    ? 'text-mint-600 dark:text-mint-300'
                                    : d.status === 'FAILED'
                                      ? 'text-red-600 dark:text-red-300'
                                      : 'text-subtle'
                                }
                              >
                                {d.status}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-subtle">{d.attempts}</td>
                            <td className="max-w-[220px] truncate px-2 py-1.5 text-subtle">
                              {d.lastStatus ?? '—'}
                              {d.lastError && ` · ${d.lastError}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-xl border border-line bg-panel-2/40 p-3">
        <div className="flex flex-wrap gap-2">
          <PanelInput
            value={url}
            onChange={setUrl}
            placeholder="https://example.com/hooks/webinar"
            className="min-w-[220px] flex-1"
          />
          <PanelButton variant="primary" onClick={create} disabled={busy === 'create'}>
            {busy === 'create' ? 'Creating…' : 'Add endpoint'}
          </PanelButton>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelected(['*'])}
            className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition ${
              selected.includes('*')
                ? 'bg-brand-500 text-white'
                : 'border border-line text-muted hover:bg-panel-2'
            }`}
          >
            All events
          </button>
          {events.map((event) => {
            const on = selected.includes(event);
            return (
              <button
                key={event}
                onClick={() =>
                  setSelected((prev) => {
                    if (prev.includes('*')) return [event];
                    return on ? prev.filter((e) => e !== event) : [...prev, event];
                  })
                }
                className={`rounded-full px-2.5 py-1 font-mono text-[10px] transition ${
                  on
                    ? 'bg-brand-500 text-white'
                    : 'border border-line text-muted hover:bg-panel-2'
                }`}
              >
                {event}
              </button>
            );
          })}
        </div>
      </div>
    </PanelSection>
  );
}
