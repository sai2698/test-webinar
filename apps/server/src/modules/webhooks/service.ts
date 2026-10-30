import { createHmac, randomBytes } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { createLogger } from '../../utils/logger.js';
import type { WebhookEvent, WebhookPayload } from '@webinar/shared';

const log = createLogger('webhooks');

/** How many times a delivery is retried before it is marked FAILED. */
const MAX_ATTEMPTS = 5;

/**
 * Backoff between attempts, in milliseconds.
 *
 * A receiver that is down for a minute should not be hammered, and a receiver
 * that is down for an hour should not be retried forever. Five attempts over
 * roughly 15 minutes covers a deploy or a restart without leaving a queue that
 * grows without bound.
 */
const BACKOFF_MS = [0, 30_000, 120_000, 300_000, 900_000];

/** A delivery must not hang a worker forever. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Queue an event for every endpoint that subscribes to it.
 *
 * This is deliberately fire-and-forget: a socket handler that starts a webinar
 * must not wait on a customer's HTTP endpoint. The row is written synchronously
 * so the event is durable even if the process dies a millisecond later, and the
 * actual POST happens on the delivery loop.
 */
export async function emitWebhook(
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { active: true },
    });

    const interested = endpoints.filter((e) => {
      let events: string[] = [];
      try {
        events = JSON.parse(e.eventsJson) as string[];
      } catch {
        return false;
      }
      return events.includes('*') || events.includes(event);
    });

    if (interested.length === 0) return;

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    await prisma.webhookDelivery.createMany({
      data: interested.map((e) => ({
        endpointId: e.id,
        event,
        payloadJson: JSON.stringify(payload),
        nextAttemptAt: new Date(),
      })),
    });
  } catch (err) {
    // A webhook failure must never surface to the caller — the action that
    // triggered it already succeeded.
    log.error(`Failed to queue ${event}`, err);
  }
}

/** HMAC-SHA256 over the raw body, so a receiver can prove the call is ours. */
export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** A fresh signing secret. 32 bytes of entropy, hex-encoded. */
export function newSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Attempt every delivery that is due.
 *
 * Called on a timer. Each delivery is independent: one dead endpoint must not
 * stop the others, so failures are caught per row rather than around the loop.
 */
export async function runDueDeliveries(): Promise<{ sent: number; failed: number }> {
  const due = await prisma.webhookDelivery.findMany({
    where: {
      status: 'PENDING',
      nextAttemptAt: { lte: new Date() },
    },
    include: { endpoint: true },
    take: 50,
    orderBy: { nextAttemptAt: 'asc' },
  });

  let sent = 0;
  let failed = 0;

  for (const delivery of due) {
    if (!delivery.endpoint.active) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', lastError: 'Endpoint disabled' },
      });
      failed++;
      continue;
    }

    const attempts = delivery.attempts + 1;
    const signature = signPayload(delivery.endpoint.secret, delivery.payloadJson);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webinar-Event': delivery.event,
          'X-Webinar-Signature': signature,
          'X-Webinar-Delivery': delivery.id,
          'User-Agent': 'NexaLive-Webhooks/1.0',
        },
        body: delivery.payloadJson,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.ok) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'DELIVERED',
            attempts,
            lastStatus: res.status,
            deliveredAt: new Date(),
            lastError: null,
          },
        });
        sent++;
        continue;
      }

      // A 4xx other than 429 means the receiver will never accept this payload
      // — retrying is pointless and only fills the log.
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: permanent || attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
          attempts,
          lastStatus: res.status,
          lastError: `HTTP ${res.status}`,
          nextAttemptAt: new Date(Date.now() + (BACKOFF_MS[attempts] ?? 900_000)),
        },
      });
      failed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
          attempts,
          lastError: message.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + (BACKOFF_MS[attempts] ?? 900_000)),
        },
      });
      failed++;
    }
  }

  return { sent, failed };
}

let timer: NodeJS.Timeout | null = null;

/** Start the delivery loop. Idempotent — a second call is a no-op. */
export function startWebhookDispatcher(intervalMs = 15_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void runDueDeliveries().catch((err) => log.error('Delivery loop failed', err));
  }, intervalMs);
  // Do not hold the process open just for webhooks.
  timer.unref?.();
  log.info(`Webhook dispatcher started (every ${intervalMs}ms)`);
}

export function stopWebhookDispatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
