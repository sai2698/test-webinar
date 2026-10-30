'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Logo } from '@/components/Logo';
import { endpoints, ApiError, type PublicWebinar } from '@/lib/api';

function formatPrice(paise: number, currency: string) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export default function PayPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params?.slug ?? '';

  const [webinar, setWebinar] = useState<PublicWebinar | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);

  useEffect(() => {
    endpoints
      .publicWebinar(slug)
      .then((res) => setWebinar(res.webinar))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load webinar'));
  }, [slug]);

  async function pay() {
    if (!webinar) return;
    setBusy(true);
    setError(null);
    try {
      const order = await endpoints.createOrder({ webinarId: webinar.id });

      if (order.mock) {
        await endpoints.verifyPayment({
          razorpayOrderId: order.orderId,
          razorpayPaymentId: `pay_mock_${Date.now()}`,
          razorpaySignature: `mock_${order.orderId}`,
        });
        setPaid(true);
        setTimeout(() => router.push(`/room/${slug}`), 1200);
        return;
      }

      await loadRazorpay();
      const RazorpayCtor = window.Razorpay;
      if (!RazorpayCtor) throw new Error('Razorpay checkout failed to load');

      const rzp = new RazorpayCtor({
        key: order.keyId!,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: 'NexaLive',
        description: webinar.title,
        theme: { color: '#3d5cff' },
        handler: async (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          try {
            await endpoints.verifyPayment({
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            });
            setPaid(true);
            setTimeout(() => router.push(`/room/${slug}`), 1200);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Verification failed');
          }
        },
        modal: {
          ondismiss: () => setBusy(false),
        },
      });
      rzp.open();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start checkout');
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-screen place-items-center px-6 py-12">
      <div className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-brand-600/20 blur-[130px]" />

      <div className="relative w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <div className="card overflow-hidden">
          <div className="h-1 w-full bg-gradient-to-r from-brand-400 via-brand-500 to-brand-700" />

          <div className="p-7">
            {paid ? (
              <div className="py-6 text-center">
                <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-mint-500/15 text-mint-400">
                  <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <path d="m5 13 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <h1 className="text-lg font-semibold text-white">Payment successful</h1>
                <p className="mt-1.5 text-sm text-slate-400">Taking you into the room…</p>
              </div>
            ) : (
              <>
                <h1 className="text-lg font-semibold text-white">Complete your registration</h1>
                <p className="mt-1 text-sm text-slate-400">
                  Secure checkout powered by Razorpay
                </p>

                {webinar && (
                  <div className="mt-6 space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-sm font-medium text-slate-200">{webinar.title}</span>
                    </div>
                    <div className="divider" />
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400">Amount</span>
                      <span className="font-semibold text-white">
                        {formatPrice(webinar.priceInPaise, webinar.currency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">Includes</span>
                      <span className="text-slate-400">Live access + recording</span>
                    </div>
                  </div>
                )}

                {error && (
                  <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {error}
                  </div>
                )}

                <button onClick={pay} disabled={busy || !webinar} className="btn-primary mt-6 w-full py-3">
                  {busy ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      Processing…
                    </>
                  ) : (
                    `Pay ${webinar ? formatPrice(webinar.priceInPaise, webinar.currency) : ''}`
                  )}
                </button>

                <Link href={`/w/${slug}`} className="btn-ghost mt-2 w-full">
                  Cancel
                </Link>

                <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
                  Payments are verified server-side with HMAC signatures. Your card details never
                  touch our servers.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function loadRazorpay(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Razorpay'));
    document.body.appendChild(script);
  });
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}
