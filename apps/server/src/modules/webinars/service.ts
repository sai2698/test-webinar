import type { Webinar, WebinarModerator } from '@prisma/client';
import type { WebinarSettings, WebinarStatus } from '@webinar/shared';
import { prisma } from '../../db/prisma.js';
import { uniqueSlug } from '../../utils/slug.js';

export type WebinarWithRelations = Webinar & {
  moderators?: WebinarModerator[];
  host?: { id: string; name: string; email: string } | null;
};

export function toSettings(w: Webinar): WebinarSettings {
  return {
    allowMic: w.allowMic,
    allowVideo: w.allowVideo,
    requireRegistration: w.requireRegistration,
    requirePayment: w.requirePayment,
    priceInPaise: w.priceInPaise,
    currency: w.currency,
    chatEnabled: w.chatEnabled,
    handRaiseEnabled: w.handRaiseEnabled,
    maxParticipants: w.maxParticipants,
    // The passcode itself never leaves the server — clients only need to know
    // that one is required so they can prompt for it.
    passcodeRequired: Boolean(w.passcode),
    inviteOnly: w.inviteOnly,
    requireSignIn: w.requireSignIn,
    requireApproval: w.requireApproval,
    showPeopleTab: w.showPeopleTab,
    showQaTab: w.showQaTab,
    showPollsTab: w.showPollsTab,
    showParticipantsToEachOther: w.showParticipantsToEachOther,
    watermarkEnabled: w.watermarkEnabled,
    showLiveUsersCount: w.showLiveUsersCount,
    cohostStartWithoutHost: w.cohostStartWithoutHost,
    premiereRecordingId: w.premiereRecordingId,
    premiereStartedAt: w.premiereStartedAt?.toISOString() ?? null,
  };
}

export function serializeWebinar(w: WebinarWithRelations) {
  return {
    id: w.id,
    slug: w.slug,
    title: w.title,
    description: w.description,
    bannerUrl: w.bannerUrl,
    startsAt: w.startsAt.toISOString(),
    durationMins: w.durationMins,
    timezone: w.timezone,
    status: w.status as WebinarStatus,
    hostId: w.hostId,
    createdById: w.createdById,
    host: w.host ?? null,
    moderatorIds: w.moderators?.map((m) => m.userId) ?? [],
    settings: toSettings(w),
    /** When the host opened the session; `null` while it is still waiting. */
    startedAt: w.startedAt ? w.startedAt.toISOString() : null,
    createdAt: w.createdAt.toISOString(),
  };
}

/** Public projection — hides internal ids and staff assignments. */
export function serializePublicWebinar(w: WebinarWithRelations) {
  return {
    slug: w.slug,
    title: w.title,
    description: w.description,
    bannerUrl: w.bannerUrl,
    startsAt: w.startsAt.toISOString(),
    durationMins: w.durationMins,
    timezone: w.timezone,
    status: w.status as WebinarStatus,
    hostName: w.host?.name ?? 'Host',
    settings: {
      requireRegistration: w.requireRegistration,
      requirePayment: w.requirePayment,
      priceInPaise: w.priceInPaise,
      currency: w.currency,
      chatEnabled: w.chatEnabled,
      handRaiseEnabled: w.handRaiseEnabled,
      allowMic: w.allowMic,
      allowVideo: w.allowVideo,
      maxParticipants: w.maxParticipants,
      passcodeRequired: Boolean(w.passcode),
      inviteOnly: w.inviteOnly,
      requireSignIn: w.requireSignIn,
      requireApproval: w.requireApproval,
      showPeopleTab: w.showPeopleTab,
      showQaTab: w.showQaTab,
      showPollsTab: w.showPollsTab,
      showParticipantsToEachOther: w.showParticipantsToEachOther,
      watermarkEnabled: w.watermarkEnabled,
      showLiveUsersCount: w.showLiveUsersCount,
      cohostStartWithoutHost: w.cohostStartWithoutHost,
      premiereRecordingId: w.premiereRecordingId,
      premiereStartedAt: w.premiereStartedAt?.toISOString() ?? null,
    } satisfies WebinarSettings,
  };
}

export async function findWebinarBySlug(slug: string) {
  return prisma.webinar.findUnique({
    where: { slug },
    include: {
      moderators: true,
      host: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function findWebinarById(id: string) {
  return prisma.webinar.findUnique({
    where: { id },
    include: {
      moderators: true,
      host: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function generateUniqueSlug(title: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const candidate = uniqueSlug(title);
    const exists = await prisma.webinar.findUnique({ where: { slug: candidate } });
    if (!exists) return candidate;
  }
  return `${uniqueSlug(title)}-${Date.now().toString(36)}`;
}

/**
 * Reserve a slug derived from a known base, appending `-2`, `-3` … until it is
 * free. Series occurrences need a predictable slug (`weekly-demo-2`) rather
 * than a random one, so a host can guess the URL of next week's session.
 */
export async function reserveSlug(base: string): Promise<string> {
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70) || 'webinar';

  const taken = await prisma.webinar.findUnique({ where: { slug: clean } });
  if (!taken) return clean;

  for (let i = 2; i < 500; i++) {
    const candidate = `${clean}-${i}`;
    const exists = await prisma.webinar.findUnique({ where: { slug: candidate } });
    if (!exists) return candidate;
  }

  return `${clean}-${Date.now().toString(36)}`;
}
