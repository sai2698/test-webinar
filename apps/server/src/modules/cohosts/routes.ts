import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import {
  COHOST_PERMISSION_KEYS,
  DEFAULT_COHOST_PERMISSIONS,
} from '@webinar/shared';
import type { Cohost, CohostPermissions } from '@webinar/shared';
import { sendMail } from '../../utils/mail.js';
import { env } from '../../config/env.js';

export const adminCohostRouter = Router();

/**
 * The "what may I do here" route is deliberately separate from the admin
 * router. A co-host is invited by email and their JWT still says PARTICIPANT,
 * so the staff-role guard on `adminCohostRouter` would lock them out of the one
 * endpoint that tells them what they are allowed to do. Authentication is the
 * only requirement; the handler decides what the answer is.
 */
export const cohostPolicyRouter = Router();

cohostPolicyRouter.use(requireAuth);

adminCohostRouter.use(requireAuth, requireRole('ADMIN', 'HOST', 'MODERATOR'));

/** webinar.gg caps a room at 10 co-hosts. */
const MAX_COHOSTS = 10;

const permissionShape = z.object(
  Object.fromEntries(COHOST_PERMISSION_KEYS.map((k) => [k, z.boolean()])) as Record<
    keyof CohostPermissions,
    z.ZodBoolean
  >
);

const addCohostSchema = z.object({
  email: z.string().email(),
  name: z.string().max(120).optional(),
  permissions: permissionShape.partial().optional(),
});

const updateCohostSchema = z.object({
  permissions: permissionShape.partial().optional(),
  name: z.string().max(120).optional(),
});

const policySchema = z.object({
  cohostStartWithoutHost: z.boolean().optional(),
  /** Defaults applied to every co-host who has no explicit override. */
  permissions: permissionShape.partial().optional(),
});

/**
 * Merge a stored permission map over the defaults.
 *
 * Merging rather than replacing means a permission added in a later release is
 * automatically granted to existing co-hosts, and a row written before that
 * permission existed does not read as `undefined`.
 */
export function resolvePermissions(json: string | null): CohostPermissions {
  let stored: Partial<CohostPermissions> = {};
  if (json) {
    try {
      stored = JSON.parse(json) as Partial<CohostPermissions>;
    } catch {
      stored = {};
    }
  }
  return { ...DEFAULT_COHOST_PERMISSIONS, ...stored };
}

function serialize(row: {
  id: string;
  email: string;
  userId: string | null;
  name: string | null;
  source: string;
  permissionsJson: string;
  inviteSentAt: Date | null;
  createdAt: Date;
}): Cohost {
  return {
    id: row.id,
    email: row.email,
    userId: row.userId,
    name: row.name,
    source: row.source === 'live' ? 'live' : 'pre_webinar',
    permissions: resolvePermissions(row.permissionsJson),
    inviteSentAt: row.inviteSentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** GET /api/admin/:webinarId/cohosts */
adminCohostRouter.get(
  '/:webinarId/cohosts',
  asyncHandler(async (req, res) => {
    const rows = await prisma.webinarCohost.findMany({
      where: { webinarId: req.params.webinarId },
      orderBy: { createdAt: 'asc' },
    });

    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: { cohostStartWithoutHost: true, cohostPermissionsJson: true },
    });

    res.json({
      cohosts: rows.map(serialize),
      maxCohosts: MAX_COHOSTS,
      policy: {
        cohostStartWithoutHost: webinar?.cohostStartWithoutHost ?? false,
        permissions: resolvePermissions(webinar?.cohostPermissionsJson ?? null),
      },
    });
  })
);

/**
 * POST /api/admin/:webinarId/cohosts
 *
 * Adds a co-host by email. If the address already belongs to a user, the row is
 * linked to that account so the permission check can find it from a socket
 * session without an email lookup on every event.
 */
adminCohostRouter.post(
  '/:webinarId/cohosts',
  asyncHandler(async (req, res) => {
    const body = addCohostSchema.parse(req.body);
    const webinarId = req.params.webinarId;
    const email = body.email.toLowerCase().trim();

    const webinar = await prisma.webinar.findUnique({
      where: { id: webinarId },
      select: { id: true, slug: true, title: true, hostId: true },
    });
    if (!webinar) throw notFound('Webinar not found');

    if (email === (await hostEmail(webinar.hostId))) {
      throw badRequest('The host is already the host');
    }

    const count = await prisma.webinarCohost.count({ where: { webinarId } });
    if (count >= MAX_COHOSTS) {
      throw badRequest(`A webinar can have at most ${MAX_COHOSTS} co-hosts`);
    }

    const existing = await prisma.webinarCohost.findUnique({
      where: { webinarId_email: { webinarId, email } },
    });
    if (existing) throw badRequest('That person is already a co-host');

    const user = await prisma.user.findUnique({ where: { email } });

    const row = await prisma.webinarCohost.create({
      data: {
        webinarId,
        email,
        userId: user?.id ?? null,
        name: body.name ?? user?.name ?? null,
        source: 'pre_webinar',
        permissionsJson: JSON.stringify(body.permissions ?? {}),
        inviteSentAt: new Date(),
      },
    });

    void sendMail({
      to: email,
      subject: `You are a co-host for ${webinar.title}`,
      html: `<p>You have been invited to co-host <strong>${webinar.title}</strong>.</p><p><a href="${env.WEB_ORIGIN}/admin/webinars/${webinar.id}">Open the host console</a></p><p>Sign in with this email address to accept.</p>`,
      text: [
        `You have been invited to co-host "${webinar.title}".`,
        '',
        `Open the host console: ${env.WEB_ORIGIN}/admin/webinars/${webinar.id}`,
        '',
        'Sign in with this email address to accept.',
      ].join('\n'),
    });

    res.status(201).json({ cohost: serialize(row) });
  })
);

