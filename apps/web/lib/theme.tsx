'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'nexa:theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Reads the persisted theme.
 *
 * Called from a lazy `useState` initialiser so the very first client render
 * already has the right value — that is what keeps the console from flashing
 * dark before switching to light. On the server there is no `window`, so the
 * dark default is returned and the mismatch is suppressed by the consumer.
 */
function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* localStorage can throw in private mode — fall through to the default */
  }
  return 'dark';
}

/**
 * Theme state for the console.
 *
 * The theme is deliberately *not* applied to `<html>`. The room, replay and
 * landing pages are dark-only by design, so the class is scoped to whatever
 * element the console renders — see `AdminShell`. That keeps a light console
 * from washing out a live webinar.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* persistence is best-effort */
    }
  }, []);

  const toggle = useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Keep the browser chrome (address bar on mobile) in step with the theme.
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f6f7fb' : '#05060a');
  }, [theme]);

  // Mirror the theme onto <html> so the pre-hydration bootstrap script in
  // `app/admin/layout.tsx` and the React state never disagree. The class is
  // stripped again on unmount, which is what keeps the dark-only marketing,
  // room and replay pages from inheriting a light console theme.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('theme-light', theme === 'light');
    root.classList.toggle('dark', theme === 'dark');
    return () => {
      root.classList.remove('theme-light', 'dark');
    };
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside a ThemeProvider');
  return ctx;
}

/** Class list that activates the light palette for a subtree. */
export function themeClass(theme: Theme): string {
  return theme === 'light' ? 'theme-light' : '';
}
