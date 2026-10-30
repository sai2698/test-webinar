'use client';

import { useState } from 'react';
import { API_URL, endpoints } from '@/lib/api';
import {
  PanelButton,
  PanelEmpty,
  PanelInput,
  PanelNote,
  PanelSection,
  errorText,
  usePanelData,
} from './PanelKit';

interface RegistrationRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  statusNote: string | null;
  paid: boolean;
  attended: boolean;
  createdAt: string;
  responses: { fieldId: string; label: string; type: string; value: unknown }[];
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-amber-500/12 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  APPROVED: 'bg-mint-500/12 text-mint-600 ring-mint-500/30 dark:text-mint-300',
  REJECTED: 'bg-red-500/12 text-red-600 ring-red-500/30 dark:text-red-300',
  WAITLISTED: 'bg-brand-500/12 text-brand-600 ring-brand-500/30 dark:text-brand-300',
  CANCELLED: 'bg-panel-2 text-subtle ring-line',
};

const FILTERS = ['ALL', 'PENDING', 'APPROVED', 'WAITLISTED', 'REJECTED', 'CANCELLED'] as const;

/**
 * The approval queue.
 *
 * Deliberately shows every status rather than only the pending ones: a host who
 * rejected someone by mistake needs to find that row again, and a filter is
 * cheaper than an undo.
 */
export function ApprovalPanel({ webinarId }: { webinarId: string }) {
  const { data, loading, error, reload } = usePanelData(
    () =>
      endpoints.adminRegistrations(webinarId) as Promise<{
        registrations: RegistrationRow[];
        counts: Record<string, number>;
      }>,
    [webinarId]
  );

  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = data?.registrations ?? [];
  const counts = data?.counts ?? {};
  const visible = filter === 'ALL' ? rows : rows.filter((r) => r.status === filter);

  async function setStatus(row: RegistrationRow, status: string) {
    setBusy(row.id);
    try {
      await endpoints.setRegistrationStatus(row.id, status);
      setNotice(null);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not update that registration'));
    } finally {
      setBusy(null);
    }
  }

  async function approveAll() {
    setBusy('all');
    try {
      const result = await endpoints.approveAllRegistrations(webinarId);
      setNotice(
        result.approved === 0
          ? 'Nobody was waiting for approval.'
          : `Approved ${result.approved} ${result.approved === 1 ? 'person' : 'people'}.`
      );
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not approve the queue'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <PanelSection
      title="Approval queue"
      description="Decide who gets in. Approving emails the attendee their join link."
      actions={
        <>
          <PanelButton
            onClick={() => window.open(endpoints.registrationsExportUrl(webinarId), '_blank')}
          >
            Export CSV
          </PanelButton>
          <PanelButton
            variant="primary"
            onClick={approveAll}
            disabled={busy !== null || (counts.PENDING ?? 0) === 0}
          >
            {busy === 'all' ? 'Approving…' : `Approve all (${counts.PENDING ?? 0})`}
          </PanelButton>
        </>
      }
    >
      {error && <PanelNote tone="error">{error}</PanelNote>}
      {notice && <PanelNote tone="info">{notice}</PanelNote>}

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((key) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
              filter === key
                ? 'bg-brand-500 text-white'
                : 'border border-line text-muted hover:bg-panel-2 hover:text-fg'
            }`}
          >
            {key === 'ALL' ? 'All' : key.charAt(0) + key.slice(1).toLowerCase()}
            {key !== 'ALL' && counts[key] ? ` (${counts[key]})` : ''}
          </button>
        ))}
      </div>

      {loading ? (
        <PanelEmpty>Loading registrations…</PanelEmpty>
      ) : visible.length === 0 ? (
        <PanelEmpty>
          {filter === 'PENDING'
            ? 'Nobody is waiting for approval.'
            : 'No registrations match this filter.'}
        </PanelEmpty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-wider text-subtle">
                <th className="px-3 py-2 font-medium">Attendee</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Answers</th>
                <th className="px-3 py-2 text-right font-medium">Decision</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visible.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-fg">{row.name}</p>
                    <p className="text-[11px] text-subtle">{row.email}</p>
                    {row.phone && <p className="text-[11px] text-subtle">{row.phone}</p>}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${
                        STATUS_STYLES[row.status] ?? STATUS_STYLES.CANCELLED
                      }`}
                    >
                      {row.status}
                    </span>
                    {row.attended && (
                      <p className="mt-1 text-[10px] text-mint-600 dark:text-mint-300">attended</p>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {row.responses.length === 0 ? (
                      <span className="text-subtle">—</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {row.responses.map((r) => (
                          <li key={r.fieldId} className="text-[11px] text-muted">
                            <span className="text-subtle">{r.label}:</span>{' '}
                            {Array.isArray(r.value) ? r.value.join(', ') : String(r.value ?? '—')}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {row.status !== 'APPROVED' && (
                        <PanelButton
                          variant="primary"
                          onClick={() => setStatus(row, 'APPROVED')}
                          disabled={busy === row.id}
                        >
                          Approve
                        </PanelButton>
                      )}
                      {row.status !== 'WAITLISTED' && (
                        <PanelButton
                          onClick={() => setStatus(row, 'WAITLISTED')}
                          disabled={busy === row.id}
                        >
                          Waitlist
                        </PanelButton>
                      )}
                      {row.status !== 'REJECTED' && (
                        <PanelButton
                          variant="danger"
                          onClick={() => setStatus(row, 'REJECTED')}
                          disabled={busy === row.id}
                        >
                          Reject
                        </PanelButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelSection>
  );
}

/**
 * Bulk invite by email.
 *
 * An invite creates a real registration, so an invitee who clicks the link
 * lands in the room and counts as attended — the invite *is* the signup.
 */
export function InvitePanel({ webinarId }: { webinarId: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<
    { email: string; invited: boolean; reason?: string }[] | null
  >(null);

  async function send() {
    const emails = text
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter((e) => e.includes('@'));

    if (emails.length === 0) {
      setNotice('Paste at least one email address.');
      return;
    }

    setBusy(true);
    try {
      const result = await endpoints.invite(webinarId, emails);
      setResults(result.results);
      setNotice(
        `Invited ${result.invited} of ${emails.length}. Each one received a join link.`
      );
      setText('');
    } catch (err) {
      setNotice(errorText(err, 'Could not send the invites'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelSection
      title="Invite by email"
      description="Each address becomes a registration with its own join link."
    >
      {notice && <PanelNote tone="info">{notice}</PanelNote>}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="asha@example.com, ravi@example.com"
        className="w-full rounded-xl border border-line bg-panel px-3 py-2 text-xs text-fg outline-none placeholder:text-subtle focus:border-brand-500/50"
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-subtle">
          Separate addresses with commas, spaces or new lines.
        </p>
        <PanelButton variant="primary" onClick={send} disabled={busy}>
          {busy ? 'Sending…' : 'Send invites'}
        </PanelButton>
      </div>

      {results && results.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line text-xs">
          {results.map((r) => (
            <li key={r.email} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="truncate text-fg">{r.email}</span>
              <span
                className={
                  r.invited ? 'text-mint-600 dark:text-mint-300' : 'text-subtle'
                }
              >
                {r.invited ? 'invited' : (r.reason ?? 'skipped')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
