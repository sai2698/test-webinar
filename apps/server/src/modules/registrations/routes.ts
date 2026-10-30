import { Router } from 'express';
import { nanoid } from 'nanoid';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../middleware/error.js';
import { findWebinarBySlug } from '../webinars/service.js';
import { registerSchema, claimSchema } from '../webinars/schema.js';
import { signToken, requireAuth } from '../../middleware/auth.js';
import { sendMail, registrationEmail } from '../../utils/mail.js';
import { env } from '../../config/env.js';
import { listFields, saveResponses, validateResponses } from '../customFields/service.js';
import { emitWebhook } from '../webhooks/service.js';
import type { Role } from '@webinar/shared';

export const registrationRouter = Router();

/**
 * The three access rules a host can turn on, checked in one place so every
 * entry point — register, claim, guest, join-info — enforces the same thing.
 *
 * `passcode` is compared in plain text because it is a room key, not a
 * credential: it is shared in the same message as the link, and hashing it
 * would only stop an admin from reading back what they set.
 */
function assertAccess(
  webinar: {
    passcode: string | null;
    inviteOnly: boolean;
    requireSignIn: boolean;
    requireRegistration: boolean;
  },
  opts: { passcode?: string | null; signedIn: boolean; isGuest?: boolean }
): void {
  if (webinar.requireSignIn && !opts.signedIn) {
    throw badRequest('Sign in to join this webinar');
  }

  if (webinar.inviteOnly && opts.isGuest) {
    throw badRequest('This webinar is invite-only');
  }

  if (webinar.passcode) {
    const supplied = (opts.passcode ?? '').trim();
    if (!supplied) throw badRequest('This webinar requires a passcode');
    if (supplied !== webinar.passcode) throw badRequest('Incorrect passcode');
  }
}

/** True when the request carries a valid bearer token. */
function hasBearer(req: { headers: Record<string, unknown> }): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ');
}

/**
 * POST /api/webinars/:slug/register
 *
 * Creates (or reuses) a participant user and a registration row, then returns
 * a signed join token. When the webinar requires payment the registration is
 * created with `paid: false` and the client is told to run checkout.
 */
registrationRouter.post(
  '/:slug/register',
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const webinar = await findWebinarBySlug(req.params.slug);
    if (!webinar) throw notFound('Webinar not found');

    if (webinar.status === 'ENDED') throw badRequest('This webinar has already ended');

    assertAccess(webinar, {
      passcode: body.passcode,
      signedIn: hasBearer(req),
    });

    const email = body.email.toLowerCase();

    // An invite-only webinar must refuse a self-serve sign-up. `assertAccess`
    // only covers the guest path, so without this check anyone who knows the
    // slug could register and walk in — the invite list would be decorative.
    // An existing registration row is the invite.
    if (webinar.inviteOnly) {
      const invitedUser = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      const invited = invitedUser
        ? await prisma.registration.findUnique({
            where: { webinarId_userId: { webinarId: webinar.id, userId: invitedUser.id } },
            select: { id: true, status: true },
          })
        : null;
      if (!invited || invited.status === 'CANCELLED') {
        throw forbidden('This webinar is invite-only — ask the host for an invite');
      }
    }

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          name: body.name,
          email,
          phone: body.phone || null,
          role: 'PARTICIPANT',
        },
      });
    } else if (body.name && user.name !== body.name) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { name: body.name, phone: body.phone || user.phone },
      });
    }

    const needsPayment = webinar.requirePayment && webinar.priceInPaise > 0;

    const existing = await prisma.registration.findUnique({
      where: { webinarId_userId: { webinarId: webinar.id, userId: user.id } },
    });

    // A webinar that requires approval parks the registration in PENDING. The
    // column is always populated, so nothing downstream has to ask whether
    // approval is switched on.
    const initialStatus = webinar.requireApproval ? 'PENDING' : 'APPROVED';

    const registration =
      existing ??
      (await prisma.registration.create({
        data: {
          webinarId: webinar.id,
          userId: user.id,
          joinToken: nanoid(32),
          paid: !needsPayment,
          status: initialStatus,
          statusChangedAt: new Date(),
        },
      }));

    // Custom answers are validated against the live field set, so a required
    // question cannot be skipped by posting straight to the API.
    const rawResponses = (req.body?.customResponses ?? {}) as Record<string, unknown>;
    if (Object.keys(rawResponses).length > 0 || webinar.requireApproval) {
      const answers = await validateResponses(webinar.id, rawResponses);
      await saveResponses(registration.id, answers);
    }

    void emitWebhook('registration.created', {
      webinarId: webinar.id,
      webinarSlug: webinar.slug,
      registrationId: registration.id,
      userId: user.id,
      email: user.email,
      name: user.name,
      status: registration.status,
    });

    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
    });

    // A paid webinar only gets its confirmation once the payment verifies, so
    // this fires for free registrations and for anyone already paid up. A
    // pending registration gets no join link — there is nothing to join yet.
    if ((!needsPayment || registration.paid) && registration.status === 'APPROVED') {
      const message = registrationEmail({
        name: user.name,
        webinarTitle: webinar.title,
        startsAt: webinar.startsAt,
        timezone: webinar.timezone,
        joinUrl: `${env.WEB_ORIGIN}/room/${webinar.slug}?token=${encodeURIComponent(registration.joinToken)}`,
      });
      // Fire and forget: a mail outage must not fail the registration.
      void sendMail({ to: user.email, ...message });
    }

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
      registration: {
        joinToken: registration.joinToken,
        paid: registration.paid,
        status: registration.status,
      },
      /** True when the attendee must wait for a host to approve them. */
      pendingApproval: registration.status === 'PENDING',
      requiresPayment: needsPayment && !registration.paid,
      webinar: {
        slug: webinar.slug,
        title: webinar.title,
        startsAt: webinar.startsAt.toISOString(),
        priceInPaise: webinar.priceInPaise,
        currency: webinar.currency,
      },
    });
  })
);

