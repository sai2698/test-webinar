'use client';

import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '@/lib/api';

/** One person who opened an offer, as the follow-up list sees them. */
interface FollowUpPerson {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  clickedAt: string;
  formFilled: boolean;
  answeredCount: number;
  responses: Record<string, unknown>;
  paymentStatus: string | null;
  paidAt: string | null;
  amountPaise: number | null;
  purchasedAt: string | null;
  attended: boolean;
  registeredAt: string | null;
}

interface FollowUpData {
  offer: {
    id: string;
    title: string;
    priceInPaise: number;
    currency: string;
    formEnabled: boolean;
  };
  fields: { id: string; label: string; type: string }[];
  people: FollowUpPerson[];
  summary: { clicked: number; formFilled: number; paid: number; pending: number };
}

type Filter = 'all' | 'paid' | 'pending' | 'form';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Everyone' },
  { key: 'paid', label: 'Paid' },
  { key: 'pending', label: 'Not paid' },
  { key: 'form', label: 'Form filled' },
];

function money(paise: number, currency: string): string {
  if (!paise) return 'Free';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

/** "3m ago" — a follow-up list is read in terms of recency, not timestamps. */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The follow-up list for one offer.
 *
 * Replaces the bare click count: a number tells the host the offer is landing,
 * but a co-host chasing the sale needs names, contact details, what the person
 * answered, and whether they actually paid. Every row is a person to call.
 */
export function CtaFollowUp({
  ctaId,
  onClose,
}: {
  ctaId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<FollowUpData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await endpoints.ctaFollowUp(ctaId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the list');
    } finally {
      setLoading(false);
    }
  }, [ctaId]);

  useEffect(() => {
    void load();
  }, [load]);

  const people = data?.people ?? [];
  const visible = people.filter((p) => {
    if (filter === 'paid') return p.paymentStatus === 'PAID';
    if (filter === 'pending') return p.paymentStatus !== 'PAID' && p.paymentStatus !== 'REFUNDED';
    if (filter === 'form') return p.formFilled;
    return true;
  });

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-white">
            {data?.offer.title ?? 'Offer'}
          </p>
          <p className="mt-0.5 text-[10px] text-slate-500">
            {data
              ? `${data.summary.clicked} opened · ${data.summary.formFilled} filled the form · ${data.summary.paid} paid`
              : 'Loading…'}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button onClick={() => void load()} className="btn-ghost px-2 py-1 text-[10px]">
            Refresh
          </button>
          <button onClick={onClose} className="btn-ghost px-2 py-1 text-[10px]">
            Back
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const count =
            f.key === 'all'
              ? people.length
              : f.key === 'paid'
                ? people.filter((p) => p.paymentStatus === 'PAID').length
                : f.key === 'pending'
                  ? people.filter(
                      (p) => p.paymentStatus !== 'PAID' && p.paymentStatus !== 'REFUNDED'
                    ).length
                  : people.filter((p) => p.formFilled).length;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-2.5 py-1 text-[10px] transition ${
                filter === f.key
                  ? 'bg-brand-500/20 text-brand-200 ring-1 ring-brand-400/40'
                  : 'bg-white/5 text-slate-400 hover:bg-white/10'
              }`}
            >
              {f.label} <span className="tabular-nums opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {loading && <p className="py-6 text-center text-[11px] text-slate-500">Loading…</p>}

      {!loading && visible.length === 0 && (
        <p className="py-6 text-center text-[11px] text-slate-500">
          {people.length === 0
            ? 'Nobody has opened this offer yet.'
            : 'Nobody matches this filter.'}
        </p>
      )}

      <div className="space-y-2">
        {visible.map((p) => {
          const open = expanded === p.userId;
          const paid = p.paymentStatus === 'PAID';
          return (
            <div
              key={p.userId}
              className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5"
            >
              <button
                onClick={() => setExpanded(open ? null : p.userId)}
                className="flex w-full items-start justify-between gap-2 text-left"
              >
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-medium text-slate-200">{p.name}</p>
                  <p className="truncate text-[10px] text-slate-500">{p.email}</p>
                  {p.phone && (
                    <p className="truncate text-[10px] text-slate-500">{p.phone}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${
                      paid
                        ? 'bg-mint-500/15 text-mint-400'
                        : p.paymentStatus === 'REFUNDED'
                          ? 'bg-slate-500/15 text-slate-400'
                          : 'bg-accent-500/15 text-accent-400'
                    }`}
                  >
                    {paid ? 'PAID' : p.paymentStatus === 'REFUNDED' ? 'REFUNDED' : 'NOT PAID'}
                  </span>
                  <span className="text-[9px] text-slate-500">{ago(p.clickedAt)}</span>
                </div>
              </button>

              <div className="mt-1.5 flex flex-wrap gap-1">
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] ${
                    p.formFilled
                      ? 'bg-brand-500/15 text-brand-200'
                      : 'bg-white/5 text-slate-500'
                  }`}
                >
                  {p.formFilled ? `Form filled · ${p.answeredCount}` : 'Form not filled'}
                </span>
                {p.attended && (
                  <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-400">
                    Attended
                  </span>
                )}
                {paid && p.amountPaise !== null && (
                  <span className="rounded bg-mint-500/10 px-1.5 py-0.5 text-[9px] text-mint-400">
                    {money(p.amountPaise, data?.offer.currency ?? 'INR')}
                  </span>
                )}
              </div>

              {open && (
                <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2">
                  {(data?.fields ?? []).length === 0 && (
                    <p className="text-[10px] text-slate-500">
                      This offer has no form, so there are no answers to show.
                    </p>
                  )}
                  {(data?.fields ?? []).map((f) => {
                    const raw = p.responses[f.id];
                    const value =
                      raw === undefined || raw === null || raw === ''
                        ? '—'
                        : typeof raw === 'boolean'
                          ? raw
                            ? 'Yes'
                            : 'No'
                          : String(raw);
                    return (
                      <div key={f.id} className="flex justify-between gap-3 text-[10px]">
                        <span className="shrink-0 text-slate-500">{f.label}</span>
                        <span className="min-w-0 break-words text-right text-slate-300">
                          {value}
                        </span>
                      </div>
                    );
                  })}
                  <div className="flex justify-between gap-3 text-[10px]">
                    <span className="text-slate-500">Opened</span>
                    <span className="text-slate-300">
                      {new Date(p.clickedAt).toLocaleString('en-IN')}
                    </span>
                  </div>
                  {p.paidAt && (
                    <div className="flex justify-between gap-3 text-[10px]">
                      <span className="text-slate-500">Paid</span>
                      <span className="text-slate-300">
                        {new Date(p.paidAt).toLocaleString('en-IN')}
                      </span>
                    </div>
                  )}
                  <div className="flex gap-1.5 pt-1">
                    <a
                      href={`mailto:${p.email}?subject=${encodeURIComponent(
                        `About ${data?.offer.title ?? 'the offer'}`
                      )}`}
                      className="btn-ghost px-2 py-1 text-[10px]"
                    >
                      Email
                    </a>
                    {p.phone && (
                      <a
                        href={`tel:${p.phone.replace(/\s/g, '')}`}
                        className="btn-ghost px-2 py-1 text-[10px]"
                      >
                        Call
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
