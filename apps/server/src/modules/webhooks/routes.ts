import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { WEBHOOK_EVENTS } from '@webinar/shared';
import type { WebhookEvent } from '@webinar/shared';
import { newSecret, runDueDeliveries } from './service.js';

export const adminWebhookRouter = Router();

adminWebhookRouter.use(requireAuth, requireRole('ADMIN', 'HOST'));

const endpointSchema = z.object({
  url: z.string().url().max(2000),
  /**
   * `'*'` subscribes to every event. The dispatcher has always honoured it —
   * `emitWebhook` matches on `'*'` or the exact event — but the schema used to
   * reject it, so the wildcard was unreachable and a host had to tick fourteen
   * boxes and re-tick them whenever a new event shipped.
   */
  events: z
    .array(z.union([z.enum(WEBHOOK_EVENTS as [string, ...string[]]), z.literal('*')]))
    .min(1),
  active: z.boolean().default(true),
});

/** GET /api/admin/webhooks */
adminWebhookRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await prisma.webhookEndpoint.findMany({
      where: { ownerId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { deliveries: true } },
      },
    });

    res.json({
      endpoints: rows.map((e) => ({
        id: e.id,
        url: e.url,
        events: safeParse(e.eventsJson),
        active: e.active,
        createdAt: e.createdAt.toISOString(),
        deliveryCount: e._count.deliveries,
      })),
    });
  })
);

/**
 * POST /api/admin/webhooks
 *
 * The signing secret is returned exactly once, here. It is not stored in
 * plaintext anywhere else and no read endpoint returns it — a leaked secret
 * would let anyone forge a delivery.
 */
adminWebhookRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = endpointSchema.parse(req.body);

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        ownerId: req.user!.id,
        url: body.url,
        eventsJson: JSON.stringify(body.events),
        secret: newSecret(),
        active: body.active,
      },
    });

    res.status(201).json({
      endpoint: {
        id: endpoint.id,
        url: endpoint.url,
        events: body.events,
        active: endpoint.active,
        createdAt: endpoint.createdAt.toISOString(),
      },
      /** Shown once. Store it now — it cannot be retrieved again. */
      secret: endpoint.secret,
    });
  })
);

/** PATCH /api/admin/webhooks/:id */
adminWebhookRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = endpointSchema.partial().parse(req.body);

    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id: req.params.id, ownerId: req.user!.id },
    });
    if (!existing) throw notFound('Endpoint not found');

    const endpoint = await prisma.webhookEndpoint.update({
      where: { id: existing.id },
      data: {
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.events !== undefined ? { eventsJson: JSON.stringify(body.events) } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
    });

    res.json({
      endpoint: {
        id: endpoint.id,
        url: endpoint.url,
        events: safeParse(endpoint.eventsJson),
        active: endpoint.active,
        createdAt: endpoint.createdAt.toISOString(),
      },
    });
  })
);

/** DELETE /api/admin/webhooks/:id */
adminWebhookRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id: req.params.id, ownerId: req.user!.id },
    });
    if (!existing) throw notFound('Endpoint not found');
    await prisma.webhookEndpoint.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  })
);

/** GET /api/admin/webhooks/:id/deliveries — the delivery log. */
adminWebhookRouter.get(
  '/:id/deliveries',
  asyncHandler(async (req, res) => {
    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id: req.params.id, ownerId: req.user!.id },
    });
    if (!existing) throw notFound('Endpoint not found');

    const rows = await prisma.webhookDelivery.findMany({
      where: { endpointId: existing.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.json({
      deliveries: rows.map((d) => ({
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,
        lastStatus: d.lastStatus,
        deliveredAt: d.deliveredAt?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
      })),
    });
  })
);

/**
 * POST /api/admin/webhooks/:id/test
 *
 * Sends a synthetic `webinar.updated` event so a host can confirm their
 * endpoint is reachable before relying on it. Runs the dispatcher immediately
 * rather than waiting for the next tick.
 */
adminWebhookRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id: req.params.id, ownerId: req.user!.id },
    });
    if (!existing) throw notFound('Endpoint not found');

    await prisma.webhookDelivery.create({
      data: {
        endpointId: existing.id,
        event: 'webinar.updated',
        payloadJson: JSON.stringify({
          event: 'webinar.updated',
          timestamp: new Date().toISOString(),
          data: { test: true, message: 'This is a test delivery from NexaLive' },
        }),
        nextAttemptAt: new Date(),
      },
    });

    const result = await runDueDeliveries();
    res.json({ ok: true, ...result });
  })
);

/** POST /api/admin/webhooks/:id/rotate — issue a new signing secret. */
adminWebhookRouter.post(
  '/:id/rotate',
  asyncHandler(async (req, res) => {
    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id: req.params.id, ownerId: req.user!.id },
    });
    if (!existing) throw notFound('Endpoint not found');

    const secret = newSecret();
    await prisma.webhookEndpoint.update({
      where: { id: existing.id },
      data: { secret },
    });

    res.json({ secret });
  })
);

/** GET /api/admin/webhooks/events — the catalogue, for the UI's checkboxes. */
adminWebhookRouter.get('/events', (_req, res) => {
  res.json({ events: WEBHOOK_EVENTS });
});

function safeParse(json: string): WebhookEvent[] {
  try {
    return JSON.parse(json) as WebhookEvent[];
  } catch {
    return [];
  }
}

/** Re-exported so other modules can queue an event without importing service. */
export { emitWebhook } from './service.js';
