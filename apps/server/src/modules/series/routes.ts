import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { createSeriesSchema, generateOccurrences, updateSeriesSchema } from './schema.js';
import { reserveSlug } from '../webinars/service.js';
import type { SeriesFrequency, WebinarSeries } from '@webinar/shared';

export const adminSeriesRouter = Router();

adminSeriesRouter.use(requireAuth, requireRole('ADMIN', 'HOST'));

function serialize(row: {
  id: string;
  baseWebinarId: string;
  frequency: string;
  interval: number;
  byWeekdayJson: string;
  byMonthday: number | null;
  count: number | null;
  until: Date | null;
  timezone: string;
  cancelledAt: Date | null;
  createdAt: Date;
}): WebinarSeries {
  let byWeekday: number[] = [];
  try {
    byWeekday = JSON.parse(row.byWeekdayJson) as number[];
  } catch {
    byWeekday = [];
  }

  return {
    id: row.id,
    baseWebinarId: row.baseWebinarId,
    frequency: row.frequency as SeriesFrequency,
    interval: row.interval,
    byWeekday,
    byMonthday: row.byMonthday,
    count: row.count,
    until: row.until?.toISOString() ?? null,
    timezone: row.timezone,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * POST /api/admin/:webinarId/series/preview
 *
 * Shows the dates a rule would produce without creating anything. A host
 * setting up "every second Tuesday" needs to see that it lands on the dates
 * they expect before committing to 20 webinars.
 */
adminSeriesRouter.post(
  '/:webinarId/series/preview',
  asyncHandler(async (req, res) => {
    const body = createSeriesSchema.parse(req.body);

    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { startsAt: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    const dates = generateOccurrences(webinar.startsAt, {
      frequency: body.frequency as SeriesFrequency,
      interval: body.interval,
      byWeekday: body.byWeekday,
      byMonthday: body.byMonthday ?? null,
      count: body.count ?? null,
      until: body.until ?? null,
    });

    res.json({
      occurrences: dates.map((d) => d.toISOString()),
      total: dates.length,
    });
  })
);

/**
 * POST /api/admin/:webinarId/series
 *
 * Turns a webinar into the first occurrence of a series and creates the rest.
 *
 * Each occurrence is a full Webinar row — a copy of the base webinar's settings,
 * with its own slug and start time. Copying rather than referencing means every
 * other feature (registration, chat, recording, analytics) works on an
 * occurrence with no special cases.
 */
adminSeriesRouter.post(
  '/:webinarId/series',
  asyncHandler(async (req, res) => {
    const body = createSeriesSchema.parse(req.body);
    const webinarId = req.params.webinarId;

    const base = await prisma.webinar.findUnique({
      where: { id: webinarId },
      include: { moderators: true },
    });
    if (!base) throw notFound('Webinar not found');

    if (base.seriesId) throw badRequest('This webinar is already part of a series');

    const dates = generateOccurrences(base.startsAt, {
      frequency: body.frequency as SeriesFrequency,
      interval: body.interval,
      byWeekday: body.byWeekday,
      byMonthday: body.byMonthday ?? null,
      count: body.count ?? null,
      until: body.until ?? null,
    });

    if (dates.length === 0) throw badRequest('That rule produces no occurrences');

    const series = await prisma.webinarSeries.create({
      data: {
        baseWebinarId: webinarId,
        frequency: body.frequency,
        interval: body.interval,
        byWeekdayJson: JSON.stringify(body.byWeekday),
        byMonthday: body.byMonthday ?? null,
        count: body.count ?? null,
        until: body.until ?? null,
        timezone: body.timezone,
      },
    });

    // The base webinar becomes occurrence 0.
    await prisma.webinar.update({
      where: { id: webinarId },
      data: { seriesId: series.id, occurrenceIndex: 0 },
    });

    // Occurrence 0 is the base itself, so skip it.
    for (let i = 1; i < dates.length; i++) {
      const slug = await reserveSlug(`${base.slug}-${i + 1}`);

      const created = await prisma.webinar.create({
        data: {
          slug,
          title: base.title,
          description: base.description,
          bannerUrl: base.bannerUrl,
          startsAt: dates[i],
          durationMins: base.durationMins,
          timezone: base.timezone,
          status: 'SCHEDULED',
          allowMic: base.allowMic,
          allowVideo: base.allowVideo,
          requireRegistration: base.requireRegistration,
          requirePayment: base.requirePayment,
          priceInPaise: base.priceInPaise,
          currency: base.currency,
          chatEnabled: base.chatEnabled,
          handRaiseEnabled: base.handRaiseEnabled,
          maxParticipants: base.maxParticipants,
          passcode: base.passcode,
          inviteOnly: base.inviteOnly,
          requireSignIn: base.requireSignIn,
          requireApproval: base.requireApproval,
          showPeopleTab: base.showPeopleTab,
          showQaTab: base.showQaTab,
          showPollsTab: base.showPollsTab,
          showParticipantsToEachOther: base.showParticipantsToEachOther,
          watermarkEnabled: base.watermarkEnabled,
          showLiveUsersCount: base.showLiveUsersCount,
          cohostStartWithoutHost: base.cohostStartWithoutHost,
          cohostPermissionsJson: base.cohostPermissionsJson,
          hostId: base.hostId,
          createdById: base.createdById,
          seriesId: series.id,
          occurrenceIndex: i,
          moderators: {
            create: base.moderators.map((m) => ({ userId: m.userId })),
          },
        },
      });

      // Custom fields are copied so every occurrence asks the same questions.
      const fields = await prisma.customField.findMany({
        where: { webinarId, deletedAt: null },
        include: { options: { where: { deletedAt: null }, orderBy: { order: 'asc' } } },
      });

      for (const f of fields) {
        await prisma.customField.create({
          data: {
            webinarId: created.id,
            label: f.label,
            type: f.type,
            isRequired: f.isRequired,
            placeholder: f.placeholder,
            defaultValueJson: f.defaultValueJson,
            order: f.order,
            options: {
              create: f.options.map((o, i2) => ({
                label: o.label,
                value: o.value,
                order: i2,
              })),
            },
          },
        });
      }
    }

    res.status(201).json({
      series: serialize(series),
      occurrenceCount: dates.length,
    });
  })
);

/** GET /api/admin/:webinarId/series */
adminSeriesRouter.get(
  '/:webinarId/series',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { seriesId: true },
    });
    if (!webinar) throw notFound('Webinar not found');
    if (!webinar.seriesId) {
      res.json({ series: null, occurrences: [] });
      return;
    }

    const series = await prisma.webinarSeries.findUnique({
      where: { id: webinar.seriesId },
    });
    if (!series) {
      res.json({ series: null, occurrences: [] });
      return;
    }

    const occurrences = await prisma.webinar.findMany({
      where: { seriesId: series.id },
      orderBy: { occurrenceIndex: 'asc' },
      select: {
        id: true,
        slug: true,
        title: true,
        startsAt: true,
        status: true,
        occurrenceIndex: true,
      },
    });

    res.json({
      series: serialize(series),
      occurrences: occurrences.map((o) => ({
        id: o.id,
        slug: o.slug,
        title: o.title,
        startsAt: o.startsAt.toISOString(),
        status: o.status,
        occurrenceIndex: o.occurrenceIndex,
      })),
    });
  })
);

