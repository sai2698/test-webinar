'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AdminShell, type NavItem } from '@/components/admin/AdminShell';
import {
  IconCard,
  IconChart,
  IconChevron,
  IconDisc,
  IconEdit,
  IconExternal,
  IconPlay,
  IconPlus,
  IconSearch,
  IconSend,
  IconSpark,
  IconTrash,
  IconUsers,
  IconVideo,
} from '@/components/admin/icons';
import { WebinarForm, emptyWebinar, fromWebinar, type WebinarFormValues } from '@/components/WebinarForm';
import { EngagementPanel } from '@/components/EngagementPanel';
import { PaymentsPanel } from '@/components/PaymentsPanel';
import { RecordingsPanel } from '@/components/RecordingsPanel';
import { CustomFieldsPanel } from '@/components/admin/CustomFieldsPanel';
import { ApprovalPanel, InvitePanel } from '@/components/admin/ApprovalPanel';
import { CohostsPanel } from '@/components/admin/CohostsPanel';
import { StreamsPanel } from '@/components/admin/StreamsPanel';
import { SeriesPanel } from '@/components/admin/SeriesPanel';
import { EmbedPanel } from '@/components/admin/EmbedPanel';
import { WebhooksPanel } from '@/components/admin/WebhooksPanel';
import { AnalyticsPanel } from '@/components/admin/AnalyticsPanel';
import { AutomationPanel } from '@/components/admin/AutomationPanel';
import { ApiTokensPanel } from '@/components/admin/ApiTokensPanel';
import { endpoints, ApiError, type AuthUser } from '@/lib/api';
import {
  ADMIN_UNAUTHORIZED_EVENT,
  clearSession,
  getToken,
  getUser,
  writeSession,
} from '@/lib/session';

interface AdminWebinar {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  bannerUrl: string | null;
  startsAt: string;
  durationMins: number;
  timezone: string;
  status: string;
  host: { id: string; name: string; email: string } | null;
  settings: Record<string, unknown>;
  registrationCount?: number;
}

interface Registration {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  paid: boolean;
  attended: boolean;
  createdAt: string;
}

interface Analytics {
  registrations: number;
  paidRegistrations: number;
  revenuePaise: number;
  quizzes: { id: string; question: string; answers: number; correct: number }[];
}

type Tab =
  | 'webinars'
  | 'registrations'
  | 'analytics'
  | 'engagement'
  | 'payments'
  | 'recordings'
  | 'audience'
  | 'team'
  | 'distribution'
  | 'integrations';

const NAV: { key: Tab; label: string; icon: NavItem['icon'] }[] = [
  { key: 'webinars', label: 'Webinars', icon: IconVideo },
  { key: 'registrations', label: 'Registrations', icon: IconUsers },
  { key: 'audience', label: 'Audience', icon: IconSend },
  { key: 'team', label: 'Team', icon: IconUsers },
  { key: 'analytics', label: 'Analytics', icon: IconChart },
  { key: 'engagement', label: 'Engagement', icon: IconSpark },
  { key: 'distribution', label: 'Distribution', icon: IconExternal },
  { key: 'integrations', label: 'Integrations', icon: IconSpark },
  { key: 'payments', label: 'Payments', icon: IconCard },
  { key: 'recordings', label: 'Recordings', icon: IconDisc },
];

const TAB_TITLES: Record<Tab, string> = {
  webinars: 'Webinars',
  registrations: 'Registrations',
  analytics: 'Analytics',
  engagement: 'Engagement',
  payments: 'Payments',
  recordings: 'Recordings',
  audience: 'Audience',
  team: 'Team',
  distribution: 'Distribution',
  integrations: 'Integrations',
};

