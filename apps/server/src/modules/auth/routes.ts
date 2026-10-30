import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, unauthorized } from '../../middleware/error.js';
import { requireAuth, signToken } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { HttpError } from '../../middleware/error.js';
import { isProd } from '../../config/env.js';
import type { Role } from '@webinar/shared';

export const authRouter = Router();

/**
 * How long a console session lasts.
 *
 * Kept in step with the JWT's own lifetime: a cookie that outlives its token
 * is worse than no cookie, because the browser keeps sending a credential the
 * server has already rejected.
 */
const ADMIN_COOKIE_MS = 7 * 24 * 60 * 60 * 1000;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const ip = req.ip ?? 'unknown';
    const limit = authLimiter(ip);
    if (!limit.allowed) {
      throw new HttpError(429, 'Too many login attempts. Try again shortly.');
    }

    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user?.passwordHash) throw unauthorized('Invalid email or password');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw unauthorized('Invalid email or password');

    // A correct password proves this is not a guessing attempt, so the
    // brute-force budget is cleared. Without this, a user who signs in from a
    // few tabs — or a test suite that authenticates once per scenario — would
    // be locked out by their own successful logins.
    authLimiter.reset(ip);

    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
    });

    /**
     * The cookie is scoped to `/api/admin`.
     *
     * It exists so a console page load is authenticated before any JavaScript
     * runs, and so a refresh cannot lose the session. Scoping it to the admin
     * prefix keeps it out of every attendee request: a host who registers for
     * their own webinar must be treated as that participant, not silently
     * upgraded to staff by an ambient cookie. The attendee flow carries its
     * own Bearer token and never needs this.
     *
     * The legacy `/` cookie is cleared first. Earlier builds issued one, and a
     * browser that signed in before this deploy still holds it — leaving it in
     * place would mean the new scoped cookie is not the only credential in
     * play, and the old one would keep authenticating attendee requests as
     * staff.
     */
    res.clearCookie('token', { path: '/' });
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/api/admin',
      maxAge: ADMIN_COOKIE_MS,
    });

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  })
);

/**
 * Revokes the session cookie.
 *
 * The `path` must match the one used to set it — a cookie is identified by
 * name *and* path, so clearing `/` leaves the real one untouched and the
 * browser keeps authenticating with it.
 *
 * Both paths are cleared. The `/` variant is what earlier builds issued, and a
 * browser that signed in before this deploy still holds one; clearing only the
 * scoped path would leave that older cookie authenticating every request, so
 * the user would appear to sign out and then silently still be signed in.
 */
authRouter.post('/logout', (_req, res) => {
  res.clearCookie('token', { path: '/api/admin' });
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, name: true, email: true, role: true, phone: true },
    });
    if (!user) throw unauthorized();
    res.json({ user });
  })
);
