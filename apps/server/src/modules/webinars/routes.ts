import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { createWebinarSchema, updateWebinarSchema } from './schema.js';
import { env } from '../../config/env.js';
import { roomManager } from '../../realtime/RoomManager.js';
import { toSettings } from './service.js';
import {
  findWebinarById,
  findWebinarBySlug,
  generateUniqueSlug,
  serializePublicWebinar,
  serializeWebinar,
} from './service.js';

/* ── Public routes ─────────────────────────────────────────── */

export const publicWebinarRouter = Router();

publicWebinarRouter.get(
  '/:slug/public',
  asyncHandler(async (req, res) => {
    const webinar = await findWebinarBySlug(req.params.slug);
    if (!webinar) throw notFound('Webinar not found');
    res.json({ webinar: serializePublicWebinar(webinar) });
  })
);

/**
 * GET /api/webinars/:slug/calendar.ics
 *
 * A calendar file for the "Add to Calendar" button. Generated on the server
 * rather than in the browser so the timestamps are authoritative and the
 * description can carry the join link.
 *
 * Times are emitted in UTC (`Z` suffix) because that is the only form every
 * calendar client agrees on — Outlook, Google and Apple all localise a UTC
 * stamp correctly, whereas a floating local time is interpreted differently
 * depending on the reader's machine.
 */
publicWebinarRouter.get(
  '/:slug/calendar.ics',
  asyncHandler(async (req, res) => {
    const webinar = await findWebinarBySlug(req.params.slug);
    if (!webinar) throw notFound('Webinar not found');

    const start = webinar.startsAt;
    const end = new Date(start.getTime() + webinar.durationMins * 60_000);

    // RFC 5545 wants UTC basic format: 20261027T063000Z
    const stamp = (d: Date) =>
      `${d.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;

    // Text values must escape backslash, semicolon, comma and newline, or a
    // title containing a comma silently truncates the field.
    const esc = (s: string) =>
      s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

    // Long lines must be folded at 75 octets per RFC 5545. Without this some
    // clients reject the file outright.
    const fold = (line: string) => {
      if (line.length <= 75) return line;
      const parts: string[] = [line.slice(0, 75)];
      let rest = line.slice(75);
      while (rest.length > 74) {
        parts.push(` ${rest.slice(0, 74)}`);
        rest = rest.slice(74);
      }
      if (rest) parts.push(` ${rest}`);
      return parts.join('\r\n');
    };

    const joinUrl = `${env.WEB_ORIGIN}/w/${webinar.slug}`;

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//NexaLive//Webinar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${webinar.id}@nexalive`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${esc(webinar.title)}`,
      `DESCRIPTION:${esc(`${webinar.description || webinar.title}\n\nJoin: ${joinUrl}`)}`,
      `URL:${joinUrl}`,
      'STATUS:CONFIRMED',
      // A reminder 10 minutes out, matching the last email reminder.
      'BEGIN:VALARM',
      'TRIGGER:-PT10M',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(webinar.title)}`,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ];

    const body = lines.map(fold).join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${webinar.slug}.ics"`
    );
    res.send(body);
  })
);

/* ── Admin routes ──────────────────────────────────────────── */

export const adminWebinarRouter = Router();

adminWebinarRouter.use(requireAuth, requireRole('ADMIN'));

adminWebinarRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const webinars = await prisma.webinar.findMany({
      orderBy: { startsAt: 'desc' },
      include: {
        moderators: true,
        host: { select: { id: true, name: true, email: true } },
        _count: { select: { registrations: true } },
      },
    });
    res.json({
      webinars: webinars.map((w) => ({
        ...serializeWebinar(w),
        registrationCount: w._count.registrations,
      })),
    });
  })
);

adminWebinarRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const webinar = await findWebinarById(req.params.id);
    if (!webinar) throw notFound('Webinar not found');
    res.json({ webinar: serializeWebinar(webinar) });
  })
);

adminWebinarRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createWebinarSchema.parse(req.body);
    const slug = body.slug ?? (await generateUniqueSlug(body.title));

    const existing = await prisma.webinar.findUnique({ where: { slug } });
    if (existing) throw badRequest('That slug is already taken');

    const hostId = body.hostId ?? req.user!.id;

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
        hostId,
        createdById: req.user!.id,
        ...body.settings,
        // An empty passcode means "no passcode", not "the empty string".
        passcode: body.settings.passcode?.trim() || null,
        moderators: {
          create: body.moderatorIds.map((userId) => ({ userId })),
        },
      },
      include: {
        moderators: true,
        host: { select: { id: true, name: true, email: true } },
      },
    });

    res.status(201).json({ webinar: serializeWebinar(webinar) });
  })
);

adminWebinarRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateWebinarSchema.parse(req.body);
    const existing = await findWebinarById(req.params.id);
    if (!existing) throw notFound('Webinar not found');

    if (body.slug && body.slug !== existing.slug) {
      const clash = await prisma.webinar.findUnique({ where: { slug: body.slug } });
      if (clash) throw badRequest('That slug is already taken');
    }

    const { settings, moderatorIds, ...rest } = body;

    const webinar = await prisma.webinar.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        ...(settings ?? {}),
        // Only touch the passcode when the caller actually sent the field, so
        // an unrelated settings patch cannot silently clear it.
        ...(settings && 'passcode' in settings
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
      include: {
        moderators: true,
        host: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({ webinar: serializeWebinar(webinar) });

    // A live room holds its own copy of the settings, so a host who flips
    // "participants can see each other" mid-session would otherwise wait for
    // everyone to rejoin before it took effect. Push it now and let the room
    // re-evaluate who may see whom.
    const live = roomManager.get(webinar.id);
    if (live) {
      live.settings = toSettings(webinar);
      live.applyVisibilityChange();
    }
  })
);

