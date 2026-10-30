import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import type { AnalyticsConfig } from '@webinar/shared';

export const adminAnalyticsRouter = Router();

adminAnalyticsRouter.use(requireAuth, requireRole('ADMIN', 'HOST'));

/**
 * Each id is validated against its real format. A typo in a GA4 id fails
 * silently in the browser — the tag loads, collects nothing, and the host
 * concludes the feature is broken. Rejecting it at save time is the only place
 * the mistake is visible.
 */
const analyticsSchema = z.object({
  ga4MeasurementId: z
    .string()
    .regex(/^G-[A-Z0-9]{6,12}$/, 'GA4 ids look like G-XXXXXXXXXX')
    .nullable()
    .default(null),
  metaPixelId: z
    .string()
    .regex(/^\d{10,20}$/, 'A Meta Pixel id is numeric')
    .nullable()
    .default(null),
  clarityProjectId: z
    .string()
    .regex(/^[a-z0-9]{8,16}$/, 'A Clarity project id is 8–16 lowercase characters')
    .nullable()
    .default(null),
  gtmContainerId: z
    .string()
    .regex(/^GTM-[A-Z0-9]{5,10}$/, 'GTM ids look like GTM-XXXXXXX')
    .nullable()
    .default(null),
});

function serialize(json: string): AnalyticsConfig {
  const empty: AnalyticsConfig = {
    ga4MeasurementId: null,
    metaPixelId: null,
    clarityProjectId: null,
    gtmContainerId: null,
  };

  try {
    const parsed = JSON.parse(json) as Partial<AnalyticsConfig>;
    return {
      ga4MeasurementId: parsed.ga4MeasurementId ?? null,
      metaPixelId: parsed.metaPixelId ?? null,
      clarityProjectId: parsed.clarityProjectId ?? null,
      gtmContainerId: parsed.gtmContainerId ?? null,
    };
  } catch {
    return empty;
  }
}

/** GET /api/admin/:webinarId/analytics-config */
adminAnalyticsRouter.get(
  '/:webinarId/analytics-config',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { analyticsConfigJson: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    res.json({ config: serialize(webinar.analyticsConfigJson) });
  })
);

/** PATCH /api/admin/:webinarId/analytics-config */
adminAnalyticsRouter.patch(
  '/:webinarId/analytics-config',
  asyncHandler(async (req, res) => {
    const body = analyticsSchema.parse(req.body);

    const webinar = await prisma.webinar.update({
      where: { id: req.params.webinarId },
      data: { analyticsConfigJson: JSON.stringify(body) },
      select: { analyticsConfigJson: true },
    });

    res.json({ config: serialize(webinar.analyticsConfigJson) });
  })
);

/**
 * GET /api/webinars/:slug/analytics-config
 *
 * Public: the room page needs the ids to load the tags, and it has no token.
 * Only the ids are exposed — they are already visible in any page source that
 * loads the tag, so hiding them here would be theatre.
 */
export const publicAnalyticsRouter = Router();

publicAnalyticsRouter.get(
  '/:slug/analytics-config',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findUnique({
      where: { slug: req.params.slug },
      select: { analyticsConfigJson: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    res.json({ config: serialize(webinar.analyticsConfigJson) });
  })
);
