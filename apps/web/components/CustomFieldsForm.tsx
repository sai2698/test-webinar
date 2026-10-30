'use client';

import { useEffect, useState } from 'react';
import type { CustomField } from '@webinar/shared';
import { endpoints } from '@/lib/api';

/**
 * Renders the host's custom registration questions.
 *
 * The field set is fetched rather than passed in, because the same component is
 * used on the public registration page and on the shared-link gate — two places
 * that have nothing in common except the slug.
 *
 * Answers are keyed by field id and handed back as a plain object, which is
 * exactly what `POST /register` expects under `customResponses`.
 */
export function CustomFieldsForm({
  slug,
  values,
  onChange,
  disabled,
}: {
  slug: string;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const [fields, setFields] = useState<CustomField[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;

    void endpoints
      .publicForm(slug)
      .then((res) => {
        if (cancelled) return;
        setFields(res.fields as CustomField[]);
      })
      // A form that fails to load must not block registration — the server
      // still validates whatever is submitted, and a required field left blank
      // is rejected there with a readable message.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!loaded || fields.length === 0) return null;

  function set(id: string, value: unknown) {
    onChange({ ...values, [id]: value });
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const value = values[field.id];
        const label = (
          <label className="label" htmlFor={`cf-${field.id}`}>
            {field.label}
            {field.isRequired && <span className="ml-0.5 text-red-400">*</span>}
          </label>
        );

        if (field.type === 'textarea') {
          return (
            <div key={field.id}>
              {label}
              <textarea
                id={`cf-${field.id}`}
                className="input min-h-[80px]"
                placeholder={field.placeholder ?? ''}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => set(field.id, e.target.value)}
                required={field.isRequired}
                disabled={disabled}
              />
            </div>
          );
        }

        if (field.type === 'select') {
          return (
            <div key={field.id}>
              {label}
              <select
                id={`cf-${field.id}`}
                className="input"
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => set(field.id, e.target.value)}
                required={field.isRequired}
                disabled={disabled}
              >
                <option value="">Choose…</option>
                {field.options.map((option) => (
                  <option key={option.id} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (field.type === 'radio') {
          return (
            <fieldset key={field.id}>
              <legend className="label">{field.label}</legend>
              <div className="space-y-1.5">
                {field.options.map((option) => (
                  <label
                    key={option.id}
                    className="flex cursor-pointer items-center gap-2 text-sm text-slate-300"
                  >
                    <input
                      type="radio"
                      name={`cf-${field.id}`}
                      value={option.value}
                      checked={value === option.value}
                      onChange={() => set(field.id, option.value)}
                      required={field.isRequired}
                      disabled={disabled}
                      className="accent-brand-500"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        }

        if (field.type === 'multi-select') {
          const chosen = Array.isArray(value) ? (value as string[]) : [];
          return (
            <fieldset key={field.id}>
              <legend className="label">
                {field.label}
                {field.isRequired && <span className="ml-0.5 text-red-400">*</span>}
              </legend>
              <div className="space-y-1.5">
                {field.options.map((option) => {
                  const on = chosen.includes(option.value);
                  return (
                    <label
                      key={option.id}
                      className="flex cursor-pointer items-center gap-2 text-sm text-slate-300"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          set(
                            field.id,
                            on
                              ? chosen.filter((v) => v !== option.value)
                              : [...chosen, option.value]
                          )
                        }
                        disabled={disabled}
                        className="accent-brand-500"
                      />
                      {option.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        }

        if (field.type === 'checkbox') {
          return (
            <label
              key={field.id}
              className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5"
            >
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => set(field.id, e.target.checked)}
                required={field.isRequired}
                disabled={disabled}
                className="mt-0.5 accent-brand-500"
              />
              <span className="text-xs leading-relaxed text-slate-300">
                {field.label}
                {field.isRequired && <span className="ml-0.5 text-red-400">*</span>}
              </span>
            </label>
          );
        }

        const inputType =
          field.type === 'email'
            ? 'email'
            : field.type === 'phone'
              ? 'tel'
              : field.type === 'number'
                ? 'number'
                : field.type === 'date'
                  ? 'date'
                  : field.type === 'time'
                    ? 'time'
                    : 'text';

        return (
          <div key={field.id}>
            {label}
            <input
              id={`cf-${field.id}`}
              type={inputType}
              className="input"
              placeholder={field.placeholder ?? ''}
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => set(field.id, e.target.value)}
              required={field.isRequired}
              disabled={disabled}
            />
          </div>
        );
      })}
    </div>
  );
}
