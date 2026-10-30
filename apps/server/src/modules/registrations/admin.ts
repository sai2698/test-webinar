import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { sendMail, registrationEmail } from '../../utils/mail.js';
import { env } from '../../config/env.js';
import { emitWebhook } from '../webhooks/service.js';
import { REGISTRATION_STATUSES } from '@webinar/shared';
import type { RegistrationStatus, WebhookEvent } from '@webinar/shared';

export const adminRegistrationRouter = Router();

adminRegistrationRouter.use(requireAuth, requireRole('ADMIN', 'HOST', 'MODERATOR'));

const statusSchema = z.object({
  status: z.enum(REGISTRATION_STATUSES as [string, ...string[]]),
  note: z.string().max(500).optional(),
});

const inviteSchema = z.object({
  // Addresses are validated per-entry in the handler, not here. A batch of 200
  // pasted addresses with one typo must invite the other 199 and report the
  // bad one — rejecting the whole request makes the host hunt for the typo.
  emails: z.array(z.string().trim().min(1)).min(1).max(500),
  /** Send the invitation email. Off lets a host stage invites first. */
  sendEmail: z.boolean().default(true),
});

/**
 * GET /api/admin/:webinarId/registrations
 *
 * The attendee list. `status` filters it, which is what the approval queue
 * uses: `?status=PENDING` is the "waiting for you" view.
 */
adminRegistrationRouter.get(
  '/:webinarId/registrations',
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? '');
    const search = String(req.query.q ?? '').trim().toLowerCase();

    const rows = await prisma.registration.findMany({
      where: {
        webinarId: req.params.webinarId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        customResponses: {
          include: { field: { select: { id: true, label: true, type: true } } },
        },
      },
    });

    const filtered = search
      ? rows.filter(
          (r) =>
            r.user.name.toLowerCase().includes(search) ||
            r.user.email.toLowerCase().includes(search)
        )
      : rows;

    res.json({
      registrations: filtered.map((r) => ({
        id: r.id,
        userId: r.userId,
        name: r.user.name,
        email: r.user.email,
        phone: r.user.phone,
        status: r.status,
        statusNote: r.statusNote,
        paid: r.paid,
        attended: r.attended,
        joinToken: r.joinToken,
        createdAt: r.createdAt.toISOString(),
        responses: r.customResponses.map((cr) => ({
          fieldId: cr.fieldId,
          label: cr.field.label,
          type: cr.field.type,
          value: safeParse(cr.valueJson),
        })),
      })),
      counts: await statusCounts(req.params.webinarId),
    });
  })
);

/**
 * PATCH /api/admin/registrations/:id
 *
 * Approve, reject, waitlist or cancel one registration. The attendee is emailed
 * when the decision is favourable, because otherwise they sit on a page that
 * says "waiting" forever.
 */
adminRegistrationRouter.patch(
  '/registrations/:id',
  asyncHandler(async (req, res) => {
    const body = statusSchema.parse(req.body);

    const registration = await prisma.registration.findUnique({
      where: { id: req.params.id },
      include: {
        user: true,
        webinar: { select: { id: true, slug: true, title: true, startsAt: true, timezone: true } },
      },
    });
    if (!registration) throw notFound('Registration not found');

    const updated = await prisma.registration.update({
      where: { id: registration.id },
      data: {
        status: body.status,
        statusNote: body.note ?? null,
        statusChangedAt: new Date(),
      },
    });

    const event = STATUS_EVENT[body.status as RegistrationStatus];
    if (event) {
      void emitWebhook(event, {
        webinarId: registration.webinar.id,
        webinarSlug: registration.webinar.slug,
        registrationId: registration.id,
        email: registration.user.email,
        name: registration.user.name,
        status: body.status,
        note: body.note ?? null,
      });
    }

    // Only an approval is actionable for the attendee — it is the one decision
    // that hands them a join link.
    if (body.status === 'APPROVED') {
      const message = registrationEmail({
        name: registration.user.name,
        webinarTitle: registration.webinar.title,
        startsAt: registration.webinar.startsAt,
        timezone: registration.webinar.timezone,
        joinUrl: `${env.WEB_ORIGIN}/room/${registration.webinar.slug}?token=${encodeURIComponent(registration.joinToken)}`,
      });
      void sendMail({ to: registration.user.email, ...message });
    }

    res.json({
      registration: {
        id: updated.id,
        status: updated.status,
        statusNote: updated.statusNote,
        statusChangedAt: updated.statusChangedAt?.toISOString() ?? null,
      },
      counts: await statusCounts(registration.webinarId),
    });
  })
);

