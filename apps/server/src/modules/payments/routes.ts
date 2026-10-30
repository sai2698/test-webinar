import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { orderSchema, verifySchema } from '../webinars/schema.js';
import {
  createOrder,
  verifySignature,
  razorpayEnabled,
  refundPayment,
} from './razorpay.service.js';
import { bus } from '../../utils/bus.js';
import { logger } from '../../utils/logger.js';
import { markPurchased } from '../quizzes/cta.service.js';
import { sendMail, registrationEmail, enrollmentEmail } from '../../utils/mail.js';
import { env } from '../../config/env.js';

export const paymentRouter = Router();

paymentRouter.use(requireAuth);

/**
 * POST /api/payments/order
 * Price always comes from the database — never from the client.
 */
paymentRouter.post(
  '/order',
  asyncHandler(async (req, res) => {
    const body = orderSchema.parse(req.body);
    const userId = req.user!.id;

    let amountPaise = 0;
    let webinarId: string | null = null;
    let ctaId: string | null = null;
    let courseId: string | null = null;
    let receipt = '';

    if (body.webinarId) {
      const webinar = await prisma.webinar.findUnique({ where: { id: body.webinarId } });
      if (!webinar) throw notFound('Webinar not found');
      if (!webinar.requirePayment || webinar.priceInPaise <= 0) {
        throw badRequest('This webinar does not require payment');
      }
      amountPaise = webinar.priceInPaise;
      webinarId = webinar.id;
      receipt = `webinar_${webinar.id.slice(0, 12)}`;
    } else if (body.ctaId) {
      const cta = await prisma.cta.findUnique({
        where: { id: body.ctaId },
        include: { course: true, webinar: true },
      });
      if (!cta) throw notFound('Offer not found');

      const price = cta.priceOverridePaise ?? cta.course?.pricePaise ?? 0;
      if (price <= 0) throw badRequest('This offer has no price configured');

      amountPaise = price;
      ctaId = cta.id;
      courseId = cta.courseId;
      webinarId = cta.webinarId;
      receipt = `cta_${cta.id.slice(0, 12)}`;
    }

    const order = await createOrder(amountPaise, receipt);

    const payment = await prisma.payment.create({
      data: {
        userId,
        webinarId,
        ctaId,
        courseId,
        razorpayOrderId: order.id,
        amountPaise,
        status: 'CREATED',
      },
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      paymentId: payment.id,
      keyId: razorpayEnabled ? process.env.RZP_KEY_ID : null,
      mock: Boolean(order.mock),
    });
  })
);

/**
 * POST /api/payments/verify
 * Verifies the checkout signature and fulfils the purchase.
 */
paymentRouter.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const body = verifySchema.parse(req.body);

    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId: body.razorpayOrderId },
    });
    if (!payment) throw notFound('Order not found');
    if (payment.userId !== req.user!.id) throw badRequest('Order does not belong to you');

    // Idempotent: already fulfilled.
    if (payment.status === 'PAID') {
      res.json({ ok: true, alreadyProcessed: true });
      return;
    }

    const valid = verifySignature(
      body.razorpayOrderId,
      body.razorpayPaymentId,
      body.razorpaySignature
    );
    if (!valid) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED' },
      });
      throw badRequest('Payment signature verification failed');
    }

    await fulfilPayment(payment.id, body.razorpayPaymentId, body.razorpaySignature);
    res.json({ ok: true });
  })
);

/**
 * Shared fulfilment used by both /verify and the webhook.
 * Safe to call twice — guarded by the PAID status check.
 */
