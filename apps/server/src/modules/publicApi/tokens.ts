import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../middleware/error.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { hashToken, newToken } from './auth.js';
import type { ApiTokenSummary } from '@webinar/shared';

export const adminApiTokenRouter = Router();

adminApiTokenRouter.use(requireAuth, requireRole('ADMIN', 'HOST'));

const createSchema = z.object({
  name: z.string().min(1).max(80),
});

/** GET /api/admin/api-tokens */
adminApiTokenRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await prisma.apiToken.findMany({
      where: { ownerId: req.user!.id },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      tokens: rows.map(
        (t): ApiTokenSummary => ({
          id: t.id,
          name: t.name,
          prefix: t.prefix,
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          revokedAt: t.revokedAt?.toISOString() ?? null,
          createdAt: t.createdAt.toISOString(),
        })
      ),
    });
  })
);

/**
 * POST /api/admin/api-tokens
 *
 * The plaintext token is returned exactly once, here. Only its hash is stored,
 * so it genuinely cannot be recovered — which is the point, and also why the
 * UI has to make the host copy it before dismissing the dialog.
 */
adminApiTokenRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);

    const token = newToken();

    const row = await prisma.apiToken.create({
      data: {
        ownerId: req.user!.id,
        name: body.name,
        tokenHash: hashToken(token),
        // Enough to identify the token in a list without being usable.
        prefix: token.slice(0, 12),
      },
    });

    res.status(201).json({
      token: {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: row.createdAt.toISOString(),
      },
      /** Shown once. It cannot be retrieved again. */
      plaintext: token,
    });
  })
);

/** DELETE /api/admin/api-tokens/:id — revoke. The row survives for the audit. */
adminApiTokenRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.apiToken.findFirst({
      where: { id: req.params.id, ownerId: req.user!.id },
    });
    if (!existing) throw notFound('Token not found');

    await prisma.apiToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    res.json({ ok: true });
  })
);
