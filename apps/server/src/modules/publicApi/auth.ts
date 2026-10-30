import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../db/prisma.js';
import { unauthorized } from '../../middleware/error.js';

/** Tokens are prefixed so they are recognisable in a log or a leak scan. */
const TOKEN_PREFIX = 'nxl_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A fresh token. 32 bytes of entropy, prefixed. */
export function newToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
}

/**
 * Bearer-token auth for the public API.
 *
 * Deliberately separate from `requireAuth`: a JWT is a person's session and
 * expires in hours, an API token is a machine's credential and lives until it
 * is revoked. Conflating them would mean either sessions that never expire or
 * integrations that break every morning.
 *
 * The token is hashed before lookup, so a database dump does not hand an
 * attacker working credentials.
 */
export async function requireApiToken(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(unauthorized('An API token is required'));
  }

  const token = header.slice(7).trim();
  if (!token.startsWith(TOKEN_PREFIX)) {
    return next(unauthorized('Invalid API token'));
  }

  const row = await prisma.apiToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { owner: { select: { id: true, email: true, name: true, role: true } } },
  });

  if (!row || row.revokedAt) {
    return next(unauthorized('Invalid or revoked API token'));
  }

  // Recorded so a host can see which token is actually in use before revoking
  // one. Fire-and-forget: a failed write must not fail the request.
  void prisma.apiToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  req.user = {
    id: row.owner.id,
    email: row.owner.email,
    name: row.owner.name,
    role: row.owner.role as never,
  };
  (req as Request & { apiTokenId?: string }).apiTokenId = row.id;

  next();
}