/**
 * POST /api/admin/:webinarId/registrations/approve-all
 *
 * The "approve everyone waiting" button. Bounded to PENDING so it can never
 * resurrect a rejection by accident.
 */
adminRegistrationRouter.post(
  '/:webinarId/registrations/approve-all',
  asyncHandler(async (req, res) => {
    const webinarId = req.params.webinarId;

    const pending = await prisma.registration.findMany({
      where: { webinarId, status: 'PENDING' },
      include: { user: true },
    });

    if (pending.length === 0) {
      res.json({ approved: 0, counts: await statusCounts(webinarId) });
      return;
    }

    await prisma.registration.updateMany({
      where: { webinarId, status: 'PENDING' },
      data: { status: 'APPROVED', statusChangedAt: new Date() },
    });

    const webinar = await prisma.webinar.findUnique({
      where: { id: webinarId },
      select: { slug: true, title: true, startsAt: true, timezone: true },
    });

    if (webinar) {
      for (const r of pending) {
        const message = registrationEmail({
          name: r.user.name,
          webinarTitle: webinar.title,
          startsAt: webinar.startsAt,
          timezone: webinar.timezone,
          joinUrl: `${env.WEB_ORIGIN}/room/${webinar.slug}?token=${encodeURIComponent(r.joinToken)}`,
        });
        void sendMail({ to: r.user.email, ...message });
      }
    }

    res.json({ approved: pending.length, counts: await statusCounts(webinarId) });
  })
);

/**
 * POST /api/admin/:webinarId/invite
 *
 * Bulk invite by email. Each address becomes a real registration with a join
 * token, so an invitee who clicks the link lands straight in the room — the
 * invite *is* the registration, which is what makes `attended` meaningful.
 *
 * Re-inviting an existing registrant is not an error: it re-sends the link and
 * leaves their status alone.
 */
adminRegistrationRouter.post(
  '/:webinarId/invite',
  asyncHandler(async (req, res) => {
    const body = inviteSchema.parse(req.body);
    const webinarId = req.params.webinarId;

    const webinar = await prisma.webinar.findUnique({
      where: { id: webinarId },
      select: { id: true, slug: true, title: true, startsAt: true, timezone: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    const results: { email: string; invited: boolean; reason?: string }[] = [];

    for (const raw of body.emails) {
      const email = raw.toLowerCase().trim();

      // One malformed address must not sink the batch. Report it and move on.
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        results.push({ email: raw, invited: false, reason: 'Not a valid email address' });
        continue;
      }

      let user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        user = await prisma.user.create({
          data: {
            name: email.split('@')[0] ?? 'Guest',
            email,
            role: 'PARTICIPANT',
          },
        });
      }

      const existing = await prisma.registration.findUnique({
        where: { webinarId_userId: { webinarId, userId: user.id } },
      });

      const registration =
        existing ??
        (await prisma.registration.create({
          data: {
            webinarId,
            userId: user.id,
            joinToken: nanoid(32),
            paid: true,
            // An invited person is pre-approved: the host chose them.
            status: 'APPROVED',
            statusChangedAt: new Date(),
          },
        }));

      if (body.sendEmail) {
        const message = registrationEmail({
          name: user.name,
          webinarTitle: webinar.title,
          startsAt: webinar.startsAt,
          timezone: webinar.timezone,
          joinUrl: `${env.WEB_ORIGIN}/room/${webinar.slug}?token=${encodeURIComponent(registration.joinToken)}`,
        });
        void sendMail({ to: user.email, ...message });
      }

      void emitWebhook('webinar.user.invited', {
        webinarId,
        webinarSlug: webinar.slug,
        email,
        registrationId: registration.id,
      });

      results.push({ email, invited: true });
    }

    res.json({ invited: results.filter((r) => r.invited).length, results });
  })
);

/**
 * DELETE /api/admin/:webinarId/invite
 *
 * Uninvite. The registration is cancelled rather than deleted so the audit
 * trail survives — "we invited them and then withdrew it" is information.
 */
adminRegistrationRouter.delete(
  '/:webinarId/invite',
  asyncHandler(async (req, res) => {
    const email = String(req.query.email ?? '').toLowerCase().trim();
    if (!email) throw badRequest('email is required');

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw notFound('No such invitee');

    const registration = await prisma.registration.findUnique({
      where: { webinarId_userId: { webinarId: req.params.webinarId, userId: user.id } },
    });
    if (!registration) throw notFound('No such invitee');

    await prisma.registration.update({
      where: { id: registration.id },
      data: { status: 'CANCELLED', statusChangedAt: new Date() },
    });

    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { slug: true },
    });

    void emitWebhook('webinar.user.uninvited', {
      webinarId: req.params.webinarId,
      webinarSlug: webinar?.slug ?? null,
      email,
    });

    res.json({ ok: true });
  })
);

