'use client';

import { useEffect, useState } from 'react';
import { endpoints } from '@/lib/api';
import { writeSession } from '@/lib/session';
import { Logo } from '@/components/Logo';

interface JoinGateProps {
  slug: string;
  /** The join token from the shared link. */
  token: string;
  /** Called once the profile is attached and a JWT is in localStorage. */
  onReady: (jwt: string) => void;
}

/**
 * The name + mobile prompt shown when someone opens a shared join link.
 *
 * A link like `/room/:slug?token=...` is forwarded through WhatsApp and email,
 * so it routinely lands on a device that has never seen this site. The token
 * identifies the registration, but the person behind it may have no name or no
 * mobile on file — and a webinar without a reachable number is a lead you
 * cannot follow up. This gate collects both before the socket connects.
 */
export function JoinGate({ slug, token, onReady }: JoinGateProps) {
  const [checking, setChecking] = useState(true);
  const [needsProfile, setNeedsProfile] = useState(false);
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  /**
   * The host can put a room key on the webinar. A forwarded link then carries
   * the invite but not the key, so the gate has to ask for it — otherwise the
   * claim call fails with "This webinar requires a passcode" and the visitor
   * has no way to supply one.
   */
  const [passcodeRequired, setPasscodeRequired] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const info = await endpoints.joinInfo(slug, token);
        if (cancelled) return;

        setTitle(info.webinar?.title ?? '');
        setName(info.user?.name ?? '');
        setPhone(info.user?.phone ?? '');
        setPasscodeRequired(Boolean(info.passcodeRequired));

        // A passcode cannot be guessed on the visitor's behalf, so the gate is
        // shown even when the profile is already complete.
        if (info.needsProfile || info.passcodeRequired) {
          setNeedsProfile(true);
          setChecking(false);
          return;
        }

        // Profile is already complete — mint a JWT for this device and go.
        const res = await endpoints.claim(slug, {
          token,
          name: info.user.name,
          phone: info.user.phone ?? '',
        });
        if (cancelled) return;
        writeSession('participant', res.token, res.user);
        localStorage.setItem(`join:${slug}`, res.registration.joinToken);
        onReady(res.token);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'This join link is not valid');
        setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug, token, onReady]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await endpoints.claim(slug, {
        token,
        name: name.trim(),
        phone: phone.trim(),
        ...(passcodeRequired ? { passcode: passcode.trim() } : {}),
      });
      writeSession('participant', res.token, res.user);
      localStorage.setItem(`join:${slug}`, res.registration.joinToken);
      onReady(res.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join');
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <main className="grid min-h-screen place-items-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-2 border-white/10 border-t-brand-400" />
          <p className="text-sm text-slate-400">Checking your invite…</p>
        </div>
      </main>
    );
  }

  if (!needsProfile) {
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="card max-w-md p-8 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-red-500/15 text-red-400">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5m0 3.5v.5" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-white">Could not join</h1>
          <p className="mt-2 text-sm text-slate-400">{error ?? 'This join link is not valid.'}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center px-6 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo href="/" />
        </div>

        <div className="card p-7">
          <h1 className="text-xl font-semibold text-white">You&apos;re invited</h1>
          <p className="mt-1.5 text-sm text-slate-400">
            {title ? (
              <>
                Confirm your details to join <span className="text-slate-200">{title}</span>.
              </>
            ) : (
              'Confirm your details to join the webinar.'
            )}
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="gate-name" className="label">
                Full name
              </label>
              <input
                id="gate-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                required
                minLength={2}
                maxLength={80}
                autoComplete="name"
              />
            </div>

            <div>
              <label htmlFor="gate-phone" className="label">
                Mobile number
              </label>
              <input
                id="gate-phone"
                className="input"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 98765 43210"
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

            {passcodeRequired && (
              <div>
                <label htmlFor="gate-passcode" className="label">
                  Passcode
                </label>
                <input
                  id="gate-passcode"
                  className="input"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="Room passcode"
                  required
                  maxLength={64}
                  autoComplete="off"
                  autoFocus
                />
                <p className="mt-1.5 text-[11px] text-slate-500">
                  This session is protected. Ask the host for the passcode.
                </p>
              </div>
            )}

            {error && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting} className="btn-primary w-full">
              {submitting ? 'Joining…' : 'Join webinar'}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
