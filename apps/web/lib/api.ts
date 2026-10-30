import type { RecordingDetail, RecordingSummary } from '@webinar/shared';
import { getToken, notifyAdminUnauthorized, type SessionScope } from './session';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? API_URL;

/**
 * The analytics ids a webinar can carry.
 *
 * Declared here rather than imported from `@webinar/shared` because the admin
 * console is the only consumer — the room never reads them, the server injects
 * the tags itself.
 */
export interface AnalyticsConfigShape {
  ga4MeasurementId: string | null;
  metaPixelId: string | null;
  clarityProjectId: string | null;
  gtmContainerId: string | null;
}

/** One row of a webhook endpoint's delivery log. */
export interface WebhookDeliveryRow {
  id: string;
  event: string;
  status: string;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  status: number;
  fieldErrors?: Record<string, string[]>;
  constructor(message: string, status: number, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Which identity a request should be sent as.
 *
 * Derived from the path rather than passed at every call site: the server
 * already draws almost exactly this line — everything under `/api/admin` is
 * staff, everything else is the attendee flow — so mirroring it here means a
 * new endpoint cannot accidentally be sent with the wrong token. An explicit
 * override is still available for the handful of routes that do not fit.
 *
 * `host-join` is the one staff route that does not live under `/api/admin`: it
 * is a webinar-scoped action, so it sits beside `register` and `claim`. It is
 * guarded by `requireAuth` and rejects anyone who is not the host or an
 * assigned moderator, which makes it a console action wearing an attendee URL.
 * Sending it as the participant would 401 for a host who has never registered
 * for their own webinar — which is every host.
 */
function scopeForPath(path: string): SessionScope {
  if (path.startsWith('/api/admin')) return 'admin';
  if (/^\/api\/webinars\/[^/]+\/host-join(\?|$)/.test(path)) return 'admin';
  return 'participant';
}

function authHeaders(scope: SessionScope): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = getToken(scope);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  scope: SessionScope = scopeForPath(path)
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(scope),
      ...(init.headers ?? {}),
    },
    credentials: 'include',
    cache: 'no-store',
  });

  const text = await res.text();

  /**
   * A body that is not JSON must not take the page down with it.
   *
   * `JSON.parse` throws on a truncated response — which happens for real when
   * the API restarts mid-request (tsx watch reloads on every save) or when a
   * proxy cuts a large payload short. An unguarded parse turns that into an
   * unhandled `SyntaxError` that blanks the whole route, so the failure is
   * converted into an `ApiError` the caller already knows how to display.
   */
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(
        res.ok
          ? 'The server sent a malformed response. Please try again.'
          : `Request failed (${res.status})`,
        res.status
      );
    }
  }

  if (!res.ok) {
    /**
     * A rejected staff request means the console's session is gone — expired,
     * revoked, or replaced. Announcing it once here is what lets the console
     * redirect to sign-in instead of rendering an empty page behind a stale
     * name. Only 401 qualifies: a 403 is a real permission answer about a
     * session that is still perfectly valid.
     */
    if (res.status === 401 && scope === 'admin') notifyAdminUnauthorized();

    throw new ApiError(
      body?.error ?? body?.message ?? `Request failed (${res.status})`,
      res.status,
      body?.fieldErrors
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, scope?: SessionScope) => request<T>(path, {}, scope),
  post: <T>(path: string, data?: unknown, scope?: SessionScope) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(data ?? {}) }, scope),
  patch: <T>(path: string, data?: unknown, scope?: SessionScope) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data ?? {}) }, scope),
  del: <T>(path: string, scope?: SessionScope) =>
    request<T>(path, { method: 'DELETE' }, scope),
};

/* ── typed endpoints ─────────────────────────────────────── */

export interface PublicWebinar {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  bannerUrl: string | null;
  startsAt: string;
  durationMins: number;
  timezone: string;
  status: string;
  requireRegistration: boolean;
  requirePayment: boolean;
  priceInPaise: number;
  currency: string;
  hostName: string;
  seatsLeft: number | null;
  /** True when the room needs a passcode — the value itself is never sent. */
  passcodeRequired: boolean;
  inviteOnly: boolean;
  requireSignIn: boolean;
  /** When set, the room plays this recording instead of hosting live media. */
  premiereRecordingId: string | null;
  /** ISO timestamp of when the premiere clock started, or null. */
  premiereStartedAt: string | null;
}

