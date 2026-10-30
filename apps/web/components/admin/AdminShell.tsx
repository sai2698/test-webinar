'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { ThemeProvider, useTheme } from '@/lib/theme';
import {
  IconClose,
  IconLogout,
  IconMenu,
  IconMoon,
  IconSun,
} from '@/components/admin/icons';

export interface NavItem {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Small count pill rendered on the right of the nav row. */
  badge?: string | number;
}

interface AdminShellProps {
  nav: NavItem[];
  active: string;
  onNavigate: (key: string) => void;
  title: string;
  subtitle?: string;
  /** Right-hand side of the top bar — page-level actions. */
  actions?: React.ReactNode;
  user?: { name: string; role: string } | null;
  onSignOut: () => void;
  children: React.ReactNode;
}

/**
 * Console chrome: fixed left sidebar, sticky top bar, scrolling content.
 *
 * The theme class lives here rather than on `<html>` on purpose. The room,
 * replay and landing pages are dark-only, so scoping the light palette to this
 * subtree means a light console can never wash out a live webinar.
 */
export function AdminShell(props: AdminShellProps) {
  return (
    <ThemeProvider>
      <ShellBody {...props} />
    </ThemeProvider>
  );
}

function ShellBody({
  nav,
  active,
  onNavigate,
  title,
  subtitle,
  actions,
  user,
  onSignOut,
  children,
}: AdminShellProps) {
  const { theme, toggle } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the mobile drawer whenever the route changes underneath it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [active]);

  // Escape closes the drawer, matching every other overlay in the app.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const initials = (user?.name ?? 'A')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div
      className={`${theme === 'light' ? 'theme-light' : 'dark'} min-h-screen bg-surface text-fg`}
    >
      <div className="flex min-h-screen">
        {/* ── sidebar ─────────────────────────────────────────── */}
        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-[264px] flex-col border-r border-line bg-panel transition-transform duration-300 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
            drawerOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full'
          }`}
        >
          <div className="flex h-16 shrink-0 items-center justify-between px-5">
            <Logo href="/admin" />
            <button
              onClick={() => setDrawerOpen(false)}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-panel-2 hover:text-fg lg:hidden"
              aria-label="Close navigation"
            >
              <IconClose className="h-4 w-4" />
            </button>
          </div>

          <div className="px-5 pb-3">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-mint-500" />
              Console
            </span>
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
            {nav.map((item) => {
              const Icon = item.icon;
              const isActive = item.key === active;
              return (
                <button
                  key={item.key}
                  onClick={() => onNavigate(item.key)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                    isActive
                      ? 'bg-brand-500/12 text-brand-500 ring-1 ring-inset ring-brand-500/25 dark:text-brand-300'
                      : 'text-muted hover:bg-panel-2 hover:text-fg'
                  }`}
                >
                  <Icon
                    className={`h-[18px] w-[18px] shrink-0 transition ${
                      isActive ? 'text-brand-500 dark:text-brand-300' : 'text-subtle group-hover:text-fg'
                    }`}
                  />
                  <span className="flex-1 truncate text-left">{item.label}</span>
                  {item.badge !== undefined && item.badge !== 0 && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                        isActive
                          ? 'bg-brand-500 text-white'
                          : 'bg-panel-2 text-muted group-hover:bg-line'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="shrink-0 border-t border-line p-3">
            <div className="mb-2 flex items-center gap-3 rounded-xl px-2 py-2">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-700 text-xs font-bold text-white">
                {initials || 'A'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-fg">{user?.name ?? 'Admin'}</p>
                <p className="truncate text-[11px] uppercase tracking-wider text-subtle">
                  {user?.role ?? 'ADMIN'}
                </p>
              </div>
            </div>
            <button
              onClick={onSignOut}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-muted transition hover:bg-red-500/10 hover:text-red-500"
            >
              <IconLogout className="h-[18px] w-[18px]" />
              Sign out
            </button>
          </div>
        </aside>

        {/* Backdrop for the mobile drawer */}
        {drawerOpen && (
          <div
            onClick={() => setDrawerOpen(false)}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
            aria-hidden="true"
          />
        )}

        {/* ── main column ─────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b border-line bg-panel/85 backdrop-blur-xl">
            <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
              <button
                onClick={() => setDrawerOpen(true)}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line text-muted transition hover:bg-panel-2 hover:text-fg lg:hidden"
                aria-label="Open navigation"
              >
                <IconMenu className="h-4 w-4" />
              </button>

              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[15px] font-semibold tracking-tight text-fg">
                  {title}
                </h1>
                {subtitle && (
                  <p className="truncate text-xs text-subtle">{subtitle}</p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {actions}
                <button
                  onClick={toggle}
                  className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted transition hover:bg-panel-2 hover:text-fg"
                  aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
                  title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
                >
                  {theme === 'light' ? (
                    <IconMoon className="h-4 w-4" />
                  ) : (
                    <IconSun className="h-4 w-4" />
                  )}
                </button>
                <Link
                  href="/"
                  className="hidden h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-medium text-muted transition hover:bg-panel-2 hover:text-fg sm:inline-flex"
                >
                  Site
                </Link>
              </div>
            </div>
          </header>

          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
