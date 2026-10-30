import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireApiToken } from './auth.js';
import { createWebinarSchema, updateWebinarSchema } from '../webinars/schema.js';
import { generateUniqueSlug, serializeWebinar } from '../webinars/service.js';
import { emitWebhook } from '../webhooks/service.js';

export const publicApiRouter = Router();

publicApiRouter.use(requireApiToken);

/**
 * The public API envelope.
 *
 * Every response — success or failure — is `{ success, data }` or
 * `{ success, error }`. A machine client should never have to guess whether a
 * body is a payload or an error message, and a bare array at the top level
 * cannot carry pagination.
 */
function ok<T>(res: Response, data: T, status = 200) {
  res.status(status).json({ success: true, data });
}

function fail(res: Response, message: string, status = 400, details?: unknown) {
  res.status(status).json({ success: false, error: message, details });
}

/** Pagination, with a hard cap so one request cannot pull the whole table. */
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ── Webinars ──────────────────────────────────────────────── */

/** GET /api/v1/webinars */
publicApiRouter.get(
  '/webinars',
  asyncHandler(async (req, res) => {
    const { limit, offset } = pageSchema.parse(req.query);
    const status = String(req.query.status ?? '');

    const where = {
      createdById: req.user!.id,
      ...(status ? { status } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.webinar.findMany({
        where,
        orderBy: { startsAt: 'desc' },
        take: limit,
        skip: offset,
        include: { _count: { select: { registrations: true } } },
      }),
      prisma.webinar.count({ where }),
    ]);

    ok(res, {
      webinars: rows.map((w) => ({
        ...serializeWebinar(w),
        registrationCount: w._count.registrations,
      })),
      pagination: { total, limit, offset, hasMore: offset + rows.length < total },
    });
  })
);

/** GET /api/v1/webinars/:id */
publicApiRouter.get(
  '/webinars/:id',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findFirst({
      where: { OR: [{ id: req.params.id }, { slug: req.params.id }] },
      include: {
        _count: { select: { registrations: true } },
        customFields: {
          where: { deletedAt: null },
          orderBy: { order: 'asc' },
          include: { options: { where: { deletedAt: null }, orderBy: { order: 'asc' } } },
        },
      },
    });

    if (!webinar) {
      fail(res, 'Webinar not found', 404);
      return;
    }

    ok(res, {
      webinar: {
        ...serializeWebinar(webinar),
        registrationCount: webinar._count.registrations,
        customFields: webinar.customFields.map((f) => ({
          id: f.id,
          label: f.label,
          type: f.type,
          isRequired: f.isRequired,
          order: f.order,
          options: f.options.map((o) => ({ id: o.id, label: o.label, value: o.value })),
        })),
      },
    });
  })
);

/** POST /api/v1/webinars */
publicApiRouter.post(
  '/webinars',
  asyncHandler(async (req, res) => {
    const body = createWebinarSchema.parse(req.body);

    const slug = body.slug ?? (await generateUniqueSlug(body.title));

    const webinar = await prisma.webinar.create({
      data: {
        slug,
        title: body.title,
        description: body.description,
        bannerUrl: body.bannerUrl || null,
        startsAt: body.startsAt,
        durationMins: body.durationMins,
        timezone: body.timezone,
        status: body.status,
        hostId: body.hostId ?? req.user!.id,
        createdById: req.user!.id,
        ...body.settings,
        passcode: body.settings.passcode?.trim() || null,
        moderators: {
          create: body.moderatorIds.map((userId) => ({ userId })),
        },
      },
    });

    void emitWebhook('webinar.created', {
      webinarId: webinar.id,
      slug: webinar.slug,
      title: webinar.title,
      startsAt: webinar.startsAt.toISOString(),
    });

    ok(res, { webinar: serializeWebinar(webinar) }, 201);
  })
);

