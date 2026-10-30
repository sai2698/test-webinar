'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Countdown } from '@/components/Countdown';
import { CustomFieldsForm } from '@/components/CustomFieldsForm';
import { Logo } from '@/components/Logo';
import { endpoints, ApiError, API_URL, type PublicWebinar } from '@/lib/api';
import { writeSession } from '@/lib/session';

function formatDate(iso: string, tz: string) {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz || 'Asia/Kolkata',
      timeZoneName: 'short',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function formatPrice(paise: number, currency: string) {
  if (!paise) return 'Free';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export default function WebinarLandingPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params?.slug ?? '';

  const [webinar, setWebinar] = useState<PublicWebinar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [passcode, setPasscode] = useState('');
  /**
   * Answers to the host's custom questions, keyed by field id. Held here rather
   * than inside the field component so the submit handler can post them with
   * the rest of the registration in one request.
   */
  const [customResponses, setCustomResponses] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    endpoints
      .publicWebinar(slug)
      .then((res) => setWebinar(res.webinar))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load webinar'))
      .finally(() => setLoading(false));
  }, [slug]);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      // A webinar with registration switched off only asks for a name — the
      // server mints a temporary guest identity instead of a real account.
      const res = webinar?.requireRegistration
        ? await endpoints.register(slug, {
            name: name.trim(),
            email: email.trim(),
            phone: phone.trim(),
            passcode: passcode.trim() || undefined,
            customResponses,
          })
        : await endpoints.guestJoin(slug, name.trim(), passcode.trim() || undefined);

      writeSession('participant', res.token, res.user);
      localStorage.setItem(`join:${slug}`, res.joinToken);

      // A webinar that requires approval parks the registration in PENDING. The
      // room page shows the waiting state; sending them there is correct, but
      // they must not be told they are in.
      if ('pendingApproval' in res && res.pendingApproval) {
        router.push(`/room/${slug}?pending=1`);
      } else if (res.requiresPayment) {
        router.push(`/w/${slug}/pay`);
      } else {
        router.push(`/room/${slug}`);
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/10 border-t-brand-400" />
          <p className="text-sm text-slate-500">Loading webinar…</p>
        </div>
      </main>
    );
  }

  if (error || !webinar) {
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="card max-w-md p-8 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-red-500/15 text-red-400">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 8v5m0 3.5v.5" strokeLinecap="round" />
              <circle cx="12" cy="12" r="9" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-white">Webinar unavailable</h1>
          <p className="mt-2 text-sm text-slate-400">{error ?? 'This webinar does not exist.'}</p>
          <Link href="/" className="btn-ghost mt-6">
            Back home
          </Link>
        </div>
      </main>
    );
  }

  const isLive = webinar.status === 'LIVE';
  const isEnded = webinar.status === 'ENDED';
  const startsInFuture = new Date(webinar.startsAt).getTime() > Date.now();

  return (
    <main className="relative min-h-screen">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] overflow-hidden">
        {webinar.bannerUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={webinar.bannerUrl}
            alt=""
            className="h-full w-full scale-105 object-cover opacity-25 blur-[2px]"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-ink-950/40 via-ink-950/80 to-ink-950" />
      </div>

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
        <Link href="/admin/login" className="btn-ghost text-xs">
          Host sign in
        </Link>
      </header>

      <div className="relative z-10 mx-auto grid max-w-6xl gap-10 px-6 pb-20 pt-6 lg:grid-cols-[1.35fr_1fr]">
        {/* ── left: details ─────────────────────────────── */}
        <div className="animate-fade-up">
          <div className="flex flex-wrap items-center gap-2">
            {isLive ? (
              <span className="chip border-red-500/30 bg-red-500/15 text-red-300">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-400" />
                </span>
                Live now
              </span>
            ) : isEnded ? (
              <span className="chip">Ended</span>
            ) : (
              <span className="chip border-brand-400/30 bg-brand-500/15 text-brand-200">
                Upcoming
              </span>
            )}
            <span className="chip">{webinar.durationMins} min</span>
            {webinar.requirePayment && (
              <span className="chip border-accent-500/30 bg-accent-500/15 text-accent-400">
                {formatPrice(webinar.priceInPaise, webinar.currency)}
              </span>
            )}
            {webinar.seatsLeft !== null && webinar.seatsLeft <= 50 && (
              <span className="chip border-accent-500/30 text-accent-400">
                {webinar.seatsLeft} seats left
              </span>
            )}
          </div>

          <h1 className="mt-5 text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl lg:text-[2.75rem]">
            {webinar.title}
          </h1>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-400">
            <span className="inline-flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-brand-300" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7.5V12l3 2" strokeLinecap="round" />
              </svg>
              {formatDate(webinar.startsAt, webinar.timezone)}
            </span>
            <span className="inline-flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-brand-300" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="12" cy="8.5" r="3.5" />
                <path d="M5 19.5c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" strokeLinecap="round" />
              </svg>
              Hosted by {webinar.hostName}
            </span>
          </div>

          {startsInFuture && !isEnded && (
            <div className="mt-8">
              <p className="label">Starts in</p>
              <Countdown target={webinar.startsAt} />
              <a
                href={`${API_URL}/api/webinars/${slug}/calendar.ics`}
                download
                className="mt-4 inline-flex items-center gap-2 text-xs font-medium text-slate-400 transition hover:text-brand-300"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M8 3v4M16 3v4M3 11h18" strokeLinecap="round" />
                </svg>
                Add to calendar
              </a>
            </div>
          )}

          {webinar.description && (
            <div className="mt-8">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
                About this session
              </h2>
              <p className="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-slate-300">
                {webinar.description}
              </p>
            </div>
          )}

          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              ['HD video', 'Up to 720p adaptive'],
              ['Live chat', 'Moderated in real time'],
              ['Quizzes', 'Timed with live results'],
            ].map(([title, sub]) => (
              <div key={title} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-sm font-semibold text-white">{title}</div>
                <div className="mt-0.5 text-xs text-slate-500">{sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── right: registration card ──────────────────── */}
        <div className="animate-fade-up animate-delay-200">
          <div className="card sticky top-6 overflow-hidden p-6">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-400/60 to-transparent" />

            <h2 className="text-lg font-semibold text-white">
              {isEnded ? 'This webinar has ended' : 'Reserve your seat'}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {webinar.requirePayment
                ? `Secure checkout · ${formatPrice(webinar.priceInPaise, webinar.currency)}`
                : 'Free to attend · instant access'}
            </p>

            {isEnded ? (
              <Link href="/" className="btn-ghost mt-6 w-full">
                Browse other webinars
              </Link>
            ) : (
              <form onSubmit={handleRegister} className="mt-6 space-y-4">
                <div>
                  <label className="label" htmlFor="name">
                    Full name
                  </label>
                  <input
                    id="name"
                    className="input"
                    placeholder="Ada Lovelace"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    minLength={2}
                  />
                </div>
                {webinar.requireRegistration && (
                  <>
                    <div>
                      <label className="label" htmlFor="email">
                        Email
                      </label>
                      <input
                        id="email"
                        type="email"
                        className="input"
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor="phone">
                        Mobile number
                      </label>
                      <input
                        id="phone"
                        type="tel"
                        className="input"
                        placeholder="+91 98765 43210"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        required
                        minLength={6}
                        maxLength={20}
                        pattern="[+]?[0-9\s\(\)\-]{6,20}"
                        title="Enter a valid mobile number"
                        autoComplete="tel"
                      />
                      <p className="mt-1.5 text-[11px] text-slate-500">
                        We use this only for reminders about this session.
                      </p>
                    </div>
                  </>
                )}

                {webinar.passcodeRequired && (
                  <div>
                    <label className="label" htmlFor="passcode">
                      Room passcode
                    </label>
                    <input
                      id="passcode"
                      className="input"
                      placeholder="Enter the passcode shared by the host"
                      value={passcode}
                      onChange={(e) => setPasscode(e.target.value)}
                      required
                      autoComplete="off"
                    />
                  </div>
                )}

                {webinar.requireRegistration && (
                  <CustomFieldsForm
                    slug={slug}
                    values={customResponses}
                    onChange={setCustomResponses}
                    disabled={submitting}
                  />
                )}

                {formError && (
                  <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {formError}
                  </div>
                )}

                <button type="submit" className="btn-primary w-full py-3" disabled={submitting}>
                  {submitting ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      Preparing…
                    </>
                  ) : webinar.requirePayment ? (
                    `Pay ${formatPrice(webinar.priceInPaise, webinar.currency)} & join`
                  ) : webinar.requireRegistration ? (
                    'Register & join'
                  ) : (
                    'Join now'
                  )}
                </button>

                <p className="text-center text-[11px] leading-relaxed text-slate-500">
                  {webinar.requireRegistration
                    ? 'By registering you agree to receive session reminders. No spam, ever.'
                    : 'No account needed — you will join as a guest.'}
                </p>
              </form>
            )}

            {isLive && (
              <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-center text-xs font-medium text-red-300">
                Session is live — you can join immediately after registering.
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
