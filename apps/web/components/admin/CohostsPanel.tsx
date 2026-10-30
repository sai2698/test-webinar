'use client';

import { useState } from 'react';
import { COHOST_PERMISSION_KEYS, DEFAULT_COHOST_PERMISSIONS } from '@webinar/shared';
import { endpoints } from '@/lib/api';
import {
  PanelButton,
  PanelEmpty,
  PanelInput,
  PanelNote,
  PanelSection,
  errorText,
  usePanelData,
} from './PanelKit';

interface Cohost {
  id: string;
  email: string;
  userId: string | null;
  name: string | null;
  source: string;
  permissions: Record<string, boolean>;
  inviteSentAt: string | null;
}

/** Human labels for the permission keys, in the order they are shown. */
const PERMISSION_LABELS: Record<string, string> = {
  chatModeration: 'Moderate chat',
  qna: 'Manage Q&A',
  polls: 'Run polls & quizzes',
  usersControl: 'Mute, remove & spotlight',
  waitingRoom: 'Admit from waiting room',
  startWebinar: 'Start the session',
  endWebinar: 'End the session',
  screenshare: 'Share screen',
  liveSettings: 'Change live settings',
  handraise: 'Manage raised hands',
};

export function CohostsPanel({ webinarId }: { webinarId: string }) {
  const { data, loading, error, reload } = usePanelData(
    () => endpoints.cohosts(webinarId) as Promise<{ cohosts: Cohost[]; maxCohosts: number }>,
    [webinarId]
  );

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const cohosts = data?.cohosts ?? [];
  const cap = data?.maxCohosts ?? 10;

  async function add() {
    if (!email.includes('@')) {
      setNotice('Enter a valid email address.');
      return;
    }
    setBusy('add');
    try {
      await endpoints.addCohost(webinarId, {
        email: email.trim().toLowerCase(),
        name: name.trim() || undefined,
      });
      setEmail('');
      setName('');
      setNotice(null);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not add that co-host'));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(cohost: Cohost, key: string) {
    setBusy(cohost.id);
    try {
      await endpoints.updateCohost(cohost.id, {
        permissions: { ...cohost.permissions, [key]: !cohost.permissions[key] },
      });
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not change that permission'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await endpoints.removeCohost(id);
      await reload();
    } catch (err) {
      setNotice(errorText(err, 'Could not remove that co-host'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <PanelSection
      title="Co-hosts"
      description={`Helpers who can run the room without owning it. Up to ${cap}.`}
    >
      {error && <PanelNote tone="error">{error}</PanelNote>}
      {notice && <PanelNote tone="warn">{notice}</PanelNote>}

      {loading ? (
        <PanelEmpty>Loading co-hosts…</PanelEmpty>
      ) : cohosts.length === 0 ? (
        <PanelEmpty>No co-hosts yet.</PanelEmpty>
      ) : (
        <ul className="space-y-2">
          {cohosts.map((cohost) => (
            <li key={cohost.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-fg">
                    {cohost.name ?? cohost.email}
                  </p>
                  <p className="truncate text-[11px] text-subtle">
                    {cohost.email}
                    {cohost.userId ? ' · has an account' : ' · not signed up yet'}
                  </p>
                </div>
                <PanelButton variant="danger" onClick={() => remove(cohost.id)} disabled={busy === cohost.id}>
                  Remove
                </PanelButton>
              </div>

              <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
                {COHOST_PERMISSION_KEYS.map((key) => {
                  const on = cohost.permissions[key] ?? DEFAULT_COHOST_PERMISSIONS[key];
                  return (
                    <button
                      key={key}
                      onClick={() => toggle(cohost, key)}
                      disabled={busy === cohost.id}
                      title={PERMISSION_LABELS[key] ?? key}
                      className={`rounded-lg border px-2 py-1.5 text-left text-[10px] font-medium leading-tight transition ${
                        on
                          ? 'border-brand-500/40 bg-brand-500/10 text-brand-600 dark:text-brand-300'
                          : 'border-line text-subtle hover:bg-panel-2'
                      }`}
                    >
                      {PERMISSION_LABELS[key] ?? key}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 rounded-xl border border-line bg-panel-2/40 p-3">
        <PanelInput
          value={email}
          onChange={setEmail}
          placeholder="co-host@example.com"
          className="min-w-[180px] flex-1"
        />
        <PanelInput
          value={name}
          onChange={setName}
          placeholder="Name (optional)"
          className="min-w-[140px] flex-1"
        />
        <PanelButton
          variant="primary"
          onClick={add}
          disabled={busy === 'add' || cohosts.length >= cap}
        >
          {busy === 'add' ? 'Adding…' : 'Add co-host'}
        </PanelButton>
      </div>

      <PanelNote>
        Starting and ending the session are off by default — those two actions change the room
        for everyone. Everything else is granted unless you switch it off.
      </PanelNote>
    </PanelSection>
  );
}
