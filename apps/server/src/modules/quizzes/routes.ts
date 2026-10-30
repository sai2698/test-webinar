import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { quizSchema, pollSchema, ctaSchema, updateCtaSchema } from '../webinars/schema.js';
import {
  CTA_INCLUDE,
  countClicks,
  replaceFormFields,
  serializeForm,
} from './cta.service.js';
import type { QuizOption } from '@webinar/shared';

/** A stored JSON blob, or `{}` when the row predates the column. */
function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const adminQuizRouter = Router();

adminQuizRouter.use(requireAuth, requireRole('ADMIN', 'HOST', 'MODERATOR'));

adminQuizRouter.get(
  '/:webinarId/quizzes',
  asyncHandler(async (req, res) => {
    const quizzes = await prisma.quiz.findMany({
      where: { webinarId: req.params.webinarId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { answers: true } } },
    });

    res.json({
      quizzes: quizzes.map((q) => ({
        id: q.id,
        question: q.question,
        options: JSON.parse(q.optionsJson) as QuizOption[],
        correctOptionId: q.correctOptionId,
        timeLimitSecs: q.timeLimitSecs,
        answerCount: q._count.answers,
      })),
    });
  })
);

adminQuizRouter.post(
  '/:webinarId/quizzes',
  asyncHandler(async (req, res) => {
    const body = quizSchema.parse(req.body);
    const quiz = await prisma.quiz.create({
      data: {
        webinarId: req.params.webinarId,
        question: body.question,
        optionsJson: JSON.stringify(body.options),
        correctOptionId: body.correctOptionId ?? null,
        timeLimitSecs: body.timeLimitSecs,
      },
    });
    res.status(201).json({ quiz: { ...quiz, options: body.options } });
  })
);

adminQuizRouter.patch(
  '/quizzes/:id',
  asyncHandler(async (req, res) => {
    const body = quizSchema.parse(req.body);

    const existing = await prisma.quiz.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { answers: true } } },
    });
    if (!existing) throw notFound('Quiz not found');

    // Once people have answered, the option ids are baked into their rows.
    // Rewriting the option list would leave every stored answer pointing at an
    // id that no longer exists, so the results screen would silently lose them.
    // The question and the time limit stay editable — those are safe.
    const optionsChanged =
      JSON.stringify(body.options) !== existing.optionsJson;
    if (optionsChanged && existing._count.answers > 0) {
      throw badRequest(
        'This quiz already has answers, so its options can no longer be changed. Delete it and create a new one.'
      );
    }

    const quiz = await prisma.quiz.update({
      where: { id: existing.id },
      data: {
        question: body.question,
        optionsJson: JSON.stringify(body.options),
        correctOptionId: body.correctOptionId ?? null,
        timeLimitSecs: body.timeLimitSecs,
      },
    });

    res.json({ quiz: { ...quiz, options: body.options } });
  })
);

adminQuizRouter.delete(
  '/quizzes/:id',
  asyncHandler(async (req, res) => {
    await prisma.quiz.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

/* ── Polls ─────────────────────────────────────────────────── */

export const adminPollRouter = Router();

adminPollRouter.use(requireAuth, requireRole('ADMIN', 'HOST', 'MODERATOR'));

adminPollRouter.get(
  '/:webinarId/polls',
  asyncHandler(async (req, res) => {
    const polls = await prisma.poll.findMany({
      where: { webinarId: req.params.webinarId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { votes: true } } },
    });

    res.json({
      polls: polls.map((p) => ({
        id: p.id,
        question: p.question,
        options: JSON.parse(p.optionsJson) as QuizOption[],
        timeLimitSecs: p.timeLimitSecs,
        voteCount: p._count.votes,
      })),
    });
  })
);

adminPollRouter.post(
  '/:webinarId/polls',
  asyncHandler(async (req, res) => {
    const body = pollSchema.parse(req.body);
    const poll = await prisma.poll.create({
      data: {
        webinarId: req.params.webinarId,
        question: body.question,
        optionsJson: JSON.stringify(body.options),
        timeLimitSecs: body.timeLimitSecs,
      },
    });
    res.status(201).json({ poll: { ...poll, options: body.options } });
  })
);

adminPollRouter.patch(
  '/polls/:id',
  asyncHandler(async (req, res) => {
    const body = pollSchema.parse(req.body);

    const existing = await prisma.poll.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { votes: true } } },
    });
    if (!existing) throw notFound('Poll not found');

    // Same reasoning as a quiz: a vote stores the option id it was cast for, so
    // replacing the option list after votes exist would orphan them.
    const optionsChanged =
      JSON.stringify(body.options) !== existing.optionsJson;
    if (optionsChanged && existing._count.votes > 0) {
      throw badRequest(
        'This poll already has votes, so its options can no longer be changed. Delete it and create a new one.'
      );
    }

    const poll = await prisma.poll.update({
      where: { id: existing.id },
      data: {
        question: body.question,
        optionsJson: JSON.stringify(body.options),
        timeLimitSecs: body.timeLimitSecs,
      },
    });

    res.json({ poll: { ...poll, options: body.options } });
  })
);

