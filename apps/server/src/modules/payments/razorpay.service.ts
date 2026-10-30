import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { env, razorpayEnabled } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

let client: Razorpay | null = null;

function getClient(): Razorpay {
  if (!razorpayEnabled) throw new Error('Razorpay is not configured');
  if (!client) {
    client = new Razorpay({
      key_id: env.RZP_KEY_ID,
      key_secret: env.RZP_KEY_SECRET,
    });
  }
  return client;
}

export interface CreatedOrder {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  mock?: boolean;
}

/**
 * Creates a Razorpay order. In development without keys this returns a
 * deterministic mock order so the whole flow can be exercised locally.
 */
export async function createOrder(
  amountPaise: number,
  receipt: string
): Promise<CreatedOrder> {
  if (!razorpayEnabled) {
    logger.warn('Razorpay not configured — issuing mock order');
    return {
      id: `order_mock_${crypto.randomBytes(8).toString('hex')}`,
      amount: amountPaise,
      currency: 'INR',
      receipt,
      mock: true,
    };
  }

  const order = await getClient().orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt,
    payment_capture: true,
  });

  return {
    id: order.id,
    amount: Number(order.amount),
    currency: order.currency,
    receipt: order.receipt ?? undefined,
  };
}

/** Verifies the checkout signature returned to the browser. */
export function verifySignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  if (!razorpayEnabled) {
    // Mock mode: accept the synthetic signature produced by the client helper.
    return signature === `mock_${orderId}`;
  }

  const expected = crypto
    .createHmac('sha256', env.RZP_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Verifies the `X-Razorpay-Signature` header against the raw request body. */
export function verifyWebhook(rawBody: Buffer, signature: string): boolean {
  if (!env.RZP_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', env.RZP_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Issues a refund for a captured payment.
 *
 * A full refund is the default; a partial refund is allowed by passing an
 * amount. In mock mode there is nothing to call, so the refund is simulated —
 * the caller still gets a refund id so the database stays consistent with
 * what a real deployment would record.
 */
export async function refundPayment(
  razorpayPaymentId: string,
  amountPaise?: number
): Promise<{ id: string; amount: number; mock?: boolean }> {
  if (!razorpayEnabled) {
    logger.warn('Razorpay not configured — simulating refund');
    return {
      id: `rfnd_mock_${crypto.randomBytes(8).toString('hex')}`,
      amount: amountPaise ?? 0,
      mock: true,
    };
  }

  const refund = await getClient().payments.refund(razorpayPaymentId, {
    ...(amountPaise ? { amount: amountPaise } : {}),
    speed: 'normal',
  });

  return { id: refund.id, amount: Number(refund.amount) };
}

export { razorpayEnabled };
