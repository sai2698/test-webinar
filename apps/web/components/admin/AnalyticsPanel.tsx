'use client';

import { useEffect, useState } from 'react';
import { endpoints, type AnalyticsConfigShape } from '@/lib/api';
import {
  PanelButton,
  PanelEmpty,
  PanelInput,
  PanelNote,
  PanelSection,
  errorText,
  usePanelData,
} from './PanelKit';

type AnalyticsConfig = AnalyticsConfigShape;

/**
 * Third-party analytics ids.
 *
 * Each id is validated against its real format before it is saved. A typo in a
 * measurement id fails silently in the browser — the tag loads, reports
 * nothing, and the host concludes the feature is broken.
 */
const FIELDS: {
  key: keyof AnalyticsConfig;
  label: string;
  placeholder: string;
  pattern: RegExp;
  hint: string;
}[] = [
  {
    key: 'ga4MeasurementId',
    label: 'Google Analytics 4',
    placeholder: 'G-XXXXXXXXXX',
    pattern: /^G-[A-Z0-9]{6,}$/i,
    hint: 'Starts with G-',
  },
  {
    key: 'metaPixelId',
    label: 'Meta Pixel',
    placeholder: '123456789012345',
    pattern: /^\d{10,20}$/,
    hint: 'Digits only',
  },
  {
    key: 'clarityProjectId',
    label: 'Microsoft Clarity',
    placeholder: 'abcdefghij',
    pattern: /^[a-z0-9]{6,}$/i,
    hint: 'Lowercase project id',
  },
  {
    key: 'gtmContainerId',
    label: 'Google Tag Manager',
    placeholder: 'GTM-XXXXXXX',
    pattern: /^GTM-[A-Z0-9]{4,}$/i,
    hint: 'Starts with GTM-',
  },
];

export function AnalyticsPanel({ webinarId }: { webinarId: string }) {
  const { data, loading, error, reload } = usePanelData(
    () => endpoints.analyticsConfig(webinarId),
    [webinarId]
  );

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data?.config) return;
    setDraft({
      ga4MeasurementId: data.config.ga4MeasurementId ?? '',
      metaPixelId: data.config.metaPixelId ?? '',
      clarityProjectId: data.config.clarityProjectId ?? '',
      gtmContainerId: data.config.gtmContainerId ?? '',
    });
  }, [data]);

  async function save() {
    for (const field of FIELDS) {
      const value = (draft[field.key] ?? '').trim();
      if (value && !field.pattern.test(value)) {
        setNotice(`${field.label}: expected the form ${field.placeholder}`);
        return;
      }
    }

    setBusy(true);
    try {
      await endpoints.setAnalyticsConfig(webinarId, {
        ga4MeasurementId: (draft.ga4MeasurementId ?? '').trim() || null,
        metaPixelId: (draft.metaPixelId ?? '').trim() || null,
        clarityProjectId: (draft.clarityProjectId ?? '').trim() || null,
        gtmContainerId: (draft.gtmContainerId ?? '').trim() || null,
      });
      setNotice('Saved.');
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not save the analytics settings'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelSection
      title="Analytics integrations"
      description="Load your own tracking tags on the registration and room pages."
      actions={
        <PanelButton variant="primary" onClick={save} disabled={busy || loading}>
          {busy ? 'Saving…' : 'Save'}
        </PanelButton>
      }
    >
      {error && <PanelNote tone="error">{error}</PanelNote>}
      {notice && <PanelNote tone="info">{notice}</PanelNote>}

      {loading ? (
        <PanelEmpty>Loading…</PanelEmpty>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <label key={field.key} className="block">
              <span className="mb-1 block text-[11px] font-medium text-muted">{field.label}</span>
              <PanelInput
                value={draft[field.key] ?? ''}
                onChange={(value) => setDraft((prev) => ({ ...prev, [field.key]: value }))}
                placeholder={field.placeholder}
                className="w-full"
              />
              <span className="mt-0.5 block text-[10px] text-subtle">{field.hint}</span>
            </label>
          ))}
        </div>
      )}

      <PanelNote>
        Leave a field empty to disable that integration. Ids are checked against their real format
        on save — a typo would otherwise load a tag that reports nothing.
      </PanelNote>
    </PanelSection>
  );
}
