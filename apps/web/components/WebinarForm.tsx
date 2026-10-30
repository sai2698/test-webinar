'use client';

import { useEffect, useState } from 'react';

export interface WebinarFormValues {
  title: string;
  description: string;
  bannerUrl: string;
  startsAt: string;
  durationMins: number;
  timezone: string;
  allowMic: boolean;
  allowVideo: boolean;
  requireRegistration: boolean;
  requirePayment: boolean;
  priceInPaise: number;
  chatEnabled: boolean;
  handRaiseEnabled: boolean;
  maxParticipants: number;
  /** Empty string means "no passcode". */
  passcode: string;
  inviteOnly: boolean;
  requireSignIn: boolean;
  /** Park every new registration in PENDING until a host approves it. */
  requireApproval: boolean;
  /** Give participants a People tab. Staff always see it. */
  showPeopleTab: boolean;
  /** Give participants a Q&A tab. Staff always see it. */
  showQaTab: boolean;
  /** Give participants a Polls tab. Staff always see it. */
  showPollsTab: boolean;
  /**
   * Let the audience see and hear each other.
   *
   * Off by default: a webinar is a broadcast, and an attendee joining a
   * product demo does not expect their camera in every other attendee's grid.
   * Staff are mutually visible either way.
   */
  showParticipantsToEachOther: boolean;
  /** Stamp each viewer's own name over the stage to trace leaked recordings. */
  watermarkEnabled: boolean;
  /** Show the live headcount to the audience, not just to staff. */
  showLiveUsersCount: boolean;
  /** Let a co-host start the session when the host has not arrived. */
  cohostStartWithoutHost: boolean;
}

export const emptyWebinar: WebinarFormValues = {
  title: '',
  description: '',
  bannerUrl: '',
  startsAt: '',
  durationMins: 60,
  timezone: 'Asia/Kolkata',
  allowMic: false,
  allowVideo: false,
  requireRegistration: true,
  requirePayment: false,
  priceInPaise: 0,
  chatEnabled: true,
  handRaiseEnabled: true,
  maxParticipants: 500,
  passcode: '',
  inviteOnly: false,
  requireSignIn: false,
  requireApproval: false,
  showPeopleTab: false,
  showQaTab: false,
  showPollsTab: false,
  showParticipantsToEachOther: false,
  watermarkEnabled: false,
  showLiveUsersCount: false,
  cohostStartWithoutHost: false,
};