/** PATCH /api/admin/series/:id */
adminSeriesRouter.patch(
  '/series/:id',
  asyncHandler(async (req, res) => {
    const body = updateSeriesSchema.parse(req.body);

    const series = await prisma.webinarSeries.update({
      where: { id: req.params.id },
      data: {
        ...(body.frequency !== undefined ? { frequency: body.frequency } : {}),
        ...(body.interval !== undefined ? { interval: body.interval } : {}),
        ...(body.byWeekday !== undefined
          ? { byWeekdayJson: JSON.stringify(body.byWeekday) }
          : {}),
        ...(body.byMonthday !== undefined ? { byMonthday: body.byMonthday } : {}),
        ...(body.count !== undefined ? { count: body.count } : {}),
        ...(body.until !== undefined ? { until: body.until } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      },
    });

    res.json({ series: serialize(series) });
  })
);

/**
 * DELETE /api/admin/series/:id
 *
 * Cancels the whole series. Occurrences that have not started are cancelled;
 * ones that already ran are left alone, because deleting a finished webinar
 * would take its recording and attendance record with it.
 */
adminSeriesRouter.delete(
  '/series/:id',
  asyncHandler(async (req, res) => {
    const series = await prisma.webinarSeries.findUnique({
      where: { id: req.params.id },
    });
    if (!series) throw notFound('Series not found');

    await prisma.webinarSeries.update({
      where: { id: series.id },
      data: { cancelledAt: new Date() },
    });

    const cancelled = await prisma.webinar.updateMany({
      where: {
        seriesId: series.id,
        status: { in: ['DRAFT', 'SCHEDULED'] },
      },
      data: { status: 'ENDED' },
    });

    res.json({ ok: true, cancelledOccurrences: cancelled.count });
  })
);

/**
 * DELETE /api/admin/:webinarId/series/occurrence
 *
 * Removes one occurrence from its series without touching the others. The
 * webinar itself is kept — it becomes a standalone event — because a host
 * cancelling "this week's session" usually still wants the record.
 */
adminSeriesRouter.delete(
  '/:webinarId/series/occurrence',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { seriesId: true, status: true },
    });
    if (!webinar) throw notFound('Webinar not found');
    if (!webinar.seriesId) throw badRequest('This webinar is not part of a series');

    await prisma.webinar.update({
      where: { id: req.params.webinarId },
      data: { seriesId: null, occurrenceIndex: null },
    });

    res.json({ ok: true });
  })
);