/** PATCH /api/v1/webinars/:id */
publicApiRouter.patch(
  '/webinars/:id',
  asyncHandler(async (req, res) => {
    const body = updateWebinarSchema.parse(req.body);

    const existing = await prisma.webinar.findFirst({
      where: { OR: [{ id: req.params.id }, { slug: req.params.id }] },
    });
    if (!existing) {
      fail(res, 'Webinar not found', 404);
      return;
    }

    const { settings, moderatorIds, ...rest } = body;

    const webinar = await prisma.webinar.update({
      where: { id: existing.id },
      data: {
        ...rest,
        ...(settings ?? {}),
        ...(settings?.passcode !== undefined
          ? { passcode: settings.passcode?.trim() || null }
          : {}),
        ...(moderatorIds
          ? {
              moderators: {
                deleteMany: {},
                create: moderatorIds.map((userId) => ({ userId })),
              },
            }
          : {}),
      },
    });

    void emitWebhook('webinar.updated', {
      webinarId: webinar.id,
      slug: webinar.slug,
      title: webinar.title,
    });

    ok(res, { webinar: serializeWebinar(webinar) });
  })
);

/** DELETE /api/v1/webinars/:id */
publicApiRouter.delete(
  '/webinars/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.webinar.findFirst({
      where: { OR: [{ id: req.params.id }, { slug: req.params.id }] },
    });
    if (!existing) {
      fail(res, 'Webinar not found', 404);
      return;
    }

    await prisma.webinar.delete({ where: { id: existing.id } });

    void emitWebhook('webinar.deleted', {
      webinarId: existing.id,
      slug: existing.slug,
      title: existing.title,
    });

    ok(res, { deleted: true });
  })
);

/* ── Lifecycle ─────────────────────────────────────────────── */

/**
 * GET /api/v1/webinars/:id/status
 *
 * The anonymous-friendly lifecycle poll webinar.gg documents. Returns only what
 * a status widget needs — no title, no attendee list, nothing that would leak
 * a private event to someone who guessed a slug.
 */
publicApiRouter.get(
  '/webinars/:id/status',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findFirst({
      where: { OR: [{ id: req.params.id }, { slug: req.params.id }] },
      select: { id: true, status: true, startedAt: true, updatedAt: true },
    });

    if (!webinar) {
      fail(res, 'Webinar not found', 404);
      return;
    }

    ok(res, {
      id: webinar.id,
      status: webinar.status,
      startedAt: webinar.startedAt?.toISOString() ?? null,
      endedAt: webinar.status === 'ENDED' ? webinar.updatedAt.toISOString() : null,
    });
  })
);

/**
 * GET /api/v1/webinars/:id/metrics
 *
 * Post-event metrics. Computed on demand and cached in WebinarMetrics, because
 * the attendance curve is a scan over every registration and every timeline
 * event — cheap once, wasteful on every page load.
 */
publicApiRouter.get(
  '/webinars/:id/metrics',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findFirst({
      where: { OR: [{ id: req.params.id }, { slug: req.params.id }] },
      select: { id: true, startedAt: true, updatedAt: true, status: true },
    });
    if (!webinar) {
      fail(res, 'Webinar not found', 404);
      return;
    }

    const cached = await prisma.webinarMetrics.findUnique({
      where: { webinarId: webinar.id },
    });

    // A live webinar's numbers are still moving, so a cache would be a lie.
    if (cached && webinar.status === 'ENDED') {
      ok(res, {
        metrics: {
          totalUsers: cached.totalUsers,
          maxLiveUsers: cached.maxLiveUsers,
          durationMinutes: cached.durationMinutes,
          timeSeries: safeParse(cached.timeSeriesJson, []),
          engagement: safeParse(cached.engagementJson, {}),
          computedAt: cached.computedAt.toISOString(),
        },
      });
      return;
    }

    const metrics = await computeMetrics(webinar.id, webinar.startedAt, webinar.updatedAt);

    await prisma.webinarMetrics.upsert({
      where: { webinarId: webinar.id },
      create: {
        webinarId: webinar.id,
        totalUsers: metrics.totalUsers,
        maxLiveUsers: metrics.maxLiveUsers,
        durationMinutes: metrics.durationMinutes,
        timeSeriesJson: JSON.stringify(metrics.timeSeries),
        engagementJson: JSON.stringify(metrics.engagement),
      },
      update: {
        totalUsers: metrics.totalUsers,
        maxLiveUsers: metrics.maxLiveUsers,
        durationMinutes: metrics.durationMinutes,
        timeSeriesJson: JSON.stringify(metrics.timeSeries),
        engagementJson: JSON.stringify(metrics.engagement),
        computedAt: new Date(),
      },
    });

    ok(res, { metrics });
  })
);

/* ── Registrations ─────────────────────────────────────────── */

