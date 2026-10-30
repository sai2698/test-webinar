'use client';

import { useCallback, useEffect, useState } from 'react';
import { endpoints, ApiError } from '@/lib/api';

interface AdminPayment {
  id: string;
  amountPaise: number;
  status: string;
  createdAt: string;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  user: { id: string; name: string; email: string };
  webinar: { id: string; title: string; slug: string } | null;
  kind: 'webinar' | 'course';
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_STYLES: Record<string, string> = {
  PAID: 'bg-mint-500/15 text-mint-500 dark:text-mint-400',
  CREATED: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  FAILED: 'bg-red-500/15 text-red-600 dark:text-red-400',
  REFUNDED: 'bg-panel-2 text-muted',
};

/**
 * Payments and refunds for one webinar.
 *
 * Refunds are irreversible, so the button asks for confirmation and shows the
 * exact amount. A partial refund is offered because the common real-world case
 * is a goodwill gesture, not a full reversal.
 */
export function PaymentsPanel({ webinarId }: { webinarId: string }) {
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await endpoints.payments(webinarId);
      setPayments(res.payments as AdminPayment[]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load payments');
    } finally {
      setLoading(false);
    }
  }, [webinarId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refund(payment: AdminPayment) {
    const label = `${rupees(payment.amountPaise)} to ${payment.user.name}`;
    if (!window.confirm(`Refund ${label}?\n\nThis cannot be undone.`)) return;

    setBusy(payment.id);
    setError(null);
    setNotice(null);
    try {
      const res = await endpoints.refundPayment(payment.id);
      setNotice(
        res.full
          ? `Refunded ${rupees(res.amountPaise)} — access revoked.`
          : `Partially refunded ${rupees(res.amountPaise)} — access kept.`
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Refund failed');
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center py-16">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-brand-500" />
      </div>
    );
  }

  const collected = payments
    .filter((p) => p.status === 'PAID')
    .reduce((sum, p) => sum + p.amountPaise, 0);
  const refunded = payments
    .filter((p) => p.status === 'REFUNDED')
    .reduce((sum, p) => sum + p.amountPaise, 0);

  return (
    <div>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {[
          ['Collected', rupees(collected)],
          ['Refunded', rupees(refunded)],
          ['Transactions', String(payments.length)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-panel-2 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-subtle">
              {label}
            </p>
            <p className="mt-1 text-lg font-semibold text-fg">{value}</p>
          </div>
        ))}
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-3 rounded-lg border border-mint-500/30 bg-mint-500/10 px-3 py-2 text-xs text-mint-500 dark:text-mint-300">
          {notice}
        </p>
      )}

      {payments.length === 0 ? (
        <p className="py-10 text-center text-sm text-subtle">No payments yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-subtle">
                <th className="pb-2 pr-4 font-medium">Buyer</th>
                <th className="pb-2 pr-4 font-medium">Amount</th>
                <th className="pb-2 pr-4 font-medium">Type</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 font-medium">Date</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-line/60 last:border-0">
                  <td className="py-2.5 pr-4">
                    <div className="text-fg">{p.user.name}</div>
                    <div className="text-xs text-subtle">{p.user.email}</div>
                  </td>
                  <td className="py-2.5 pr-4 tabular-nums text-fg">
                    {rupees(p.amountPaise)}
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-muted">
                    {p.kind === 'course' ? 'Course' : 'Webinar'}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                        STATUS_STYLES[p.status] ?? 'bg-panel-2 text-muted'
                      }`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-subtle">{formatDate(p.createdAt)}</td>
                  <td className="py-2.5 text-right">
                    {p.status === 'PAID' && (
                      <button
                        onClick={() => refund(p)}
                        disabled={busy === p.id}
                        className="btn-danger px-3 py-1.5 text-xs disabled:opacity-50"
                      >
                        {busy === p.id ? 'Refunding…' : 'Refund'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