/** PATCH /api/admin/cohosts/:id — change one co-host's permissions. */
adminCohostRouter.patch(
  '/cohosts/:id',
  asyncHandler(async (req, res) => {
    const body = updateCohostSchema.parse(req.body);

    const existing = await prisma.webinarCohost.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) throw notFound('Co-host not found');

    // Merge over what is already stored, so patching one permission does not
    // silently reset the other nine to their defaults.
    const merged = {
      ...resolvePermissions(existing.permissionsJson),
      ...(body.permissions ?? {}),
    };

    const row = await prisma.webinarCohost.update({
      where: { id: existing.id },
      data: {
        permissionsJson: JSON.stringify(merged),
        ...(body.name !== undefined ? { name: body.name } : {}),
      },
    });

    res.json({ cohost: serialize(row) });
  })
);

/**
 * DELETE /api/admin/cohosts/:id
 *
 * Removes a co-host. webinar.gg's "demote, do not remove" behaviour is modelled
 * by clearing every permission instead — the row survives so the audit trail
 * shows they were once a co-host.
 */
adminCohostRouter.delete(
  '/cohosts/:id',
  asyncHandler(async (req, res) => {
    const mode = String(req.query.mode ?? 'remove');

    const existing = await prisma.webinarCohost.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) throw notFound('Co-host not found');

    if (mode === 'demote') {
      const demoted: CohostPermissions = Object.fromEntries(
        COHOST_PERMISSION_KEYS.map((k) => [k, false])
      ) as unknown as CohostPermissions;

      const row = await prisma.webinarCohost.update({
        where: { id: existing.id },
        data: { permissionsJson: JSON.stringify(demoted) },
      });
      res.json({ cohost: serialize(row), demoted: true });
      return;
    }

    await prisma.webinarCohost.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  })
);

/**
 * PATCH /api/admin/:webinarId/cohost-policy
 *
 * The webinar-wide co-host policy: whether a co-host may start without the
 * host, and the default permission set for co-hosts with no override.
 */
adminCohostRouter.patch(
  '/:webinarId/cohost-policy',
  asyncHandler(async (req, res) => {
    const body = policySchema.parse(req.body);

    const webinar = await prisma.webinar.update({
      where: { id: req.params.webinarId },
      data: {
        ...(body.cohostStartWithoutHost !== undefined
          ? { cohostStartWithoutHost: body.cohostStartWithoutHost }
          : {}),
        ...(body.permissions !== undefined
          ? { cohostPermissionsJson: JSON.stringify(body.permissions) }
          : {}),
      },
      select: { cohostStartWithoutHost: true, cohostPermissionsJson: true },
    });

    res.json({
      policy: {
        cohostStartWithoutHost: webinar.cohostStartWithoutHost,
        permissions: resolvePermissions(webinar.cohostPermissionsJson),
      },
    });
  })
);

/**
 * GET /api/admin/:webinarId/cohost-policy/me
 *
 * What the signed-in user may do in this room. The client uses it to hide
 * controls rather than to enforce them — every socket handler re-checks.
 */
cohostPolicyRouter.get(
  '/:webinarId/cohost-policy/me',
  asyncHandler(async (req, res) => {
    const user = req.user!;

    const webinar = await prisma.webinar.findUnique({
      where: { id: req.params.webinarId },
      select: {
        hostId: true,
        cohostStartWithoutHost: true,
        cohostPermissionsJson: true,
        moderators: { where: { userId: user.id }, select: { userId: true } },
      },
    });
    if (!webinar) throw notFound('Webinar not found');

    // The owner and admins get everything, always.
    if (user.role === 'ADMIN' || webinar.hostId === user.id) {
      res.json({
        isOwner: true,
        permissions: Object.fromEntries(
          COHOST_PERMISSION_KEYS.map((k) => [k, true])
        ) as unknown as CohostPermissions,
      });
      return;
    }

    // A co-host is invited by email, often before they have an account, so the
    // row may still carry a null userId. Match on the address too, and backfill
    // the link so later lookups are a plain id match.
    const cohost = await prisma.webinarCohost.findFirst({
      where: {
        webinarId: req.params.webinarId,
        OR: [{ userId: user.id }, { email: user.email.toLowerCase() }],
      },
    });

    if (cohost) {
      if (!cohost.userId) {
        await prisma.webinarCohost.update({
          where: { id: cohost.id },
          data: { userId: user.id },
        });
      }
      const permissions = resolvePermissions(cohost.permissionsJson);
      // The webinar-wide policy can grant start/end even when the individual
      // row does not — that is what `cohostStartWithoutHost` means.
      if (webinar.cohostStartWithoutHost) permissions.startWebinar = true;
      res.json({ isOwner: false, isCohost: true, permissions });
      return;
    }

    // A plain moderator keeps the classic staff abilities.
    if (webinar.moderators.length > 0) {
      res.json({
        isOwner: false,
        isCohost: false,
        permissions: resolvePermissions(webinar.cohostPermissionsJson),
      });
      return;
    }

    res.json({
      isOwner: false,
      isCohost: false,
      permissions: Object.fromEntries(
        COHOST_PERMISSION_KEYS.map((k) => [k, false])
      ) as unknown as CohostPermissions,
    });
  })
);

async function hostEmail(hostId: string): Promise<string | null> {
  const host = await prisma.user.findUnique({
    where: { id: hostId },
    select: { email: true },
  });
  return host?.email ?? null;
}