const TAB_BLURBS: Record<Tab, string> = {
  webinars: 'Create, publish and run your sessions.',
  registrations: 'Everyone who signed up, and whether they showed up.',
  analytics: 'Attendance, revenue and quiz performance.',
  engagement: 'Quizzes, offers and polls for the room.',
  payments: 'Orders, captures and refunds.',
  recordings: 'Replay timelines captured during live sessions.',
  audience: 'The sign-up form, the approval queue and bulk invites.',
  team: 'Co-hosts and exactly what each of them may do.',
  distribution: 'Simulcast, embeds and a recurring schedule.',
  integrations: 'Webhooks, tracking tags, automation and API tokens.',
};

/** Status pill colours, tuned for both palettes. */
const statusStyles: Record<string, string> = {
  LIVE: 'bg-red-500/12 text-red-600 ring-red-500/30 dark:text-red-300',
  SCHEDULED: 'bg-brand-500/12 text-brand-600 ring-brand-500/30 dark:text-brand-300',
  DRAFT: 'bg-panel-2 text-muted ring-line',
  ENDED: 'bg-panel-2 text-subtle ring-line',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatPrice(paise: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export default function AdminPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [webinars, setWebinars] = useState<AdminWebinar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Slug currently being joined, so only that row's button shows a spinner. */
  const [joiningSlug, setJoiningSlug] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('webinars');
  const [selected, setSelected] = useState<AdminWebinar | null>(null);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [query, setQuery] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AdminWebinar | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await endpoints.adminWebinars();
      setWebinars(res.webinars as AdminWebinar[]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/admin/login');
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not load webinars');
    } finally {
      setLoading(false);
    }
  }, [router]);

  /**
   * Sends the console back to sign-in and forgets the dead session.
   *
   * Clearing first matters: a redirect that leaves the token behind loops
   * straight back here on the next visit, and the user is never told why.
   */
  const signOutLocally = useCallback(() => {
    clearSession('admin');
    router.replace('/admin/login');
  }, [router]);

  useEffect(() => {
    // `getToken` reports an expired JWT as no session at all, so a stale token
    // lands on the sign-in page instead of a console that cannot load anything.
    if (!getToken('admin')) {
      router.replace('/admin/login');
      return;
    }
    const stored = getUser('admin');
    if (stored) setUser(stored as AuthUser);
    void load();
  }, [load, router]);

  /**
   * A 401 from any admin request means the session is gone — expired, revoked,
   * or signed out in another tab. The API client announces it once, and this is
   * the single place that reacts, so every panel gets the same behaviour
   * without each one having to handle it.
   */
  useEffect(() => {
    window.addEventListener(ADMIN_UNAUTHORIZED_EVENT, signOutLocally);
    return () => window.removeEventListener(ADMIN_UNAUTHORIZED_EVENT, signOutLocally);
  }, [signOutLocally]);

  /**
   * Keeps two tabs in step.
   *
   * Signing out in one tab must not leave the other showing a console whose
   * every request now fails. `storage` only fires in *other* tabs, which is
   * exactly the scope needed here.
   */
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === null || e.key.startsWith('nexa:admin:')) {
        if (!getToken('admin')) signOutLocally();
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [signOutLocally]);

  /**
   * Re-reads the selected webinar after a mutation that happens inside a tab.
   *
   * The premiere controls live in the recordings tab but change webinar-level
   * state, so the detail view has to re-fetch rather than trust its snapshot.
   */
  const refreshSelected = useCallback(async () => {
    if (!selected) return;
    try {
      const res = await endpoints.adminWebinar(selected.id);
      const fresh = res.webinar as AdminWebinar;
      setSelected(fresh);
      setWebinars((prev) => prev.map((w) => (w.id === fresh.id ? fresh : w)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not refresh the webinar');
    }
  }, [selected]);

  async function openDetail(w: AdminWebinar, nextTab: Tab) {
    setSelected(w);
    setTab(nextTab);
    setAnalytics(null);
    setRegistrations([]);
    // These tabs load their own data, so there is nothing to prefetch.
    if (nextTab === 'engagement' || nextTab === 'payments' || nextTab === 'recordings') return;
    try {
      if (nextTab === 'registrations') {
        const res = await endpoints.registrations(w.id);
        setRegistrations(res.registrations as Registration[]);
      } else {
        const res = await endpoints.analytics(w.id);
        setAnalytics((res as { analytics: Analytics }).analytics);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load details');
    }
  }

  /**
   * Walks staff straight into the room.
   *
   * The room page authenticates its socket with the participant session, and a
   * host has none — they never registered. `host-join` mints a join token
   * server-side without charging or registering them, and the room page falls
   * back to the console token for the socket itself.
   */
  async function joinRoom(slug: string) {
    setJoiningSlug(slug);
    setError(null);
    try {
      const res = await endpoints.hostJoin(slug);
      localStorage.setItem(`join:${slug}`, res.joinToken);
      router.push(`/room/${slug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join the room');
      setJoiningSlug(null);
    }
  }

  async function submitForm(values: WebinarFormValues) {
    setFormBusy(true);
    setFormError(null);
    try {
      const payload = {
        title: values.title,
        description: values.description,
        bannerUrl: values.bannerUrl || '',
        startsAt: new Date(values.startsAt).toISOString(),
        durationMins: values.durationMins,
        timezone: values.timezone,
        settings: {
          allowMic: values.allowMic,
          allowVideo: values.allowVideo,
          requireRegistration: values.requireRegistration,
          requirePayment: values.requirePayment,
          priceInPaise: values.priceInPaise,
          currency: 'INR',
          chatEnabled: values.chatEnabled,
          handRaiseEnabled: values.handRaiseEnabled,
          maxParticipants: values.maxParticipants,
          inviteOnly: values.inviteOnly,
          requireSignIn: values.requireSignIn,
          requireApproval: values.requireApproval,
          showPeopleTab: values.showPeopleTab,
          showQaTab: values.showQaTab,
          showPollsTab: values.showPollsTab,
          showParticipantsToEachOther: values.showParticipantsToEachOther,
          watermarkEnabled: values.watermarkEnabled,
          showLiveUsersCount: values.showLiveUsersCount,
          cohostStartWithoutHost: values.cohostStartWithoutHost,
          // Only send the passcode when the host typed one, so editing an
          // unrelated field cannot wipe an existing passcode.
          ...(values.passcode.trim() ? { passcode: values.passcode.trim() } : {}),
        },
      };

      if (editing) {
        await endpoints.updateWebinar(editing.id, payload);
      } else {
        await endpoints.createWebinar(payload);
      }
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not save webinar');
    } finally {
      setFormBusy(false);
    }
  }

  async function publish(w: AdminWebinar) {
    try {
      await endpoints.publishWebinar(w.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not publish');
    }
  }

  async function remove(w: AdminWebinar) {
    if (!confirm(`Delete "${w.title}"? This cannot be undone.`)) return;
    try {
      await endpoints.deleteWebinar(w.id);
      if (selected?.id === w.id) setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    }
  }

  /**
   * Signs out for real.
   *
   * Clearing local storage alone leaves the httpOnly cookie in place, so the
   * next request is still authenticated — the user appears signed out and then
   * silently is not. The server call revokes the cookie; the local clear runs
   * regardless so a network failure cannot trap someone in a session they
   * asked to leave.
   */
  async function logout() {
    try {
      await endpoints.logout();
    } catch {
      /* A failed revoke must not block the local sign-out. */
    }
    clearSession('admin');
    router.push('/admin/login');
  }

  const stats = useMemo(() => {
    const total = webinars.length;
    const live = webinars.filter((w) => w.status === 'LIVE').length;
    const regs = webinars.reduce((sum, w) => sum + (w.registrationCount ?? 0), 0);
    return { total, live, regs };
  }, [webinars]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return webinars;
    return webinars.filter(
      (w) => w.title.toLowerCase().includes(q) || w.slug.toLowerCase().includes(q)
    );
  }, [webinars, query]);

  const initialForm = useMemo<WebinarFormValues>(
    () => (editing ? fromWebinar(editing) : emptyWebinar),
    [editing]
  );

  const nav: NavItem[] = NAV.map((item) => ({
    ...item,
    badge: item.key === 'webinars' ? stats.total : undefined,
  }));

  const subtitle = selected && tab !== 'webinars' ? selected.title : TAB_BLURBS[tab];

  return (
    <AdminShell
      nav={nav}
      active={tab}
      onNavigate={(key) => {
        setTab(key as Tab);
        if (key === 'webinars') setSelected(null);
      }}
      title={TAB_TITLES[tab]}
      subtitle={subtitle}
      user={user ? { name: user.name, role: user.role } : null}
      onSignOut={logout}
      actions={
        <button
          onClick={() => {
            setEditing(null);
            setFormError(null);
            setShowForm(true);
          }}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-500 px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-brand-600 active:scale-[0.98]"
        >
          <IconPlus className="h-4 w-4" />
          <span className="hidden sm:inline">New webinar</span>
        </button>
      }
    >
      {error && (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300">
          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-xs font-medium opacity-70 transition hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {tab === 'webinars' ? (
        <WebinarsView
          loading={loading}
          webinars={filtered}
          total={webinars.length}
          query={query}
          onQuery={setQuery}
          stats={stats}
          joiningSlug={joiningSlug}
          onJoin={joinRoom}
          onOpen={openDetail}
          onEdit={(w) => {
            setEditing(w);
            setFormError(null);
            setShowForm(true);
          }}
          onPublish={publish}
          onDelete={remove}
          onCreate={() => {
            setEditing(null);
            setFormError(null);
            setShowForm(true);
          }}
        />
      ) : (
        <DetailView
          tab={tab}
          webinars={webinars}
          selected={selected}
          onSelect={(w) => void openDetail(w, tab)}
          onClear={() => setSelected(null)}
          onRefresh={() => void refreshSelected()}
          registrations={registrations}
          analytics={analytics}
        />
      )}

      {showForm && (
        <div className="fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
          <div className="my-8 w-full max-w-2xl rounded-2xl border border-line bg-panel p-6 shadow-pop">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-base font-semibold text-fg">
                {editing ? 'Edit webinar' : 'New webinar'}
              </h2>
              <button
                onClick={() => {
                  setShowForm(false);
                  setEditing(null);
                }}
                className="grid h-8 w-8 place-items-center rounded-lg text-subtle transition hover:bg-panel-2 hover:text-fg"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <WebinarForm
              initial={initialForm}
              submitLabel={editing ? 'Save changes' : 'Create webinar'}
              busy={formBusy}
              error={formError}
              onSubmit={submitForm}
              onCancel={() => {
                setShowForm(false);
                setEditing(null);
              }}
            />
          </div>
        </div>
      )}
    </AdminShell>
  );
}

/* ─────────────────────────── webinars list ─────────────────────────── */

function WebinarsView({
  loading,
  webinars,
  total,
  query,
  onQuery,
  stats,
  joiningSlug,
  onJoin,
  onOpen,
  onEdit,
  onPublish,
  onDelete,
  onCreate,
}: {
  loading: boolean;
  webinars: AdminWebinar[];
  total: number;
  query: string;
  onQuery: (v: string) => void;
  stats: { total: number; live: number; regs: number };
  joiningSlug: string | null;
  onJoin: (slug: string) => void;
  onOpen: (w: AdminWebinar, tab: Tab) => void;
  onEdit: (w: AdminWebinar) => void;
  onPublish: (w: AdminWebinar) => void;
  onDelete: (w: AdminWebinar) => void;
  onCreate: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Webinars" value={String(stats.total)} icon={IconVideo} />
        <StatCard label="Live now" value={String(stats.live)} icon={IconPlay} tone="live" />
        <StatCard label="Registrations" value={String(stats.regs)} icon={IconUsers} tone="mint" />
        <StatCard
          label="Avg. per webinar"
          value={String(stats.total ? Math.round(stats.regs / stats.total) : 0)}
          icon={IconChart}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search webinars…"
            className="h-10 w-full rounded-xl border border-line bg-panel pl-9 pr-3 text-sm text-fg placeholder:text-subtle outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        <span className="text-xs text-subtle">
          {webinars.length} of {total}
        </span>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[104px] animate-pulse rounded-2xl border border-line bg-panel"
            />
          ))}
        </div>
      ) : webinars.length === 0 ? (
        <EmptyState
          title={total === 0 ? 'No webinars yet' : 'Nothing matches that search'}
          body={
            total === 0
              ? 'Create your first session and it will show up here.'
              : 'Try a different title or slug.'
          }
          action={
            total === 0 ? (
              <button
                onClick={onCreate}
                className="inline-flex items-center gap-1.5 rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600"
              >
                <IconPlus className="h-4 w-4" />
                Create webinar
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {webinars.map((w) => (
            <WebinarRow
              key={w.id}
              webinar={w}
              joining={joiningSlug === w.slug}
              onJoin={onJoin}
              onOpen={onOpen}
              onEdit={onEdit}
              onPublish={onPublish}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WebinarRow({
  webinar: w,
  joining,
  onJoin,
  onOpen,
  onEdit,
  onPublish,
  onDelete,
}: {
  webinar: AdminWebinar;
  joining: boolean;
  onJoin: (slug: string) => void;
  onOpen: (w: AdminWebinar, tab: Tab) => void;
  onEdit: (w: AdminWebinar) => void;
  onPublish: (w: AdminWebinar) => void;
  onDelete: (w: AdminWebinar) => void;
}) {
  const paid = Boolean(w.settings?.requirePayment);
  return (
    <div className="group rounded-2xl border border-line bg-panel p-4 shadow-card transition hover:border-brand-300/60 hover:shadow-pop sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ${
                statusStyles[w.status] ?? statusStyles.DRAFT
              }`}
            >
              {w.status === 'LIVE' && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
                </span>
              )}
              {w.status}
            </span>
            {paid && (
              <span className="rounded-full bg-accent-500/15 px-2 py-0.5 text-[10px] font-semibold text-accent-600 dark:text-accent-400">
                {formatPrice(Number(w.settings?.priceInPaise ?? 0))}
              </span>
            )}
          </div>

          <h3 className="mt-1.5 text-[15px] font-semibold leading-snug text-fg">{w.title}</h3>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>{formatDate(w.startsAt)}</span>
            <span className="text-line">•</span>
            <span>{w.durationMins} min</span>
            <span className="text-line">•</span>
            <span className="inline-flex items-center gap-1">
              <IconUsers className="h-3.5 w-3.5" />
              {w.registrationCount ?? 0} registered
            </span>
          </div>

          <p className="mt-1.5 font-mono text-[11px] text-subtle">/w/{w.slug}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:shrink-0">
          <button
            onClick={() => onJoin(w.slug)}
            disabled={joining}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-500 px-3 text-xs font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
          >
            <IconPlay className="h-3.5 w-3.5" />
            {joining ? 'Joining…' : 'Join room'}
          </button>

          <div className="flex items-center gap-1 rounded-lg border border-line bg-panel-2 p-1">
            <IconButton label="Registrations" onClick={() => onOpen(w, 'registrations')}>
              <IconUsers className="h-4 w-4" />
            </IconButton>
            <IconButton label="Analytics" onClick={() => onOpen(w, 'analytics')}>
              <IconChart className="h-4 w-4" />
            </IconButton>
            <IconButton label="Engagement" onClick={() => onOpen(w, 'engagement')}>
              <IconSpark className="h-4 w-4" />
            </IconButton>
            <IconButton label="Payments" onClick={() => onOpen(w, 'payments')}>
              <IconCard className="h-4 w-4" />
            </IconButton>
            <IconButton label="Recordings" onClick={() => onOpen(w, 'recordings')}>
              <IconDisc className="h-4 w-4" />
            </IconButton>
          </div>

          <div className="flex items-center gap-1">
            <Link
              href={`/w/${w.slug}`}
              className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted transition hover:bg-panel-2 hover:text-fg"
              aria-label="View public page"
              title="View public page"
            >
              <IconExternal className="h-4 w-4" />
            </Link>
            <IconButton label="Edit" bordered onClick={() => onEdit(w)}>
              <IconEdit className="h-4 w-4" />
            </IconButton>
            {w.status === 'DRAFT' && (
              <button
                onClick={() => onPublish(w)}
                className="h-9 rounded-lg bg-accent-500 px-3 text-xs font-semibold text-ink-950 transition hover:bg-accent-400"
              >
                Publish
              </button>
            )}
            <IconButton label="Delete" bordered danger onClick={() => onDelete(w)}>
              <IconTrash className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  bordered,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  bordered?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid place-items-center transition ${
        bordered ? 'h-9 w-9 rounded-lg border border-line' : 'h-8 w-8 rounded-md'
      } ${
        danger
          ? 'text-muted hover:bg-red-500/10 hover:text-red-500'
          : 'text-muted hover:bg-panel hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

/* ─────────────────────────── detail views ─────────────────────────── */

function DetailView({
  tab,
  webinars,
  selected,
  onSelect,
  onClear,
  onRefresh,
  registrations,
  analytics,
}: {
  tab: Tab;
  webinars: AdminWebinar[];
  selected: AdminWebinar | null;
  onSelect: (w: AdminWebinar) => void;
  onClear: () => void;
  onRefresh: () => void;
  registrations: Registration[];
  analytics: Analytics | null;
}) {
  if (!selected) {
    return (
      <div className="rounded-2xl border border-line bg-panel p-6 shadow-card">
        <h2 className="text-sm font-semibold text-fg">Choose a webinar</h2>
        <p className="mt-1 text-xs text-muted">
          {TAB_TITLES[tab]} data is scoped to a single session — pick one to continue.
        </p>
        {webinars.length === 0 ? (
          <p className="py-10 text-center text-sm text-subtle">No webinars yet.</p>
        ) : (
          <div className="mt-4 divide-y divide-line">
            {webinars.map((w) => (
              <button
                key={w.id}
                onClick={() => onSelect(w)}
                className="flex w-full items-center gap-3 py-3 text-left transition hover:opacity-80"
              >
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ${
                    statusStyles[w.status] ?? statusStyles.DRAFT
                  }`}
                >
                  {w.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {w.title}
                </span>
                <span className="shrink-0 text-xs text-subtle">
                  {w.registrationCount ?? 0} regs
                </span>
                <IconChevron className="h-4 w-4 shrink-0 text-subtle" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onClear}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-muted transition hover:bg-panel-2 hover:text-fg"
        >
          <IconChevron className="h-3.5 w-3.5 rotate-180" />
          All webinars
        </button>
        <span className="text-xs text-subtle">
          {TAB_TITLES[tab]} · {selected.title}
        </span>
      </div>

      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card sm:p-6">
        {tab === 'registrations' ? (
          <RegistrationsTable registrations={registrations} />
        ) : tab === 'engagement' ? (
          <EngagementPanel webinarId={selected.id} />
        ) : tab === 'payments' ? (
          <PaymentsPanel webinarId={selected.id} />
        ) : tab === 'recordings' ? (
          <RecordingsPanel
            webinarId={selected.id}
            premiereRecordingId={
              (selected.settings.premiereRecordingId as string | null | undefined) ?? null
            }
            premiereStartedAt={
              (selected.settings.premiereStartedAt as string | null | undefined) ?? null
            }
            onPremiereChange={onRefresh}
          />
        ) : tab === 'audience' ? (
          <div className="space-y-8">
            <CustomFieldsPanel webinarId={selected.id} />
            <div className="divider" />
            <ApprovalPanel webinarId={selected.id} />
            <div className="divider" />
            <InvitePanel webinarId={selected.id} />
          </div>
        ) : tab === 'team' ? (
          <CohostsPanel webinarId={selected.id} />
        ) : tab === 'distribution' ? (
          <div className="space-y-8">
            <StreamsPanel webinarId={selected.id} isLive={selected.status === 'LIVE'} />
            <div className="divider" />
            <EmbedPanel webinarId={selected.id} />
            <div className="divider" />
            <SeriesPanel webinarId={selected.id} />
          </div>
        ) : tab === 'integrations' ? (
          <div className="space-y-8">
            <WebhooksPanel />
            <div className="divider" />
            <AnalyticsPanel webinarId={selected.id} />
            <div className="divider" />
            <AutomationPanel webinarId={selected.id} />
            <div className="divider" />
            <ApiTokensPanel />
          </div>
        ) : (
          <AnalyticsView analytics={analytics} />
        )}
      </div>
    </div>
  );
}

function RegistrationsTable({ registrations }: { registrations: Registration[] }) {
  if (registrations.length === 0) {
    return <p className="py-12 text-center text-sm text-subtle">No registrations yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-wider text-subtle">
            <th className="pb-2.5 pr-4 font-semibold">Name</th>
            <th className="pb-2.5 pr-4 font-semibold">Email</th>
            <th className="pb-2.5 pr-4 font-semibold">Phone</th>
            <th className="pb-2.5 pr-4 font-semibold">Paid</th>
            <th className="pb-2.5 pr-4 font-semibold">Attended</th>
            <th className="pb-2.5 font-semibold">Registered</th>
          </tr>
        </thead>
        <tbody>
          {registrations.map((r) => (
            <tr key={r.id} className="border-b border-line/60 last:border-0">
              <td className="py-3 pr-4 font-medium text-fg">{r.name}</td>
              <td className="py-3 pr-4 text-muted">{r.email}</td>
              <td className="py-3 pr-4 text-subtle">{r.phone ?? '—'}</td>
              <td className="py-3 pr-4">
                <Badge ok={r.paid} />
              </td>
              <td className="py-3 pr-4">
                <Badge ok={r.attended} />
              </td>
              <td className="py-3 text-xs text-subtle">{formatDate(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnalyticsView({ analytics }: { analytics: Analytics | null }) {
  if (!analytics) {
    return (
      <div className="grid place-items-center py-16">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-brand-500" />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Registrations" value={String(analytics.registrations)} icon={IconUsers} />
        <StatCard
          label="Paid"
          value={String(analytics.paidRegistrations)}
          icon={IconCard}
          tone="mint"
        />
        <StatCard label="Revenue" value={formatPrice(analytics.revenuePaise)} icon={IconChart} />
      </div>

      <div>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
          Quiz performance
        </p>
        {analytics.quizzes.length === 0 ? (
          <p className="text-sm text-subtle">No quizzes configured.</p>
        ) : (
          <div className="space-y-2">
            {analytics.quizzes.map((q) => {
              const pct = q.answers > 0 ? Math.round((q.correct / q.answers) * 100) : 0;
              return (
                <div key={q.id} className="rounded-xl border border-line bg-panel-2 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm text-fg">{q.question}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted">
                      {q.correct}/{q.answers} correct
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full rounded-full bg-mint-500 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── primitives ─────────────────────────── */

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'live' | 'mint';
}) {
  const toneClass =
    tone === 'live'
      ? 'bg-red-500/12 text-red-500'
      : tone === 'mint'
        ? 'bg-mint-500/12 text-mint-500'
        : 'bg-brand-500/12 text-brand-500';
  return (
    <div className="rounded-2xl border border-line bg-panel p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{label}</p>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-fg">{value}</p>
        </div>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${toneClass}`}>
          <Icon className="h-[18px] w-[18px]" />
        </span>
      </div>
    </div>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-panel/60 px-6 py-14 text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-brand-500/12 text-brand-500">
        <IconVideo className="h-6 w-6" />
      </div>
      <p className="text-sm font-semibold text-fg">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

function Badge({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
        ok ? 'bg-mint-500/15 text-mint-500 dark:text-mint-400' : 'bg-panel-2 text-subtle'
      }`}
    >
      {ok ? 'Yes' : 'No'}
    </span>
  );
}