/**
 * The public endpoint returns settings as a nested object, but every consumer
 * of this type reads them as flat fields. Flattening here keeps the wire
 * format honest and the component code readable — and avoids the trap where
 * `webinar.requireRegistration` silently reads `undefined` and every webinar
 * looks like it has registration switched off.
 */
function normalizePublicWebinar(raw: Record<string, unknown>): PublicWebinar {
  const settings = (raw.settings ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ''),
    slug: String(raw.slug ?? ''),
    title: String(raw.title ?? ''),
    description: (raw.description as string | null) ?? null,
    bannerUrl: (raw.bannerUrl as string | null) ?? null,
    startsAt: String(raw.startsAt ?? ''),
    durationMins: Number(raw.durationMins ?? 0),
    timezone: String(raw.timezone ?? 'UTC'),
    status: String(raw.status ?? 'SCHEDULED'),
    requireRegistration: Boolean(settings.requireRegistration),
    requirePayment: Boolean(settings.requirePayment),
    priceInPaise: Number(settings.priceInPaise ?? 0),
    currency: String(settings.currency ?? 'INR'),
    hostName: String(raw.hostName ?? 'Host'),
    seatsLeft: raw.seatsLeft === undefined || raw.seatsLeft === null ? null : Number(raw.seatsLeft),
    passcodeRequired: Boolean(settings.passcodeRequired),
    inviteOnly: Boolean(settings.inviteOnly),
    requireSignIn: Boolean(settings.requireSignIn),
    premiereRecordingId: (settings.premiereRecordingId as string | null) ?? null,
    premiereStartedAt: (settings.premiereStartedAt as string | null) ?? null,
  };
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'HOST' | 'MODERATOR' | 'PARTICIPANT';
}