export async function fulfilPayment(
  paymentRowId: string,
  razorpayPaymentId: string,
  signature?: string
) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentRowId } });
  if (!payment || payment.status === 'PAID') return;

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: 'PAID',
      razorpayPaymentId,
      razorpaySignature: signature ?? null,
    },
  });

  // Webinar registration → mark paid
  if (payment.webinarId && !payment.ctaId) {
    await prisma.registration.updateMany({
      where: { webinarId: payment.webinarId, userId: payment.userId },
      data: { paid: true },
    });
    bus.emitEvent('registration:paid', {
      webinarId: payment.webinarId,
      userId: payment.userId,
    });

    // The confirmation was withheld at registration time because the seat was
    // not secured yet. Now it is.
    const [webinar, user, registration] = await Promise.all([
      prisma.webinar.findUnique({ where: { id: payment.webinarId } }),
      prisma.user.findUnique({ where: { id: payment.userId } }),
      prisma.registration.findUnique({
        where: {
          webinarId_userId: { webinarId: payment.webinarId, userId: payment.userId },
        },
      }),
    ]);

    if (webinar && user && registration) {
      const message = registrationEmail({
        name: user.name,
        webinarTitle: webinar.title,
        startsAt: webinar.startsAt,
        timezone: webinar.timezone,
        joinUrl: `${env.WEB_ORIGIN}/room/${webinar.slug}?token=${encodeURIComponent(registration.joinToken)}`,
      });
      void sendMail({ to: user.email, ...message });
    }
  }

  // Course enrollment (CTA purchase)
  if (payment.courseId) {
    const course = await prisma.course.findUnique({ where: { id: payment.courseId } });
    await prisma.enrollment.upsert({
      where: {
        userId_courseId: { userId: payment.userId, courseId: payment.courseId },
      },
      create: {
        userId: payment.userId,
        courseId: payment.courseId,
        webinarId: payment.webinarId,
        paymentId: payment.id,
      },
      update: { paymentId: payment.id },
    });

    const buyer = await prisma.user.findUnique({ where: { id: payment.userId } });
    if (buyer && course) {
      const message = enrollmentEmail({
        name: buyer.name,
        courseTitle: course.title,
        amountPaise: payment.amountPaise,
        currency: course.currency,
      });
      void sendMail({ to: buyer.email, ...message });
    }
  }

  /**
   * Announce the purchase in the room.
   *
   * Gated on the *purchase*, not on the course. A CTA is allowed to be a
   * price-only offer with no course attached — the ordinary shape for a
   * one-off workshop — and keying this off `courseId` meant those buyers paid
   * and were never announced: no chat line, no stage banner, and no `enrolled`
   * badge either, because `markEnrolled` rides the same event. The buyer saw a
   * "you're in" card while the room saw nothing at all.
   *
   * The title falls back to the offer's own name, which is what the room was
   * looking at when they clicked it.
   */
  if (payment.courseId || payment.ctaId) {
    const [course, cta] = await Promise.all([
      payment.courseId
        ? prisma.course.findUnique({ where: { id: payment.courseId } })
        : Promise.resolve(null),
      payment.ctaId ? prisma.cta.findUnique({ where: { id: payment.ctaId } }) : Promise.resolve(null),
    ]);

    bus.emitEvent('enrollment:created', {
      webinarId: payment.webinarId,
      userId: payment.userId,
      courseTitle: course?.title ?? cta?.title ?? 'the course',
    });
  }

  // A CTA purchase converts the click that led to it. The click row already
  // exists (the card records one before checkout), so this only stamps it —
  // and it is a no-op for a buyer who never clicked, which is correct: the
  // host's click count is an interest signal, not a sales ledger.
  if (payment.ctaId) {
    await markPurchased(payment.ctaId, payment.userId);
  }

  logger.info(`Payment fulfilled: ${payment.id} (${payment.amountPaise} paise)`);
}

/* ── Admin: refunds ────────────────────────────────────────── */

export const adminPaymentRouter = Router();

adminPaymentRouter.use(requireAuth, requireRole('ADMIN'));

/**
 * GET /api/admin/payments?webinarId=...
 *
 * The refund screen needs to see what was actually collected before it can
 * refund anything, so this lists payments with the buyer attached.
 */
adminPaymentRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const webinarId = req.query.webinarId ? String(req.query.webinarId) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;

    const payments = await prisma.payment.findMany({
      where: {
        ...(webinarId ? { webinarId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        user: { select: { id: true, name: true, email: true } },
        webinar: { select: { id: true, title: true, slug: true } },
      },
    });

    res.json({
      payments: payments.map((p) => ({
        id: p.id,
        amountPaise: p.amountPaise,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
        razorpayOrderId: p.razorpayOrderId,
        razorpayPaymentId: p.razorpayPaymentId,
        user: p.user,
        webinar: p.webinar,
        kind: p.courseId ? 'course' : 'webinar',
      })),
    });
  })
);

/**
 * POST /api/admin/payments/:id/refund
 *
 * Refunds a captured payment and reverses what it granted. The reversal is
 * deliberately conservative: a refunded webinar seat loses `paid`, and a
 * refunded course purchase loses its Enrollment. Neither is deleted, because
 * the audit trail matters more than a tidy table.
 */
adminPaymentRouter.post(
  '/:id/refund',
  asyncHandler(async (req, res) => {
    const amountPaise = req.body?.amountPaise ? Number(req.body.amountPaise) : undefined;

    const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!payment) throw notFound('Payment not found');
    if (payment.status !== 'PAID') {
      throw badRequest(`Only a paid payment can be refunded (this one is ${payment.status})`);
    }
    if (!payment.razorpayPaymentId) {
      throw badRequest('This payment has no Razorpay payment id to refund');
    }
    if (amountPaise !== undefined && (amountPaise <= 0 || amountPaise > payment.amountPaise)) {
      throw badRequest('Refund amount must be between 1 and the original amount');
    }

    // Resolve the amount up front so the mock transport reports the same
    // figure a real refund would. Without this a full refund reports ₹0.
    const refundAmount = amountPaise ?? payment.amountPaise;

    const refund = await refundPayment(payment.razorpayPaymentId, refundAmount);

    // A partial refund leaves the purchase intact — the buyer still has what
    // they paid for, they just paid less. Only a full refund reverses access.
    const isFullRefund = refundAmount >= payment.amountPaise;

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: isFullRefund ? 'REFUNDED' : 'PAID' },
    });

    if (isFullRefund) {
      if (payment.webinarId && !payment.ctaId) {
        await prisma.registration.updateMany({
          where: { webinarId: payment.webinarId, userId: payment.userId },
          data: { paid: false },
        });
      }
      if (payment.courseId) {
        await prisma.enrollment
          .deleteMany({
            where: { userId: payment.userId, courseId: payment.courseId },
          })
          .catch(() => undefined);
      }
    }

    logger.info(
      `Refund ${refund.id} for payment ${payment.id}: ${refund.amount} paise (full=${isFullRefund})`
    );

    res.json({
      ok: true,
      refundId: refund.id,
      amountPaise: refundAmount,
      full: isFullRefund,
      mock: Boolean(refund.mock),
    });
  })
);