/**
 * GET /api/admin/:webinarId/registrations/export
 *
 * CSV of every registration with its custom answers as columns. This is the
 * report a marketer actually wants, and it is why custom fields are rows rather
 * than a JSON blob — the columns fall out of the field list.
 */
adminRegistrationRouter.get(
  '/:webinarId/registrations/export',
  asyncHandler(async (req, res) => {
    const webinarId = req.params.webinarId;

    const [fields, rows] = await Promise.all([
      prisma.customField.findMany({
        where: { webinarId, deletedAt: null },
        orderBy: { order: 'asc' },
        select: { id: true, label: true },
      }),
      prisma.registration.findMany({
        where: { webinarId },
        orderBy: { createdAt: 'asc' },
        include: {
          user: { select: { name: true, email: true, phone: true } },
          customResponses: true,
        },
      }),
    ]);

    const header = [
      'Name',
      'Email',
      'Phone',
      'Status',
      'Paid',
      'Attended',
      'Registered At',
      ...fields.map((f) => f.label),
    ];

    const lines = [header.map(csvCell).join(',')];

    for (const r of rows) {
      const byField = new Map(r.customResponses.map((cr) => [cr.fieldId, cr.valueJson]));
      lines.push(
        [
          r.user.name,
          r.user.email,
          r.user.phone ?? '',
          r.status,
          r.paid ? 'yes' : 'no',
          r.attended ? 'yes' : 'no',
          r.createdAt.toISOString(),
          ...fields.map((f) => {
            const raw = byField.get(f.id);
            if (!raw) return '';
            const value = safeParse(raw);
            return Array.isArray(value) ? value.join('; ') : String(value ?? '');
          }),
        ]
          .map(csvCell)
          .join(',')
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="registrations-${webinarId}.csv"`
    );
    res.send(lines.join('\r\n') + '\r\n');
  })
);

/* ── helpers ───────────────────────────────────────────────── */

const STATUS_EVENT: Partial<Record<RegistrationStatus, WebhookEvent>> = {
  APPROVED: 'registration.approved',
  REJECTED: 'registration.rejected',
  WAITLISTED: 'registration.waitlisted',
  CANCELLED: 'registration.cancelled',
};

async function statusCounts(webinarId: string) {
  const grouped = await prisma.registration.groupBy({
    by: ['status'],
    where: { webinarId },
    _count: { _all: true },
  });

  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  return counts;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Quote a CSV cell.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a single quote: Excel treats
 * those as formulas, and a name like `=cmd|...` in an exported report is a
 * genuine attack vector, not a formatting quirk.
 */
function csvCell(value: string): string {
  let v = value ?? '';
  if (/^[=+\-@]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}
