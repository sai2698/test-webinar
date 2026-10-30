'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Logo } from '@/components/Logo';
import { ThemeProvider, useTheme } from '@/lib/theme';
import { IconMoon, IconSun } from '@/components/admin/icons';
import { endpoints, ApiError } from '@/lib/api';
import { getToken, writeSession } from '@/lib/session';

export default function AdminLoginPage() {
  return (
    <ThemeProvider>
      <LoginBody />
    </ThemeProvider>
  );
}

function LoginBody() {
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const [email, setEmail] = useState('admin@webinar.local');
  const [password, setPassword] = useState('Admin@12345');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether this page should be showing at all.
   *
   * `null` means "not decided yet". The check has to run in an effect because
   * `localStorage` does not exist during the server render, and rendering the
   * form first would flash a sign-in screen at someone who is already signed
   * in — which is exactly the complaint this fixes: clicking "Site" from the
   * console landed on a login page that asked for credentials the browser
   * already had.
   */
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    // `getToken` reports an expired JWT as no session, so a stale token still
    // shows the form rather than bouncing to a console that cannot load.
    const token = getToken('admin');
    if (token) {
      setSignedIn(true);
      router.replace('/admin');
      return;
    }
    setSignedIn(false);
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await endpoints.login(email.trim(), password);
      // The console keeps its own session keys, so signing in here can never
      // evict — or be evicted by — an attendee session in the same browser.
      writeSession('admin', res.token, res.user);
      router.push('/admin');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Nothing is rendered until the session check resolves.
   *
   * A blank frame is the honest thing to show for the one tick it takes: the
   * alternative is a form that appears and is then yanked away, which reads as
   * a glitch rather than a redirect.
   */
  if (signedIn !== false) {
    return (
      <main
        className={`${theme === 'light' ? 'theme-light' : 'dark'} grid min-h-screen place-items-center bg-surface text-fg`}
      >
        <div className="flex items-center gap-3 text-sm text-muted">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-brand-500" />
          {signedIn ? 'Taking you to the console…' : 'Checking your session…'}
        </div>
      </main>
    );
  }

  return (
    <main
      className={`${theme === 'light' ? 'theme-light' : 'dark'} relative grid min-h-screen place-items-center bg-surface px-6 text-fg`}
    >
      <div className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-brand-600/15 blur-[130px]" />

      <button
        onClick={toggle}
        className="absolute right-5 top-5 grid h-9 w-9 place-items-center rounded-lg border border-line text-muted transition hover:bg-panel-2 hover:text-fg"
        aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
      >
        {theme === 'light' ? <IconMoon className="h-4 w-4" /> : <IconSun className="h-4 w-4" />}
      </button>

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
          <div className="h-1 w-full bg-gradient-to-r from-brand-400 via-brand-500 to-brand-700" />
          <form onSubmit={submit} className="p-7">
            <h1 className="text-lg font-semibold text-fg">Host sign in</h1>
            <p className="mt-1 text-sm text-muted">Access the webinar console</p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="label" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            </div>

            {error && (
              <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
                {error}
              </div>
            )}

            <button type="submit" className="btn-primary mt-6 w-full py-3" disabled={busy}>
              {busy ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                'Sign in'
              )}
            </button>

            <p className="mt-4 rounded-lg bg-panel-2 px-3 py-2 text-center text-[11px] text-subtle">
              Demo credentials are pre-filled
            </p>

            <Link href="/" className="btn-ghost mt-2 w-full">
              Back to site
            </Link>
          </form>
        </div>
      </div>
    </main>
  );
}