adminPollRouter.delete(
  '/polls/:id',
  asyncHandler(async (req, res) => {
    await prisma.poll.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

/* ── CTAs ──────────────────────────────────────────────────── */

export const adminCtaRouter = Router();

adminCtaRouter.use(requireAuth, requireRole('ADMIN', 'HOST', 'MODERATOR'));

/**
 * The offer list.
 *
 * `clickCount` is included per offer because the host's whole reason for
 * opening this tab mid-session is to see whether the offer is landing. Counting
 * in a second query per row would be N+1; Prisma's `_count` does it in one.
 */
adminCtaRouter.get(
  '/:webinarId/ctas',
  asyncHandler(async (req, res) => {
    const ctas = await prisma.cta.findMany({
      where: { webinarId: req.params.webinarId },
      include: {
        course: true,
        formFields: { orderBy: { order: 'asc' } },
        _count: { select: { clicks: true } },
      },
      orderBy: { id: 'asc' },
    });

    res.json({
      ctas: ctas.map((c) => ({
        ...c,
        clickCount: c._count.clicks,
        form: serializeForm(c as never),
        _count: undefined,
      })),
    });
  })
);

adminCtaRouter.post(
  '/:webinarId/ctas',
  asyncHandler(async (req, res) => {
    const body = ctaSchema.parse(req.body);
    const cta = await prisma.cta.create({
      data: {
        webinarId: req.params.webinarId,
        title: body.title,
        description: body.description ?? null,
        buttonText: body.buttonText,
        courseId: body.courseId ?? null,
        priceOverridePaise: body.priceOverridePaise ?? null,
        externalUrl: body.externalUrl || null,
        formEnabled: body.formEnabled,
        formIntro: body.formIntro ?? null,
        formSubmitText: body.formSubmitText,
      },
    });

    if (body.formFields.length > 0) {
      await replaceFormFields(cta.id, body.formFields);
    }

    const full = await prisma.cta.findUniqueOrThrow({
      where: { id: cta.id },
      include: CTA_INCLUDE,
    });

    res.status(201).json({
      cta: { ...full, clickCount: 0, form: serializeForm(full as never) },
    });
  })
);

/**
 * PATCH /api/admin/ctas/:id
 *
 * Editing an offer after it exists. This is what makes the pre-payment form
 * "customizable at the host end" — without it a host would have to delete the
 * offer and recreate it, losing its click history.
 */
adminCtaRouter.patch(
  '/ctas/:id',
  asyncHandler(async (req, res) => {
    const body = updateCtaSchema.parse(req.body);

    const existing = await prisma.cta.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Offer not found');

    await prisma.cta.update({
      where: { id: existing.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description ?? null } : {}),
        ...(body.buttonText !== undefined ? { buttonText: body.buttonText } : {}),
        ...(body.courseId !== undefined ? { courseId: body.courseId || null } : {}),
        ...(body.priceOverridePaise !== undefined
          ? { priceOverridePaise: body.priceOverridePaise }
          : {}),
        ...(body.externalUrl !== undefined ? { externalUrl: body.externalUrl || null } : {}),
        ...(body.formEnabled !== undefined ? { formEnabled: body.formEnabled } : {}),
        ...(body.formIntro !== undefined ? { formIntro: body.formIntro ?? null } : {}),
        ...(body.formSubmitText !== undefined ? { formSubmitText: body.formSubmitText } : {}),
      },
    });

    // A supplied field list replaces the old one wholesale — merging an ordered
    // list has no sensible meaning, and the host's editor always sends the
    // complete list it is showing.
    if (body.formFields !== undefined) {
      await replaceFormFields(existing.id, body.formFields);
    }

    const full = await prisma.cta.findUniqueOrThrow({
      where: { id: existing.id },
      include: CTA_INCLUDE,
    });

    res.json({
      cta: {
        ...full,
        clickCount: await countClicks(full.id),
        form: serializeForm(full as never),
      },
    });
  })
);

/* ── Offer follow-up ───────────────────────────────────────── */

/**
 * Who opened an offer, what they answered, and whether they paid.
 *
 * Deliberately a separate router from `adminCtaRouter`, and guarded by
 * authentication only. A co-host's JWT still says `PARTICIPANT` — their staff
 * rights live in `WebinarCohost`, not in the token — so a `requireRole` guard
 * would lock out exactly the people this list exists for. The handler does the
 * real check: owner, admin, moderator, or an invited co-host of *this* webinar.
 */
export const ctaFollowUpRouter = Router();

ctaFollowUpRouter.use(requireAuth);

/**
 * Is this user allowed to see the room's commercial activity?
 *
 * Mirrors the precedence the socket layer uses at join time, so a person who
 * can run the room can also read its follow-up list.
 */
async function canFollowUp(
  userId: string,
  role: string,
  webinarId: string
): Promise<boolean> {
  if (role === 'ADMIN') return true;

  const webinar = await prisma.webinar.findUnique({
    where: { id: webinarId },
    select: {
      hostId: true,
      moderators: { where: { userId }, select: { userId: true } },
    },
  });
  if (!webinar) return false;
  if (webinar.hostId === userId) return true;
  if (webinar.moderators.length > 0) return true;

  // A co-host is invited by email, often before they have an account, so match
  // on the address too — the same fallback the policy endpoint uses.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) return false;

  const cohost = await prisma.webinarCohost.findFirst({
    where: {
      webinarId,
      OR: [{ userId }, { email: user.email.toLowerCase() }],
    },
    select: { id: true },
  });
  return Boolean(cohost);
}

/**
 * GET /api/admin/ctas/:id/follow-up
 *
 * The click count answers "is this landing". This answers "who do I call".
 * One row per person who opened the offer, carrying their contact details,
 * their form answers, and where they got to in checkout.
 */
ctaFollowUpRouter.get(
  '/ctas/:id/follow-up',
  asyncHandler(async (req, res) => {
    const user = req.user!;

    const cta = await prisma.cta.findUnique({
      where: { id: req.params.id },
      include: CTA_INCLUDE,
    });
    if (!cta) throw notFound('Offer not found');

    if (!(await canFollowUp(user.id, user.role, cta.webinarId))) {
      throw forbidden('You do not have access to this offer');
    }

    const clicks = await prisma.ctaClick.findMany({
      where: { ctaId: cta.id },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
      },
    });

    const userIds = clicks.map((c) => c.userId);

    // Payments are looked up by offer *and* user rather than by the click row,
    // because a buyer who paid without ever opening the card still has a
    // payment — and the host wants to see them, not silently drop them.
    const [payments, registrations] = await Promise.all([
      prisma.payment.findMany({
        where: { ctaId: cta.id, userId: { in: userIds } },
        orderBy: { createdAt: 'desc' },
        select: {
          userId: true,
          status: true,
          amountPaise: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.registration.findMany({
        where: { webinarId: cta.webinarId, userId: { in: userIds } },
        select: { userId: true, attended: true, createdAt: true },
      }),
    ]);

    // A user can have several attempts; the most recent one wins, and a PAID
    // attempt outranks a later failed retry — otherwise a successful purchase
    // would read as "failed" because the buyer tried again afterwards.
    const paymentByUser = new Map<string, (typeof payments)[number]>();
    for (const p of payments) {
      const existing = paymentByUser.get(p.userId);
      if (!existing) {
        paymentByUser.set(p.userId, p);
      } else if (existing.status !== 'PAID' && p.status === 'PAID') {
        paymentByUser.set(p.userId, p);
      }
    }

    const registrationByUser = new Map(registrations.map((r) => [r.userId, r]));
    // The labels come from the stored field rows, not from `serializeForm`,
    // because `serializeForm` returns null once the host turns the form off —
    // and the answers collected while it was on are still worth reading. A
    // follow-up list that went blank the moment the form was disabled would
    // throw away the very data the host is chasing.
    const fields = [...cta.formFields]
      .sort((a, b) => a.order - b.order)
      .map((f) => ({ id: f.id, label: f.label, type: f.type }));
    const fieldIds = new Set(fields.map((f) => f.id));

    const people = clicks.map((c) => {
      const responses = safeParse(c.responsesJson);
      const payment = paymentByUser.get(c.userId);
      const registration = registrationByUser.get(c.userId);

      // "Filled" means they answered at least one question the form actually
      // asks. A stale answer to a field the host has since deleted must not
      // read as a completed form.
      const answered = Object.keys(responses).filter(
        (k) => fieldIds.size === 0 || fieldIds.has(k)
      );

      return {
        userId: c.userId,
        name: c.user.name,
        email: c.user.email,
        phone: c.user.phone,
        clickedAt: c.createdAt,
        formFilled: answered.length > 0,
        answeredCount: answered.length,
        responses,
        paymentStatus: payment?.status ?? null,
        paidAt: payment?.status === 'PAID' ? payment.updatedAt : null,
        amountPaise: payment?.amountPaise ?? null,
        purchasedAt: c.purchasedAt,
        attended: registration?.attended ?? false,
        registeredAt: registration?.createdAt ?? null,
      };
    });

    res.json({
      offer: {
        id: cta.id,
        title: cta.title,
        priceInPaise: cta.priceOverridePaise ?? cta.course?.pricePaise ?? 0,
        currency: cta.course?.currency ?? 'INR',
        formEnabled: cta.formEnabled,
      },
      fields: fields,
      people,
      summary: {
        clicked: people.length,
        formFilled: people.filter((p) => p.formFilled).length,
        paid: people.filter((p) => p.paymentStatus === 'PAID').length,
        pending: people.filter(
          (p) => p.paymentStatus !== 'PAID' && p.paymentStatus !== 'REFUNDED'
        ).length,
      },
    });
  })
);

/**
 * GET /api/admin/ctas/:id/clicks
 *
 * The raw click rows. Kept alongside `/follow-up` because they answer different
 * questions: this one is the audit trail (who, when, what they typed), while
 * `/follow-up` joins in payments and registrations to answer "who do I call".
 */
adminCtaRouter.get(
  '/ctas/:id/clicks',
  asyncHandler(async (req, res) => {
    const clicks = await prisma.ctaClick.findMany({
      where: { ctaId: req.params.id },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true, phone: true } } },
    });

    res.json({
      clicks: clicks.map((c) => ({
        id: c.id,
        userId: c.userId,
        name: c.user.name,
        email: c.user.email,
        phone: c.user.phone,
        responses: safeParse(c.responsesJson),
        purchasedAt: c.purchasedAt,
        createdAt: c.createdAt,
      })),
      total: clicks.length,
      purchased: clicks.filter((c) => c.purchasedAt).length,
    });
  })
);

adminCtaRouter.delete(
  '/ctas/:id',
  asyncHandler(async (req, res) => {
    await prisma.cta.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

/* ── Courses ───────────────────────────────────────────────── */

export const adminCourseRouter = Router();

adminCourseRouter.use(requireAuth, requireRole('ADMIN'));

adminCourseRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const courses = await prisma.course.findMany({ orderBy: { title: 'asc' } });
    res.json({ courses });
  })
);

adminCourseRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = (await import('../webinars/schema.js')).courseSchema.parse(req.body);
    const course = await prisma.course.create({
      data: {
        title: body.title,
        description: body.description ?? null,
        pricePaise: body.pricePaise,
        currency: body.currency,
      },
    });
    res.status(201).json({ course });
  })
);

adminCourseRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const course = await prisma.course.findUnique({ where: { id: req.params.id } });
    if (!course) throw notFound('Course not found');
    await prisma.course.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);