adminWebinarRouter.post(
  '/:id/publish',
  asyncHandler(async (req, res) => {
    const webinar = await prisma.webinar.update({
      where: { id: req.params.id },
      data: { status: 'SCHEDULED' },
      include: {
        moderators: true,
        host: { select: { id: true, name: true, email: true } },
      },
    });
    res.json({ webinar: serializeWebinar(webinar) });
  })
);

adminWebinarRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await prisma.webinar.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

/**
 * POST /api/admin/webinars/:id/premiere/start
 *
 * Starts the premiere clock. Every viewer's playback position is derived from
 * `premiereStartedAt`, which is what makes a recording feel like a live
 * session: two people opening the link a minute apart are a minute apart in
 * the video, not each at their own pace.
 *
 * Restarting is allowed and simply resets the clock — that is the "re-run"
 * action, and it is the whole point of a pre-recorded webinar.
 */
adminWebinarRouter.post(
  '/:id/premiere/start',
  asyncHandler(async (req, res) => {
    const webinar = await findWebinarById(req.params.id);
    if (!webinar) throw notFound('Webinar not found');
    if (!webinar.premiereRecordingId) {
      throw badRequest('Attach a recording before starting the premiere');
    }

    const recording = await prisma.recording.findFirst({
      where: { id: webinar.premiereRecordingId, webinarId: webinar.id },
    });
    if (!recording) throw badRequest('The attached recording no longer exists');
    if (recording.status !== 'READY') {
      throw badRequest(`The recording is ${recording.status.toLowerCase()}, not ready`);
    }

    const updated = await prisma.webinar.update({
      where: { id: webinar.id },
      data: { premiereStartedAt: new Date(), status: 'LIVE' },
      include: {
        moderators: true,
        host: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({ webinar: serializeWebinar(updated) });
  })
);

/** POST /api/admin/webinars/:id/premiere/stop — ends the premiere. */
adminWebinarRouter.post(
  '/:id/premiere/stop',
  asyncHandler(async (req, res) => {
    const webinar = await findWebinarById(req.params.id);
    if (!webinar) throw notFound('Webinar not found');

    const updated = await prisma.webinar.update({
      where: { id: webinar.id },
      data: { premiereStartedAt: null, status: 'ENDED' },
      include: {
        moderators: true,
        host: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({ webinar: serializeWebinar(updated) });
  })
);

adminWebinarRouter.get(
  '/:id/registrations',
  asyncHandler(async (req, res) => {
    const registrations = await prisma.registration.findMany({
      where: { webinarId: req.params.id },
      include: { user: { select: { name: true, email: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
    });

    if (req.query.format === 'csv') {
      const rows = [
        ['Name', 'Email', 'Phone', 'Paid', 'Attended', 'Registered At'],
        ...registrations.map((r) => [
          r.user.name,
          r.user.email,
          r.user.phone ?? '',
          String(r.paid),
          String(r.attended),
          r.createdAt.toISOString(),
        ]),
      ];
      const csv = rows
        .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="registrations.csv"');
      res.send(csv);
      return;
    }

    res.json({
      registrations: registrations.map((r) => ({
        id: r.id,
        name: r.user.name,
        email: r.user.email,
        phone: r.user.phone,
        paid: r.paid,
        attended: r.attended,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  })
);

adminWebinarRouter.get(
  '/:id/analytics',
  asyncHandler(async (req, res) => {
    const webinarId = req.params.id;

    const [registrations, paidCount, quizzes, payments] = await Promise.all([
      prisma.registration.count({ where: { webinarId } }),
      prisma.registration.count({ where: { webinarId, paid: true } }),
      prisma.quiz.findMany({
        where: { webinarId },
        include: { answers: true },
      }),
      prisma.payment.findMany({ where: { webinarId, status: 'PAID' } }),
    ]);

    const revenuePaise = payments.reduce((sum, p) => sum + p.amountPaise, 0);

    res.json({
      analytics: {
        registrations,
        paidRegistrations: paidCount,
        revenuePaise,
        quizzes: quizzes.map((q) => ({
          id: q.id,
          question: q.question,
          answers: q.answers.length,
          correct: q.answers.filter((a) => a.isCorrect).length,
        })),
      },
    });
  })
);

/* ── Staff user directory (for host/moderator pickers) ─────── */

export const adminUsersRouter = Router();

adminUsersRouter.use(requireAuth, requireRole('ADMIN'));

adminUsersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const role = z
      .enum(['ADMIN', 'HOST', 'MODERATOR', 'PARTICIPANT'])
      .optional()
      .parse(req.query.role);

    const users = await prisma.user.findMany({
      where: role ? { role } : undefined,
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
    res.json({ users });
  })
);