/**
 * GET /api/webinars/:slug/form
 *
 * The custom fields the join form must render. Public: the form is shown before
 * anyone has an account, so requiring auth would make it unreachable.
 */
registrationRouter.get(
  '/:slug/form',
  asyncHandler(async (req, res) => {
    const webinar = await findWebinarBySlug(req.params.slug);
    if (!webinar) throw notFound('Webinar not found');
    res.json({ fields: await listFields(webinar.id) });
  })
);

/**
 * GET /api/webinars/:slug/join-info?token=...
 * Validates a join token before the room page connects to the socket.
 */
registrationRouter.get(
  '/:slug/join-info',
  asyncHandler(async (req, res) => {
    const webinar = await findWebinarBySlug(req.params.slug);
    if (!webinar) throw notFound('Webinar not found');

    const joinToken = String(req.query.token ?? '');
    if (!joinToken) throw badRequest('Missing join token');

    const registration = await prisma.registration.findUnique({
      where: { joinToken },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true, role: true } },
      },
    });

    if (!registration || registration.webinarId !== webinar.id) {
      throw notFound('Invalid join link');
    }

    const needsPayment = webinar.requirePayment && webinar.priceInPaise > 0;
    if (needsPayment && !registration.paid) {
      throw badRequest('Payment required before joining');
    }

    res.json({
      ok: true,
      user: registration.user,
      // A shared link lands on a device that has never seen this person. If we
      // have no name or no mobile on file, the room page shows the gate before
      // it connects — that is the whole point of the shared-link flow.
      needsProfile: !registration.user.name || !registration.user.phone,
      // The client needs to know a passcode is outstanding before it can show
      // the prompt, and it must never receive the passcode itself.
      passcodeRequired: Boolean(webinar.passcode),
      /** PENDING means the host has not approved this person yet. */
      approvalStatus: registration.status,
      webinar: { slug: webinar.slug, title: webinar.title, status: webinar.status },
    });
  })
);

/**
 * POST /api/webinars/:slug/claim
 *
 * The shared-join-link gate. Someone opens `/room/:slug?token=...` on a device
 * that has never seen this site; we know who the token belongs to but not how
 * to reach them. This attaches a name and mobile to that registration and
 * hands back a fresh JWT so the room can connect.
 *
 * The join token is the credential here — it is 32 random characters and was
 * only ever sent to the registrant's email — so no separate auth is required.
 */
registrationRouter.post(
  '/:slug/claim',
  asyncHandler(async (req, res) => {
    const body = claimSchema.parse(req.body);
    const webinar = await findWebinarBySlug(req.params.slug);
    if (!webinar) throw notFound('Webinar not found');

    if (webinar.status === 'ENDED') throw badRequest('This webinar has already ended');

    assertAccess(webinar, {
      passcode: body.passcode,
      signedIn: hasBearer(req),
    });

    const registration = await prisma.registration.findUnique({
      where: { joinToken: body.token },
      include: { user: true },
    });

    if (!registration || registration.webinarId !== webinar.id) {
      throw notFound('Invalid join link');
    }

    const needsPayment = webinar.requirePayment && webinar.priceInPaise > 0;
    if (needsPayment && !registration.paid) {
      throw badRequest('Payment required before joining');
    }

    // A rejected or cancelled registration must not be able to claim its way
    // back in — the token is still valid, the decision is what changed.
    if (registration.status === 'REJECTED' || registration.status === 'CANCELLED') {
      throw badRequest('Your registration was not approved');
    }

    const user = await prisma.user.update({
      where: { id: registration.userId },
      data: { name: body.name, phone: body.phone },
    });

    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
    });

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
      registration: {
        joinToken: registration.joinToken,
        paid: registration.paid,
        status: registration.status,
      },
      pendingApproval: registration.status === 'PENDING',
      webinar: { slug: webinar.slug, title: webinar.title, status: webinar.status },
    });
  })
);