/** GET /api/v1/webinars/:id/registrations */
publicApiRouter.get(
  '/webinars/:id/registrations',
  asyncHandler(async (req, res) => {
    const { limit, offset } = pageSchema.parse(req.query);

    const webinar = await prisma.webinar.findFirst({
      where: { OR: [{ id: req.params.id }, { slug: req.params.id }] },
      select: { id: true },
    });
    if (!webinar) {
      fail(res, 'Webinar not found', 404);
      return;
    }

    const [rows, total] = await Promise.all([
      prisma.registration.findMany({
        where: { webinarId: webinar.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { user: { select: { name: true, email: true, phone: true } } },
      }),
      prisma.registration.count({ where: { webinarId: webinar.id } }),
    ]);

    ok(res, {
      registrations: rows.map((r) => ({
        id: r.id,
        name: r.user.name,
        email: r.user.email,
        phone: r.user.phone,
        status: r.status,
        paid: r.paid,
        attended: r.attended,
        createdAt: r.createdAt.toISOString(),
      })),
      pagination: { total, limit, offset, hasMore: offset + rows.length < total },
    });
  })
);

/**
 * POST /api/v1/webinars/:id/join-tokens
 *
 * Mints a short-lived join token so an integration can drop a known attendee
 * straight into the room. 10 minutes and 10 uses, matching webinar.gg — a
 * single-use token breaks on a page refresh, and an unlimited one is a
 * permanent open door.
 */
publicApiRouter.post(
  '/webinars/:id/join-tokens',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        email: z.string().email(),
        name: z.string().min(1).max(120),
        phone: z.string().max(20).optional(),
        customResponses: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);

    const webinar = await prisma.webinar.findFirst({
      where: { OR: [{ id: req.params.id }, { slug: req.params.id }] },
      select: { id: true, slug: true },
    });
    if (!webinar) {
      fail(res, 'Webinar not found', 404);
      return;
    }

    const token = `jt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

    const row = await prisma.joinToken.create({
      data: {
        webinarId: webinar.id,
        token,
        email: body.email.toLowerCase(),
        name: body.name,
        phone: body.phone ?? null,
        customResponsesJson: JSON.stringify(body.customResponses ?? {}),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });

    ok(
      res,
      {
        token: row.token,
        expiresAt: row.expiresAt.toISOString(),
        maxUses: row.maxUses,
        joinUrl: `/room/${webinar.slug}?jt=${encodeURIComponent(row.token)}`,
      },
      201
    );
  })
);

/* ── helpers ───────────────────────────────────────────────── */

async function computeMetrics(
  webinarId: string,
  startedAt: Date | null,
  endedAt: Date
) {
  const [registrations, messages, questions, pollVotes, quizAnswers, recording] =
    await Promise.all([
      prisma.registration.findMany({
        where: { webinarId },
        select: { createdAt: true, attended: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.chatMessage.count({ where: { webinarId } }),
      prisma.qaQuestion.count({ where: { webinarId } }),
      prisma.pollVote.count({ where: { poll: { webinarId } } }),
      prisma.quizAnswer.count({ where: { quiz: { webinarId } } }),
      prisma.recording.findFirst({
        where: { webinarId, status: 'READY' },
        orderBy: { startedAt: 'desc' },
        select: { timelineJson: true, durationMs: true },
      }),
    ]);

  const durationMinutes = startedAt
    ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000))
    : 0;

  // The attendance curve comes from the recording timeline when there is one —
  // it is the only place join/leave events are stamped with a real offset.
  const timeSeries: { t: number; count: number }[] = [];
  let maxLiveUsers = 0;

  if (recording) {
    const timeline = safeParse<{ t: number; type: string }[]>(recording.timelineJson, []);
    let live = 0;
    for (const event of timeline) {
      if (event.type === 'join') live++;
      else if (event.type === 'leave') live = Math.max(0, live - 1);
      maxLiveUsers = Math.max(maxLiveUsers, live);
      timeSeries.push({ t: event.t, count: live });
    }
  }

  // Without a recording, the best available proxy is the registration count.
  if (maxLiveUsers === 0) {
    maxLiveUsers = registrations.filter((r) => r.attended).length;
  }

  return {
    totalUsers: registrations.length,
    maxLiveUsers,
    durationMinutes,
    timeSeries,
    engagement: {
      chatMessages: messages,
      questions,
      pollVotes,
      quizAnswers,
    },
    computedAt: new Date().toISOString(),
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
