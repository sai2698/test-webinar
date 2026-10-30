'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';

/**
 * Shared furniture for the parity panels.
 *
 * Every panel in this folder has the same three states — loading, failed,
 * loaded — and the same need to re-fetch after a mutation. Rather than repeat
 * that in eleven components, it lives here once.
 */

export function PanelSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-subtle">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function PanelNote({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  children: React.ReactNode;
}) {
  const tones = {
    info: 'border-line bg-panel-2 text-muted',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    error: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300',
    success: 'border-mint-500/30 bg-mint-500/10 text-mint-600 dark:text-mint-300',
  } as const;

  return (
    <p className={`rounded-xl border px-3 py-2 text-xs leading-relaxed ${tones[tone]}`}>
      {children}
    </p>
  );
}

export function PanelEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-subtle">{children}</p>;
}

export function PanelButton({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  type = 'button',
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const styles = {
    primary:
      'bg-brand-500 text-white hover:bg-brand-600 disabled:bg-brand-500/50',
    ghost:
      'border border-line text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-50',
    danger:
      'border border-red-500/30 text-red-600 hover:bg-red-500/10 dark:text-red-300 disabled:opacity-50',
  } as const;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition disabled:cursor-not-allowed ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function PanelInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  className = '',
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={`h-8 rounded-lg border border-line bg-panel px-2.5 text-xs text-fg outline-none transition placeholder:text-subtle focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20 ${className}`}
    />
  );
}

export function PanelToggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-panel-2/50 px-3 py-2.5 transition hover:bg-panel-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500"
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-fg">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-subtle">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * Fetch-on-mount with a manual refresh.
 *
 * `reload` is returned so a mutation can re-read the server's view rather than
 * patching local state — the server is the source of truth for derived fields
 * like counts and hints, and guessing them locally drifts.
 */
export function usePanelData<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await run();
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this panel');
    } finally {
      setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload, setData };
}

/** Turns an unknown thrown value into something worth showing a human. */
export function errorText(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Copies text to the clipboard, tolerating a browser that refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
