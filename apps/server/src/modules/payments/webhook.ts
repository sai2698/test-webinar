import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { verifyWebhook } from './razorpay.service.js';
import { fulfilPayment } from './routes.js';
import { logger } from '../../utils/logger.js';

export const webhookRouter = Router();

/**
 * POST /api/payments/webhook
 *
 * Mounted with `express.raw({ type: 'application/json' })` so the signature can
 * be computed over the exact bytes Razorpay sent.
 *
 * This is the source of truth: if the user closes the tab before the client
 * calls /verify, the webhook still fulfils the order.
 */
webhookRouter.post('/', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body as Buffer;

  if (typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: 'Invalid webhook request' });
    return;
  }

  if (!verifyWebhook(rawBody, signature)) {
    logger.warn('Webhook signature mismatch');
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  let event: {
    event?: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string } } };
  };

  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'Malformed JSON' });
    return;
  }

  const entity = event.payload?.payment?.entity;
  const orderId = entity?.order_id;
  const paymentId = entity?.id;

  if (event.event === 'payment.captured' && orderId && paymentId) {
    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId: orderId },
    });

    if (payment) {
      await fulfilPayment(payment.id, paymentId);
    } else {
      logger.warn(`Webhook for unknown order ${orderId}`);
    }
  }

  // Always 200 so Razorpay stops retrying.
  res.json({ received: true });
});
