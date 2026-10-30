'use client';

import { useState } from 'react';
import { endpoints } from '@/lib/api';
import {
  PanelButton,
  PanelEmpty,
  PanelInput,
  PanelNote,
  PanelSection,
  PanelToggle,
  errorText,
  usePanelData,
} from './PanelKit';

interface FieldOption {
  id: string;
  label: string;
  value: string;
}

interface Field {
  id: string;
  label: string;
  type: string;
  isRequired: boolean;
  placeholder: string | null;
  order: number;
  options: FieldOption[];
}

/**
 * Field types the server accepts, grouped by whether they need options.
 *
 * The grouping is not cosmetic: a `select` with no options is rejected by the
 * API, so the editor has to know which types to show the option list for.
 */
const TYPES: { value: string; label: string; needsOptions: boolean }[] = [
  { value: 'text', label: 'Short text', needsOptions: false },
  { value: 'textarea', label: 'Long text', needsOptions: false },
  { value: 'email', label: 'Email', needsOptions: false },
  { value: 'phone', label: 'Phone', needsOptions: false },
  { value: 'number', label: 'Number', needsOptions: false },
  { value: 'date', label: 'Date', needsOptions: false },
  { value: 'time', label: 'Time', needsOptions: false },
  { value: 'select', label: 'Dropdown', needsOptions: true },
  { value: 'radio', label: 'Single choice', needsOptions: true },
  { value: 'multi-select', label: 'Multiple choice', needsOptions: true },
  { value: 'checkbox', label: 'Yes / no checkbox', needsOptions: false },
];

const NEEDS_OPTIONS = new Set(TYPES.filter((t) => t.needsOptions).map((t) => t.value));

export function CustomFieldsPanel({ webinarId }: { webinarId: string }) {
  const { data, loading, error, reload } = usePanelData(
    () => endpoints.customFields(webinarId) as Promise<{ fields: Field[] }>,
    [webinarId]
  );

  const [label, setLabel] = useState('');
  const [type, setType] = useState('text');
  const [isRequired, setIsRequired] = useState(false);
  const [placeholder, setPlaceholder] = useState('');
  const [optionText, setOptionText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fields = data?.fields ?? [];

  async function add() {
    if (!label.trim()) {
      setNotice('Give the field a label first.');
      return;
    }

    const options = optionText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ label: line }));

    if (NEEDS_OPTIONS.has(type) && options.length === 0) {
      setNotice('This field type needs at least one option.');
      return;
    }

    setBusy(true);
    try {
      await endpoints.createCustomField(webinarId, {
        label: label.trim(),
        type,
        isRequired,
        placeholder: placeholder.trim() || undefined,
        options: options.length > 0 ? options : undefined,
      });
      setLabel('');
      setPlaceholder('');
      setOptionText('');
      setIsRequired(false);
      setNotice(null);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not add the field'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await endpoints.deleteCustomField(id);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not remove the field'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRequired(field: Field) {
    setBusy(true);
    try {
      await endpoints.updateCustomField(field.id, { isRequired: !field.isRequired });
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not update the field'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelSection
      title="Registration form"
      description="Extra questions asked at sign-up. Answers appear as columns in the CSV export."
    >
      {error && <PanelNote tone="error">{error}</PanelNote>}
      {notice && <PanelNote tone="warn">{notice}</PanelNote>}

      {loading ? (
        <PanelEmpty>Loading fields…</PanelEmpty>
      ) : fields.length === 0 ? (
        <PanelEmpty>No custom fields yet — the form asks for name, email and phone only.</PanelEmpty>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {fields.map((field) => (
            <li key={field.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-fg">
                  {field.label}
                  {field.isRequired && <span className="ml-1 text-red-500">*</span>}
                </p>
                <p className="text-[11px] text-subtle">
                  {TYPES.find((t) => t.value === field.type)?.label ?? field.type}
                  {field.options.length > 0 && ` · ${field.options.length} options`}
                </p>
              </div>
              <PanelButton onClick={() => toggleRequired(field)} disabled={busy}>
                {field.isRequired ? 'Optional' : 'Required'}
              </PanelButton>
              <PanelButton variant="danger" onClick={() => remove(field.id)} disabled={busy}>
                Remove
              </PanelButton>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-3 rounded-xl border border-line bg-panel-2/40 p-3">
        <p className="text-xs font-semibold text-fg">Add a field</p>

        <div className="flex flex-wrap gap-2">
          <PanelInput
            value={label}
            onChange={setLabel}
            placeholder="Question label"
            className="min-w-[180px] flex-1"
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-8 rounded-lg border border-line bg-panel px-2 text-xs text-fg outline-none focus:border-brand-500/50"
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <PanelInput
            value={placeholder}
            onChange={setPlaceholder}
            placeholder="Placeholder (optional)"
            className="min-w-[160px] flex-1"
          />
        </div>

        {NEEDS_OPTIONS.has(type) && (
          <div>
            <textarea
              value={optionText}
              onChange={(e) => setOptionText(e.target.value)}
              rows={3}
              placeholder={'One option per line\n1-10\n11-50\n51+'}
              className="w-full rounded-lg border border-line bg-panel px-2.5 py-2 text-xs text-fg outline-none placeholder:text-subtle focus:border-brand-500/50"
            />
            <p className="mt-1 text-[11px] text-subtle">
              One option per line. A choice field with no options is rejected.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-[220px] flex-1">
            <PanelToggle
              checked={isRequired}
              onChange={setIsRequired}
              label="Required"
              hint="The visitor cannot submit the form without answering."
            />
          </div>
          <PanelButton variant="primary" onClick={add} disabled={busy}>
            {busy ? 'Saving…' : 'Add field'}
          </PanelButton>
        </div>
      </div>
    </PanelSection>
  );
}
