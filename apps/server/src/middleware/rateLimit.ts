/**
 * Minimal in-memory rate limiter (fixed window).
 *
 * Production note: swap this for Redis-backed limiting when running more than
 * one server instance — the interface is intentionally tiny so it is easy to
 * replace.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
}

export function rateLimit({ windowMs, max, keyPrefix = 'rl' }: RateLimitOptions) {
  const limiter = (key: string): { allowed: boolean; retryAfterMs: number } => {
    const now = Date.now();
    const id = `${keyPrefix}:${key}`;
    const bucket = buckets.get(id);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(id, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  };

  /**
   * Forgets a key's history.
   *
   * Used by the login limiter to clear the bucket after a *successful* sign-in.
   * The limiter exists to slow down password guessing, and a correct password
   * is proof that no guessing is happening — counting it would lock out a
   * legitimate user who simply signs in from several tabs, or a test suite
   * that authenticates once per scenario.
   */
  limiter.reset = (key: string) => {
    buckets.delete(`${keyPrefix}:${key}`);
  };

  return limiter;
}

// Periodically drop expired buckets so the map cannot grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref?.();

export const chatLimiter = rateLimit({ windowMs: 1000, max: 2, keyPrefix: 'chat' });
export const handLimiter = rateLimit({ windowMs: 5000, max: 3, keyPrefix: 'hand' });
export const quizLimiter = rateLimit({ windowMs: 1000, max: 3, keyPrefix: 'quiz' });
/** Asking is deliberate, so it gets the same budget as a quiz answer. */
export const qaLimiter = rateLimit({ windowMs: 1000, max: 3, keyPrefix: 'qa' });
/** Upvoting is a cheap toggle people click repeatedly — a wider bucket. */
export const qaVoteLimiter = rateLimit({ windowMs: 1000, max: 10, keyPrefix: 'qavote' });
export const authLimiter = rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'auth' });
