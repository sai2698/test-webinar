import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const unauthorized = (m = 'Not authenticated') => new HttpError(401, m);
export const forbidden = (m = 'Not allowed') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

/** Wraps an async route handler so rejected promises reach the error middleware. */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  /**
   * The public API documents a `{ success, error }` envelope for every
   * response, success or failure. Errors thrown inside `/api/v1` reach this
   * handler, so without this branch a machine client would get the internal
   * `{ error }` shape for a 401 and the documented shape for everything else —
   * and would have to special-case the one case it most needs to handle.
   */
  const isPublicApi = req.path.startsWith('/api/v1/');

  if (err instanceof ZodError) {
    if (isPublicApi) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: err.flatten().fieldErrors,
      });
      return;
    }
    res.status(400).json({
      error: 'Validation failed',
      details: err.flatten().fieldErrors,
    });
    return;
  }

  if (err instanceof HttpError) {
    if (isPublicApi) {
      res.status(err.status).json({ success: false, error: err.message, details: err.details });
      return;
    }
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }

  logger.error('Unhandled error', err);
  if (isPublicApi) {
    res.status(500).json({ success: false, error: 'Internal server error' });
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Route not found' });
}
