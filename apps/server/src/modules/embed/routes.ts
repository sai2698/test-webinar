import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import type { EmbedConfig } from '@webinar/shared';

export const adminEmbedRouter = Router();

adminEmbedRouter.use(requireAuth, requireRole('ADMIN', 'HOST'));

const embedSchema = z.object({
  enabled: z.boolean(),
  /**
   * Exact origins, e.g. `https://example.com`. A wildcard is deliberately not
   * supported: `*` in an embed allow-list is the same as no allow-list, and
   * the whole point of the list is to stop a random page framing the room.
   */
  allowedOrigins: z
    .array(
      z
        .string()
        .url()
        .refine((u) => !u.includes('*'), 'Wildcards are not allowed in embed origins')
    )
    .max(20)
    .default([]),
});

function serialize(row: {
  embedEnabled: boolean;
  embedAllowedOriginsJson: string;
}): EmbedConfig {
  let allowedOrigins: string[] = [];
  try {
    const parsed = JSON.parse(row.embedAllowedOriginsJson) as unknown;
    if (Array.isArray(parsed)) allowedOrigins = parsed.filter((o) => typeof o === 'string');
  } catch {
    allowedOrigins = [];
  }

  return { enabled: row.embedEnabled, allowedOrigins };
}

/** GET /api/admin/:webinarId/embed */
adminEmbedRouter.get(
  '/:webinarId/embed',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { embedEnabled: true, embedAllowedOriginsJson: true, slug: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    res.json({
      embed: serialize(webinar),
      /** Ready-made snippet the host can paste into their own page. */
      snippet: `<iframe src="${process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000'}/embed/${webinar.slug}" width="100%" height="100%" frameborder="0" allow="camera; microphone; fullscreen; autoplay" allowfullscreen></iframe>`,
    });
  })
);

/** PATCH /api/admin/:webinarId/embed */
adminEmbedRouter.patch(
  '/:webinarId/embed',
  asyncHandler(async (req, res) => {
    const body = embedSchema.parse(req.body);

    const webinar = await prisma.webinar.update({
      where: { id: req.params.webinarId },
      data: {
        embedEnabled: body.enabled,
        embedAllowedOriginsJson: JSON.stringify(body.allowedOrigins),
      },
      select: { embedEnabled: true, embedAllowedOriginsJson: true },
    });

    res.json({ embed: serialize(webinar) });
  })
);

/**
 * GET /api/webinars/:slug/embed-policy
 *
 * Public and unauthenticated: the embed page itself has to ask whether it is
 * allowed to be framed, and it cannot present a token to do so. It returns only
 * the allow-list, never anything about the webinar.
 */
export const publicEmbedRouter = Router();

publicEmbedRouter.get(
  '/:slug/embed-policy',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.findUnique({
      where: { slug: req.params.slug },
      select: { embedEnabled: true, embedAllowedOriginsJson: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    res.json({ embed: serialize(webinar) });
  })
);