function toLocalInput(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export function fromWebinar(w: {
  title: string;
  description?: string | null;
  bannerUrl?: string | null;
  startsAt: string;
  durationMins: number;
  timezone: string;
  settings?: Record<string, unknown> | null;
  priceInPaise?: number;
  maxParticipants?: number;
}): WebinarFormValues {
  const s = (w.settings ?? {}) as Record<string, unknown>;
  return {
    title: w.title,
    description: w.description ?? '',
    bannerUrl: w.bannerUrl ?? '',
    startsAt: toLocalInput(w.startsAt),
    durationMins: w.durationMins,
    timezone: w.timezone,
    allowMic: Boolean(s.allowMic),
    allowVideo: Boolean(s.allowVideo),
    requireRegistration: s.requireRegistration !== false,
    requirePayment: Boolean(s.requirePayment),
    priceInPaise: w.priceInPaise ?? 0,
    chatEnabled: s.chatEnabled !== false,
    handRaiseEnabled: s.handRaiseEnabled !== false,
    maxParticipants: w.maxParticipants ?? 500,
    // The server never sends the passcode back, only whether one is set.
    passcode: '',
    inviteOnly: Boolean(s.inviteOnly),
    requireSignIn: Boolean(s.requireSignIn),
    requireApproval: Boolean(s.requireApproval),
    showPeopleTab: Boolean(s.showPeopleTab),
    showQaTab: Boolean(s.showQaTab),
    showPollsTab: Boolean(s.showPollsTab),
    showParticipantsToEachOther: Boolean(s.showParticipantsToEachOther),
    watermarkEnabled: Boolean(s.watermarkEnabled),
    showLiveUsersCount: Boolean(s.showLiveUsersCount),
    cohostStartWithoutHost: Boolean(s.cohostStartWithoutHost),
  };
}

interface Props {
  initial?: WebinarFormValues;
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (values: WebinarFormValues) => void;
  onCancel?: () => void;
}

export function WebinarForm({
  initial = emptyWebinar,
  submitLabel = 'Save webinar',
  busy,
  error,
  onSubmit,
  onCancel,
}: Props) {
  const [v, setV] = useState<WebinarFormValues>(initial);

  useEffect(() => {
    setV(initial);
  }, [initial]);

  function set<K extends keyof WebinarFormValues>(key: K, value: WebinarFormValues[K]) {
    setV((prev) => ({ ...prev, [key]: value }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(v);
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <label className="label" htmlFor="title">
          Title
        </label>
        <input
          id="title"
          className="input"
          value={v.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="Live product teardown"
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="description">
          Description
        </label>
        <textarea
          id="description"
          className="input min-h-[96px] resize-y"
          value={v.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="What will viewers learn?"
        />
      </div>

      <div>
        <label className="label" htmlFor="bannerUrl">
          Banner image URL
        </label>
        <input
          id="bannerUrl"
          className="input"
          value={v.bannerUrl}
          onChange={(e) => set('bannerUrl', e.target.value)}
          placeholder="https://images.unsplash.com/..."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="startsAt">
            Starts at
          </label>
          <input
            id="startsAt"
            type="datetime-local"
            className="input"
            value={v.startsAt}
            onChange={(e) => set('startsAt', e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="durationMins">
            Duration (minutes)
          </label>
          <input
            id="durationMins"
            type="number"
            min={5}
            className="input"
            value={v.durationMins}
            onChange={(e) => set('durationMins', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="timezone">
            Timezone
          </label>
          <input
            id="timezone"
            className="input"
            value={v.timezone}
            onChange={(e) => set('timezone', e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="maxParticipants">
            Max participants
          </label>
          <input
            id="maxParticipants"
            type="number"
            min={1}
            className="input"
            value={v.maxParticipants}
            onChange={(e) => set('maxParticipants', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel-2 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
          Access & media
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            label="Allow audience mic"
            hint="Approved speakers can unmute"
            checked={v.allowMic}
            onChange={(x) => set('allowMic', x)}
          />
          <Toggle
            label="Allow audience camera"
            hint="Approved speakers can share video"
            checked={v.allowVideo}
            onChange={(x) => set('allowVideo', x)}
          />
          <Toggle
            label="Require registration"
            hint="Collect name and email"
            checked={v.requireRegistration}
            onChange={(x) => set('requireRegistration', x)}
          />
          <Toggle
            label="Require payment"
            hint="Paid webinar via Razorpay"
            checked={v.requirePayment}
            onChange={(x) => set('requirePayment', x)}
          />
          <Toggle
            label="Chat enabled"
            hint="Live audience chat"
            checked={v.chatEnabled}
            onChange={(x) => set('chatEnabled', x)}
          />
          <Toggle
            label="Hand raise enabled"
            hint="Audience can request to speak"
            checked={v.handRaiseEnabled}
            onChange={(x) => set('handRaiseEnabled', x)}
          />
        </div>

        {v.requirePayment && (
          <div className="mt-4">
            <label className="label" htmlFor="price">
              Price (₹)
            </label>
            <input
              id="price"
              type="number"
              min={0}
              className="input"
              value={v.priceInPaise / 100}
              onChange={(e) => set('priceInPaise', Math.round(Number(e.target.value) * 100))}
            />
          </div>
        )}
      </div>

      <div className="rounded-xl border border-line bg-panel-2 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
          Security
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            label="Invite only"
            hint="Only registered attendees may enter"
            checked={v.inviteOnly}
            onChange={(x) => set('inviteOnly', x)}
          />
          <Toggle
            label="Require sign-in"
            hint="No guest entry — an account is required"
            checked={v.requireSignIn}
            onChange={(x) => set('requireSignIn', x)}
          />
        </div>

        <div className="mt-4">
          <label className="label" htmlFor="passcode">
            Room passcode
          </label>
          <input
            id="passcode"
            className="input"
            autoComplete="off"
            placeholder={initial.passcode ? 'Leave blank to keep the current passcode' : 'Optional'}
            value={v.passcode}
            onChange={(e) => set('passcode', e.target.value)}
          />
          <p className="mt-1 text-[11px] text-muted">
            Attendees must type this before they can enter. Leave blank for an open room.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel-2 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
          Participant tabs
        </p>
        <p className="mb-3 text-[11px] text-muted">
          Which sidebar tabs your audience sees. Staff always see all of them, and a
          launched poll or quiz still reaches everyone as a pop-up.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Toggle
            label="People"
            hint="The attendee roster"
            checked={v.showPeopleTab}
            onChange={(x) => set('showPeopleTab', x)}
          />
          <Toggle
            label="Q&amp;A"
            hint="Ask and upvote questions"
            checked={v.showQaTab}
            onChange={(x) => set('showQaTab', x)}
          />
          <Toggle
            label="Polls"
            hint="The list of polls so far"
            checked={v.showPollsTab}
            onChange={(x) => set('showPollsTab', x)}
          />
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel-2 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
          Audience video
        </p>
        <p className="mb-3 text-[11px] text-muted">
          By default the audience only ever sees and hears you and your moderators —
          a webinar is a broadcast, not a meeting. Turn this on to let attendees see
          and hear each other as well.
        </p>
        <Toggle
          label="Participants see each other"
          hint="Off shows only hosts and moderators to the audience"
          checked={v.showParticipantsToEachOther}
          onChange={(x) => set('showParticipantsToEachOther', x)}
        />
      </div>

      <div className="rounded-xl border border-line bg-panel-2 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
          Audience &amp; protection
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            label="Approve registrations"
            hint="New sign-ups wait for a host before they can join"
            checked={v.requireApproval}
            onChange={(x) => set('requireApproval', x)}
          />
          <Toggle
            label="Watermark the stage"
            hint="Overlays each viewer's own name to trace leaked recordings"
            checked={v.watermarkEnabled}
            onChange={(x) => set('watermarkEnabled', x)}
          />
          <Toggle
            label="Show live headcount"
            hint="Off hides the viewer count from the audience; staff still see it"
            checked={v.showLiveUsersCount}
            onChange={(x) => set('showLiveUsersCount', x)}
          />
          <Toggle
            label="Co-hosts may start"
            hint="A co-host can open the session before the host arrives"
            checked={v.cohostStartWithoutHost}
            onChange={(x) => set('cohostStartWithoutHost', x)}
          />
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button type="submit" className="btn-primary flex-1 py-3" disabled={busy}>
          {busy ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            submitLabel
          )}
        </button>
        {onCancel && (
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-start gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-panel-2"
    >
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? 'bg-brand-500' : 'bg-line'
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-fg">{label}</span>
        {hint && <span className="block text-[11px] text-subtle">{hint}</span>}
      </span>
    </button>
  );
}
