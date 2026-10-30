'use client';

import { useState } from 'react';
import { useRoomStore } from '@/store/roomStore';
import { endpoints } from '@/lib/api';
import { currentSocket } from '@/lib/socket';
import type { CtaFormField } from '@webinar/shared';

function formatPrice(paise: number, currency: string) {
  if (!paise) return 'Free';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

/**
 * The offer card.
 *
 * Two states, and the second only exists after a click:
 *
 *   collapsed — title, description, one button. This is what the room sees.
 *   expanded  — the host's pre-payment form, then the pay button.
 *
 * The expansion is deliberate. A form sitting open on the video from the moment
 * the offer is published competes with the presenter for attention and asks for
 * details from people who have not decided yet. Asking only after the click
 * means the form is answered by someone who already wants the thing.
 */
export function CtaOverlay() {
  const cta = useRoomStore((s) => s.activeCta);
  const role = useRoomStore((s) => s.role);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const isStaff = role === 'HOST' || role === 'ADMIN' || role === 'MODERATOR';

  // Staff publish offers from Host tools; the checkout card is for the people
  // who are meant to buy, not for the person selling. They see the click tally
  // in the Host panel instead.
  if (!cta || isStaff) return null;

  /** Tell the server someone opened the offer. Fire-and-forget by design. */
  function reportClick(responses?: Record<string, unknown>) {
    // The room's socket is already connected and authenticated — reusing it
    // avoids a second handshake just to report a click.
    currentSocket()?.emit('ctaClick', { ctaId: cta!.id, responses }, () => {});
  }

  /** The first click: count it, then either expand the form or go to checkout. */
  function onPrimary() {
    setError(null);
    reportClick();

    if (cta!.form && cta!.form.fields.length > 0) {
      setExpanded(true);
      return;
    }

    void enroll({});
  }

  /** Validate locally so the participant is not sent to a server round trip. */
  function validate(): boolean {
    const form = cta!.form;
    if (!form) return true;

    const errs: Record<string, string> = {};
    for (const field of form.fields) {
      const value = answers[field.id];
      const empty =
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim() === '') ||
        value === false;

      if (field.isRequired && empty) {
        errs[field.id] = 'This field is required';
        continue;
      }
      if (empty) continue;

      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
        errs[field.id] = 'Enter a valid email address';
      }
      if (field.type === 'phone' && !/^[+]?[\d\s()-]{6,20}$/.test(String(value))) {
        errs[field.id] = 'Enter a valid phone number';
      }
    }

    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function onSubmitForm() {
    if (!validate()) return;
    reportClick(answers);
    void enroll(answers);
  }

  async function enroll(responses: Record<string, unknown>) {
    if (!cta) return;
    setBusy(true);
    setError(null);
    try {
      if (cta.externalUrl) {
        window.open(cta.externalUrl, '_blank', 'noopener');
        setDone(true);
        return;
      }

      const order = await endpoints.createOrder({ ctaId: cta.id });

      if (order.mock) {
        await endpoints.verifyPayment({
          razorpayOrderId: order.orderId,
          razorpayPaymentId: `pay_mock_${Date.now()}`,
          razorpaySignature: `mock_${order.orderId}`,
        });
        setDone(true);
        return;
      }

      // Real Razorpay checkout
      await loadRazorpay();
      const RazorpayCtor = window.Razorpay;
      if (!RazorpayCtor) throw new Error('Razorpay checkout failed to load');

      const rzp = new RazorpayCtor({
        key: order.keyId!,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: 'NexaLive',
        description: cta.title,
        // Razorpay accepts arbitrary key/value pairs here and echoes them back
        // on the payment record — the cheapest place to keep the form answers
        // attached to the transaction itself.
        notes: Object.fromEntries(
          Object.entries(responses).map(([k, v]) => [k, String(v)])
        ),
        theme: { color: '#3d5cff' },
        handler: async (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          await endpoints.verifyPayment({
            razorpayOrderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature,
          });
          setDone(true);
        },
      });
      rzp.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout');
    } finally {
      setBusy(false);
    }
  }

  const form = cta.form;
  const showForm = Boolean(expanded && form && form.fields.length > 0 && !done);

  return (
    // Anchored to the stage, not the viewport. A `fixed` card centred on the
    // window ignores the 340px sidebar and lands half over it, and on a phone
    // it covers the control bar outright. Sitting inside the stage keeps the
    // offer over the video — where the presenter is talking about it — and
    // leaves the controls reachable.
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-3">
      <div className="pointer-events-auto mx-auto w-full max-w-[520px] animate-fade-up overflow-hidden rounded-2xl border border-accent-500/30 bg-gradient-to-br from-ink-850 to-ink-900 shadow-[0_20px_60px_-20px_rgba(255,159,28,0.4)]">
        <div className="h-1 w-full bg-gradient-to-r from-accent-400 via-accent-500 to-accent-600" />
        <div className="max-h-[70vh] overflow-y-auto p-5">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-500/20 text-accent-400">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.4 9.9l6-.9L12 3.5Z" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-bold text-white">{cta.title}</h3>
              {cta.description && (
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{cta.description}</p>
              )}
            </div>
            {showForm && (
              <button
                onClick={() => {
                  setExpanded(false);
                  setFieldErrors({});
                }}
                aria-label="Back to the offer"
                className="shrink-0 rounded-lg p-1 text-slate-500 hover:bg-white/10 hover:text-white"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

          {showForm && form ? (
            <div className="mt-4 space-y-3">
              {form.intro && (
                <p className="text-[11px] leading-relaxed text-slate-400">{form.intro}</p>
              )}

              {form.fields.map((field) => (
                <CtaFormInput
                  key={field.id}
                  field={field}
                  value={answers[field.id]}
                  error={fieldErrors[field.id]}
                  onChange={(v) => {
                    setAnswers((a) => ({ ...a, [field.id]: v }));
                    setFieldErrors((e) => {
                      if (!e[field.id]) return e;
                      const next = { ...e };
                      delete next[field.id];
                      return next;
                    });
                  }}
                />
              ))}

              <button onClick={onSubmitForm} disabled={busy} className="btn-accent w-full">
                {busy ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-950/30 border-t-ink-950" />
                ) : (
                  <>
                    {form.submitText}
                    {cta.priceInPaise > 0 && (
                      <span className="opacity-70">
                        {' '}
                        · {formatPrice(cta.priceInPaise, cta.currency)}
                      </span>
                    )}
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className="mt-4 flex items-center gap-2">
              {done ? (
                <div className="flex-1 rounded-xl bg-mint-500/15 px-4 py-2.5 text-center text-sm font-semibold text-mint-400">
                  ✓ You&apos;re enrolled!
                </div>
              ) : (
                <button onClick={onPrimary} disabled={busy} className="btn-accent flex-1">
                  {busy ? (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-950/30 border-t-ink-950" />
                  ) : (
                    <>
                      {cta.buttonText}
                      {cta.priceInPaise > 0 && (
                        <span className="opacity-70">
                          · {formatPrice(cta.priceInPaise, cta.currency)}
                        </span>
                      )}
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One field on the pre-payment form. */
function CtaFormInput({
  field,
  value,
  error,
  onChange,
}: {
  field: CtaFormField;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
}) {
  const id = `cta-field-${field.id}`;
  const base = 'input py-2 text-xs';

  return (
    <div>
      <label className="label text-[10px]" htmlFor={id}>
        {field.label}
        {field.isRequired && <span className="ml-0.5 text-red-400">*</span>}
      </label>

      {field.type === 'textarea' ? (
        <textarea
          id={id}
          className={base}
          rows={2}
          placeholder={field.placeholder ?? undefined}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === 'select' ? (
        <select
          id={id}
          className={base}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{field.placeholder ?? 'Select an option'}</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.type === 'checkbox' ? (
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            id={id}
            type="checkbox"
            className="h-4 w-4 rounded border-white/20 bg-white/5"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.placeholder ?? 'Yes'}
        </label>
      ) : (
        <input
          id={id}
          type={
            field.type === 'number'
              ? 'number'
              : field.type === 'email'
                ? 'email'
                : field.type === 'phone'
                  ? 'tel'
                  : 'text'
          }
          className={base}
          placeholder={field.placeholder ?? undefined}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
    </div>
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