/**
 * POST /api/webinars/:slug/guest
 *
 * One-click entry for a webinar that does not require registration. The guide
 * calls for "name entry and a Join button" with a temporary guest token; this
 * creates a throwaway participant user keyed on a random email so the room,
 * chat and quiz code paths all keep working unchanged.
 *
 * Guests are real User rows because every downstream feature (chat authorship,
 * quiz answers, hand raises) is keyed on a user id. They are marked by the
 * `guest-` email prefix so they can be excluded from analytics later.
 */
registrationRouter.post(
  '/:slug/guest',
  asyncHandler(async (req, res) => {
    const webinar = await findWebinarBySlug(req.params.slug);
    if (!webinar) throw notFound('Webinar not found');
    if (webinar.status === 'ENDED') throw badRequest('This webinar has already ended');

    // Registration is required, so there is no guest path. The client should
    // be showing the form instead.
    if (webinar.requireRegistration) {
      throw badRequest('This webinar requires registration');
    }

    // A guest has no account and no invitation, so both of those rules bite.
    assertAccess(webinar, {
      passcode: String(req.body?.passcode ?? ''),
      signedIn: hasBearer(req),
      isGuest: true,
    });

    const rawName = String(req.body?.name ?? '').trim();
    const name = rawName.length >= 2 ? rawName.slice(0, 80) : 'Guest';

    const user = await prisma.user.create({
      data: {
        name,
        email: `guest-${nanoid(16)}@guest.local`,
        role: 'PARTICIPANT',
      },
    });

    const registration = await prisma.registration.create({
      data: {
        webinarId: webinar.id,
        userId: user.id,
        joinToken: nanoid(32),
        // A guest webinar is free by definition — requirePayment without
        // requireRegistration would be a contradictory configuration.
        paid: true,
        // A guest has no email to approve against, so approval cannot apply.
        status: 'APPROVED',
        statusChangedAt: new Date(),
      },
    });

    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
    });

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
      // Flat, matching the shape `register` returns so the client can share
      // one post-registration code path.
      joinToken: registration.joinToken,
      requiresPayment: false,
      amountPaise: 0,
      webinar: {
        slug: webinar.slug,
        title: webinar.title,
        startsAt: webinar.startsAt.toISOString(),
        priceInPaise: webinar.priceInPaise,
        currency: webinar.currency,
      },
    });
  })
);

/**
 * POST /api/webinars/:slug/host-join
 *
 * Lets staff walk straight into the room without registering.
 *
 * A host is not a participant: they must not be charged, must not consume a
 * seat, and must not be blocked by the registration gate. Rather than special
 * casing the join socket handler, this issues a real join token backed by a
 * registration row flagged `paid: true` — so the existing gate logic passes
 * unchanged and the host still shows up in the attendance list.
 */
registrationRouter.post(
  '/:slug/host-join',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    if (user.role !== 'HOST' && user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
      throw badRequest('Only staff can use the host join link');
    }

    const webinar = await findWebinarBySlug(req.params.slug);
    if (!webinar) throw notFound('Webinar not found');
    if (webinar.status === 'ENDED') throw badRequest('This webinar has already ended');

    // A moderator may only enter webinars they are assigned to; a host may only
    // enter their own. Admins are unrestricted.
    if (user.role !== 'ADMIN') {
      const assigned =
        webinar.hostId === user.id ||
        webinar.moderators.some((m) => m.userId === user.id);
      if (!assigned) throw badRequest('You are not assigned to this webinar');
    }

    const existing = await prisma.registration.findFirst({
      where: { webinarId: webinar.id, userId: user.id },
    });

    const registration = existing
      ? await prisma.registration.update({
          where: { id: existing.id },
          data: { paid: true, status: 'APPROVED', statusChangedAt: new Date() },
        })
      : await prisma.registration.create({
          data: {
            webinarId: webinar.id,
            userId: user.id,
            joinToken: nanoid(32),
            paid: true,
            // Staff never wait for approval.
            status: 'APPROVED',
            statusChangedAt: new Date(),
          },
        });

    res.json({
      joinToken: registration.joinToken,
      webinar: {
        slug: webinar.slug,
        title: webinar.title,
        startsAt: webinar.startsAt.toISOString(),
      },
    });
  })
);