export const endpoints = {
  publicWebinar: (slug: string) =>
    api
      .get<{ webinar: Record<string, unknown> }>(`/api/webinars/${slug}/public`)
      .then((res) => ({ webinar: normalizePublicWebinar(res.webinar) })),

  login: (email: string, password: string) =>
    api.post<{ token: string; user: AuthUser }>('/api/auth/login', { email, password }),

  /**
   * Revokes the httpOnly session cookie.
   *
   * Clearing local storage is not enough on its own: the cookie is what the
   * server actually trusts, so without this call a "signed out" browser keeps
   * authenticating every request it makes.
   */
  logout: () => api.post<{ ok: boolean }>('/api/auth/logout', {}, 'admin'),

  me: () => api.get<{ user: AuthUser }>('/api/auth/me', 'admin'),

  register: (
    slug: string,
    data: {
      name: string;
      email: string;
      phone: string;
      passcode?: string;
      /** Answers to the host's custom questions, keyed by field id. */
      customResponses?: Record<string, unknown>;
    }
  ) =>
    api
      .post<{
        token: string;
        user: AuthUser;
        requiresPayment: boolean;
        amountPaise?: number;
        joinToken?: string;
        registration?: { joinToken: string; paid: boolean; status?: string };
        /** True when the host must approve this person before they can join. */
        pendingApproval?: boolean;
      }>(`/api/webinars/${slug}/register`, data)
      // The server nests the join token under `registration`; the rest of the
      // app reads it flat, so lift it here rather than at every call site.
      .then((res) => ({
        token: res.token,
        user: res.user,
        requiresPayment: res.requiresPayment,
        amountPaise: res.amountPaise ?? 0,
        joinToken: res.joinToken ?? res.registration?.joinToken ?? '',
        pendingApproval: Boolean(res.pendingApproval),
      })),

  // One-click entry for a webinar that does not require registration. The
  // server mints a throwaway guest user and returns the same shape as
  // `register`, so the caller can share the post-registration flow.
  guestJoin: (slug: string, name: string, passcode?: string) =>
    api.post<{
      token: string;
      user: AuthUser;
      requiresPayment: boolean;
      joinToken: string;
    }>(`/api/webinars/${slug}/guest`, { name, passcode }),

  joinInfo: (slug: string, token: string) =>
    api.get<{
      ok: boolean;
      user: { id: string; name: string; email: string; phone: string | null; role: string };
      needsProfile: boolean;
      passcodeRequired: boolean;
      /** PENDING means the host has not approved this person yet. */
      approvalStatus?: string;
      webinar: { slug: string; title: string; status: string };
    }>(`/api/webinars/${slug}/join-info?token=${encodeURIComponent(token)}`),

  /**
   * The shared-join-link gate: attaches a name and mobile to an existing
   * registration and returns a fresh JWT so the room can connect.
   */
  claim: (
    slug: string,
    data: { token: string; name: string; phone: string; passcode?: string }
  ) =>
    api.post<{
      token: string;
      user: AuthUser;
      registration: { joinToken: string; paid: boolean; status?: string };
      pendingApproval?: boolean;
      webinar: { slug: string; title: string; status: string };
    }>(`/api/webinars/${slug}/claim`, data),

  createOrder: (data: { webinarId?: string; ctaId?: string }) =>
    api.post<{
      orderId: string;
      amount: number;
      currency: string;
      paymentId: string;
      keyId: string | null;
      mock: boolean;
    }>('/api/payments/order', data),

  verifyPayment: (data: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }) => api.post<{ ok: boolean }>('/api/payments/verify', data),

  serverTime: () => api.get<{ now: number }>('/api/time'),

  /* admin */
  adminWebinars: () => api.get<{ webinars: unknown[] }>('/api/admin/webinars'),
  adminWebinar: (id: string) => api.get<{ webinar: unknown }>(`/api/admin/webinars/${id}`),
  createWebinar: (data: unknown) => api.post<{ webinar: { id: string; slug: string } }>('/api/admin/webinars', data),
  updateWebinar: (id: string, data: unknown) =>
    api.patch<{ webinar: unknown }>(`/api/admin/webinars/${id}`, data),
  publishWebinar: (id: string) => api.post<{ webinar: unknown }>(`/api/admin/webinars/${id}/publish`),
  deleteWebinar: (id: string) => api.del<{ ok: boolean }>(`/api/admin/webinars/${id}`),
  registrations: (id: string) => api.get<{ registrations: unknown[] }>(`/api/admin/webinars/${id}/registrations`),
  analytics: (id: string) => api.get<Record<string, unknown>>(`/api/admin/webinars/${id}/analytics`),
  quizzes: (webinarId: string) => api.get<{ quizzes: unknown[] }>(`/api/admin/${webinarId}/quizzes`),
  createQuiz: (webinarId: string, data: unknown) =>
    api.post<{ quiz: unknown }>(`/api/admin/${webinarId}/quizzes`, data),
  updateQuiz: (id: string, data: unknown) =>
    api.patch<{ quiz: unknown }>(`/api/admin/quizzes/${id}`, data),
  deleteQuiz: (id: string) => api.del<{ ok: boolean }>(`/api/admin/quizzes/${id}`),
  polls: (webinarId: string) => api.get<{ polls: unknown[] }>(`/api/admin/${webinarId}/polls`),
  createPoll: (webinarId: string, data: unknown) =>
    api.post<{ poll: unknown }>(`/api/admin/${webinarId}/polls`, data),
  updatePoll: (id: string, data: unknown) =>
    api.patch<{ poll: unknown }>(`/api/admin/polls/${id}`, data),
  deletePoll: (id: string) => api.del<{ ok: boolean }>(`/api/admin/polls/${id}`),
  ctas: (webinarId: string) => api.get<{ ctas: unknown[] }>(`/api/admin/${webinarId}/ctas`),
  createCta: (webinarId: string, data: unknown) =>
    api.post<{ cta: unknown }>(`/api/admin/${webinarId}/ctas`, data),
  updateCta: (id: string, data: unknown) =>
    api.patch<{ cta: unknown }>(`/api/admin/ctas/${id}`, data),
  ctaClicks: (id: string) =>
    api.get<{
      clicks: {
        id: string;
        userId: string;
        name: string;
        email: string;
        phone: string | null;
        responses: Record<string, unknown>;
        purchasedAt: string | null;
        createdAt: string;
      }[];
      total: number;
      purchased: number;
    }>(`/api/admin/ctas/${id}/clicks`),
  /**
   * Who opened an offer, what they answered, and whether they paid.
   *
   * Separate from `ctaClicks` because it is served by a different router: this
   * one is open to co-hosts, whose JWT role is still PARTICIPANT.
   */
  ctaFollowUp: (id: string) =>
    api.get<{
      offer: {
        id: string;
        title: string;
        priceInPaise: number;
        currency: string;
        formEnabled: boolean;
      };
      fields: { id: string; label: string; type: string }[];
      people: {
        userId: string;
        name: string;
        email: string;
        phone: string | null;
        clickedAt: string;
        formFilled: boolean;
        answeredCount: number;
        responses: Record<string, unknown>;
        paymentStatus: string | null;
        paidAt: string | null;
        amountPaise: number | null;
        purchasedAt: string | null;
        attended: boolean;
        registeredAt: string | null;
      }[];
      summary: { clicked: number; formFilled: number; paid: number; pending: number };
    }>(`/api/admin/ctas/${id}/follow-up`),
  deleteCta: (id: string) => api.del<{ ok: boolean }>(`/api/admin/ctas/${id}`),
  courses: () => api.get<{ courses: unknown[] }>('/api/admin/courses'),
  createCourse: (data: unknown) => api.post<{ course: unknown }>('/api/admin/courses', data),
  deleteCourse: (id: string) => api.del<{ ok: boolean }>(`/api/admin/courses/${id}`),

  payments: (webinarId: string) =>
    api.get<{ payments: unknown[] }>(`/api/admin/payments?webinarId=${webinarId}`),
  refundPayment: (id: string, amountPaise?: number) =>
    api.post<{ ok: boolean; refundId: string; amountPaise: number; full: boolean; mock: boolean }>(
      `/api/admin/payments/${id}/refund`,
      amountPaise ? { amountPaise } : {}
    ),

  /* recordings */
  recordings: (webinarId: string) =>
    api.get<{ recordings: RecordingSummary[] }>(
      `/api/admin/recordings?webinarId=${encodeURIComponent(webinarId)}`
    ),
  deleteRecording: (id: string) => api.del<{ ok: boolean }>(`/api/admin/recordings/${id}`),
  /** Public replay payload — timeline plus chat, no auth required. */
  replay: (slug: string, id: string) =>
    api.get<{ recording: RecordingDetail }>(
      `/api/webinars/${encodeURIComponent(slug)}/recordings/${encodeURIComponent(id)}`
    ),
  /** Public replay by recording id — what a shared replay link uses. */
  replayById: (id: string) =>
    api.get<{ recording: RecordingDetail }>(`/api/recordings/${encodeURIComponent(id)}`),
  /** Public list of watchable replays for a webinar. */
  publicRecordings: (slug: string) =>
    api.get<{ webinar: { slug: string; title: string }; recordings: RecordingSummary[] }>(
      `/api/webinars/${encodeURIComponent(slug)}/recordings`
    ),

  /* premiere — a recording presented as a scheduled live session */
  /** Attaches a READY recording to the webinar as its premiere content. */
  attachPremiere: (webinarId: string, recordingId: string) =>
    api.patch<{ webinar: unknown }>(`/api/admin/webinars/${encodeURIComponent(webinarId)}`, {
      settings: { premiereRecordingId: recordingId },
    }),
  /** Detaches the premiere recording, returning the webinar to a live session. */
  detachPremiere: (webinarId: string) =>
    api.patch<{ webinar: unknown }>(`/api/admin/webinars/${encodeURIComponent(webinarId)}`, {
      settings: { premiereRecordingId: null },
    }),
  /** Starts (or re-runs) the premiere clock. */
  startPremiere: (webinarId: string) =>
    api.post<{ webinar: unknown }>(
      `/api/admin/webinars/${encodeURIComponent(webinarId)}/premiere/start`,
      {}
    ),
  /** Ends the premiere. */
  stopPremiere: (webinarId: string) =>
    api.post<{ webinar: unknown }>(
      `/api/admin/webinars/${encodeURIComponent(webinarId)}/premiere/stop`,
      {}
    ),

  /* staff */
  /** Issues a join token for staff so they can enter the room directly. */
  hostJoin: (slug: string) =>
    api.post<{
      joinToken: string;
      webinar: { slug: string; title: string; startsAt: string };
    }>(`/api/webinars/${encodeURIComponent(slug)}/host-join`, {}),

  /* ── webinar.gg parity ─────────────────────────────────────
   * Every path below mirrors a router mounted in `apps/server/src/index.ts`.
   * The admin routers all live under `/api/admin` and take the webinar id as
   * their first path segment, except the ones that address a child row by its
   * own id (`/custom-fields/:id`, `/cohosts/:id`, …).
   */

  /* custom registration fields */
  customFields: (webinarId: string) =>
    api.get<{ fields: unknown[] }>(`/api/admin/${webinarId}/custom-fields`),
  createCustomField: (webinarId: string, data: unknown) =>
    api.post<{ field: unknown }>(`/api/admin/${webinarId}/custom-fields`, data),
  updateCustomField: (id: string, data: unknown) =>
    api.patch<{ field: unknown }>(`/api/admin/custom-fields/${id}`, data),
  deleteCustomField: (id: string) =>
    api.del<{ ok: boolean }>(`/api/admin/custom-fields/${id}`),
  /** Public: the registration form a visitor is shown. */
  publicForm: (slug: string) =>
    api.get<{ fields: unknown[] }>(`/api/webinars/${encodeURIComponent(slug)}/form`),

  /* co-hosts */
  cohosts: (webinarId: string) =>
    api.get<{ cohosts: unknown[]; maxCohosts: number }>(`/api/admin/${webinarId}/cohosts`),
  addCohost: (webinarId: string, data: unknown) =>
    api.post<{ cohost: unknown }>(`/api/admin/${webinarId}/cohosts`, data),
  updateCohost: (id: string, data: unknown) =>
    api.patch<{ cohost: unknown }>(`/api/admin/cohosts/${id}`, data),
  removeCohost: (id: string) => api.del<{ ok: boolean }>(`/api/admin/cohosts/${id}`),
  /** What the signed-in user may do in this webinar. */
  myCohostPolicy: (webinarId: string) =>
    api.get<{ isOwner: boolean; permissions: Record<string, boolean> }>(
      `/api/admin/${webinarId}/cohost-policy/me`
    ),

  /* stream destinations */
  streamDestinations: (webinarId: string) =>
    api.get<{ destinations: unknown[] }>(`/api/admin/${webinarId}/stream-destinations`),
  addStreamDestination: (webinarId: string, data: unknown) =>
    api.post<{ destination: unknown }>(`/api/admin/${webinarId}/stream-destinations`, data),
  deleteStreamDestination: (id: string) =>
    api.del<{ ok: boolean }>(`/api/admin/stream-destinations/${id}`),
  /** The ready-to-paste FFmpeg command for the configured destinations. */
  streamFfmpeg: (webinarId: string) =>
    api.get<{ command: string }>(`/api/admin/${webinarId}/stream-destinations/ffmpeg`),

  /* webhooks */
  webhooks: () => api.get<{ endpoints: unknown[] }>('/api/admin/webhooks'),
  webhookEvents: () => api.get<{ events: string[] }>('/api/admin/webhooks/events'),
  createWebhook: (data: unknown) =>
    api.post<{ endpoint: unknown; secret: string }>('/api/admin/webhooks', data),
  updateWebhook: (id: string, data: unknown) =>
    api.patch<{ endpoint: unknown }>(`/api/admin/webhooks/${id}`, data),
  deleteWebhook: (id: string) => api.del<{ ok: boolean }>(`/api/admin/webhooks/${id}`),
  rotateWebhook: (id: string) =>
    api.post<{ secret: string }>(`/api/admin/webhooks/${id}/rotate`, {}),
  webhookDeliveries: (id: string) =>
    api.get<{ deliveries: WebhookDeliveryRow[] }>(`/api/admin/webhooks/${id}/deliveries`),

  /* API tokens */
  apiTokens: () => api.get<{ tokens: unknown[] }>('/api/admin/api-tokens'),
  createApiToken: (name: string) =>
    api.post<{ token: unknown; plaintext: string }>('/api/admin/api-tokens', { name }),
  revokeApiToken: (id: string) => api.del<{ ok: boolean }>(`/api/admin/api-tokens/${id}`),

  /* embed */
  embed: (webinarId: string) =>
    api.get<{ embed: { enabled: boolean; allowedOrigins: string[] }; snippet: string }>(
      `/api/admin/${webinarId}/embed`
    ),
  setEmbed: (webinarId: string, data: { enabled: boolean; allowedOrigins: string[] }) =>
    api.patch<{ embed: { enabled: boolean; allowedOrigins: string[] } }>(
      `/api/admin/${webinarId}/embed`,
      data
    ),

  /* analytics integrations */
  analyticsConfig: (webinarId: string) =>
    api.get<{ config: AnalyticsConfigShape }>(`/api/admin/${webinarId}/analytics-config`),
  setAnalyticsConfig: (webinarId: string, data: Record<string, string | null>) =>
    api.patch<{ config: AnalyticsConfigShape }>(
      `/api/admin/${webinarId}/analytics-config`,
      data
    ),

  /* automation */
  automationCues: (webinarId: string) =>
    api.get<{ bundle: unknown; cues: unknown[] }>(`/api/admin/${webinarId}/automation/cues`),
  importAutomation: (webinarId: string, bundle: unknown) =>
    api.post<{
      bundle: unknown;
      cues: unknown[];
      summary: { personas: number; chatLines: number; questions: number; cues: number };
    }>(`/api/admin/${webinarId}/automation/import`, bundle),
  updateAutomationCue: (id: string, data: unknown) =>
    api.patch<{ cue: unknown }>(`/api/admin/automation/cues/${id}`, data),
  resetAutomation: (webinarId: string) =>
    api.post<{ ok: boolean }>(`/api/admin/${webinarId}/automation/reset`, {}),
  /** The export is a file download, so it is fetched directly rather than via `api`. */
  automationExportUrl: (webinarId: string) =>
    `${API_URL}/api/admin/${webinarId}/automation/export`,

  /* recurring series */
  series: (webinarId: string) =>
    api.get<{ series: unknown | null; occurrences: unknown[] }>(`/api/admin/${webinarId}/series`),
  previewSeries: (webinarId: string, rule: unknown) =>
    api.post<{ occurrences: string[]; total: number }>(
      `/api/admin/${webinarId}/series/preview`,
      rule
    ),  createSeries: (webinarId: string, rule: unknown) =>
    api.post<{ series: unknown; occurrenceCount: number }>(
      `/api/admin/${webinarId}/series`,
      rule
    ),
  cancelSeries: (id: string) =>
    api.del<{ ok: boolean; cancelledOccurrences: number }>(`/api/admin/series/${id}`),

  /* registration approval queue */
  adminRegistrations: (webinarId: string) =>
    api.get<{ registrations: unknown[]; counts: Record<string, number> }>(
      `/api/admin/${webinarId}/registrations`
    ),
  setRegistrationStatus: (registrationId: string, status: string, note?: string) =>
    api.patch<{ registration: unknown; counts: Record<string, number> }>(
      `/api/admin/registrations/${registrationId}`,
      { status, note }
    ),
  approveAllRegistrations: (webinarId: string) =>
    api.post<{ approved: number; counts: Record<string, number> }>(
      `/api/admin/${webinarId}/registrations/approve-all`,
      {}
    ),
  /** Bulk invite by email. Each address becomes a real registration. */
  invite: (webinarId: string, emails: string[]) =>
    api.post<{ invited: number; results: { email: string; invited: boolean; reason?: string }[] }>(
      `/api/admin/${webinarId}/invite`,
      { emails }
    ),
  uninvite: (webinarId: string, email: string) =>
    api.del<{ ok: boolean }>(
      `/api/admin/${webinarId}/invite?email=${encodeURIComponent(email)}`
    ),
  /** CSV export is a file download, so it is fetched directly. */
  registrationsExportUrl: (webinarId: string) =>
    `${API_URL}/api/admin/${webinarId}/registrations/export`,
};
