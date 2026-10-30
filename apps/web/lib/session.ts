/**
 * Scoped session storage.
 *
 * The console and the attendee flow are two different identities that can be
 * held by the same browser at the same time — a host testing their own webinar
 * is the obvious case, and it is exactly the case that used to break. Both
 * wrote their JWT to `localStorage['token']`, so registering as a participant
 * silently replaced the host's session: the console kept rendering the old
 * name from `localStorage['user']` while every request came back 403, and
 * nothing redirected to the sign-in page because a token *was* present.
 *
 * Each scope now owns its own keys, so one can never evict the other.
 *
 * The token is also checked for expiry on read. A JWT that has aged out is
 * indistinguishable from a valid one to `localStorage`, and treating it as
 * present is what produces a console that looks signed in but cannot load
 * anything. An expired token is reported as no session at all, which sends the
 * user to the sign-in page where they can actually do something about it.
 */

export type SessionScope = 'admin' | 'participant';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface Keys {
  token: string;
  user: string;
}

/**
 * The participant keys are the historical `token` / `user` names.
 *
 * They are kept as-is because a join link, a confirmation email and a room URL
 * all assume them, and because a participant session is the one that has to
 * survive a link opened on a device that has never seen this site. Only the
 * console moved.
 */
const KEYS: Record<SessionScope, Keys> = {
  admin: { token: 'nexa:admin:token', user: 'nexa:admin:user' },
  participant: { token: 'token', user: 'user' },
};

/** Fired when an admin request is rejected as unauthenticated. */
export const ADMIN_UNAUTHORIZED_EVENT = 'nexa:admin:unauthorized';

interface JwtClaims {
  sub?: string;
  exp?: number;
  iat?: number;
}

/**
 * Reads the claims out of a JWT without verifying it.
 *
 * Verification is the server's job — this only answers "has this token already
 * expired?", which is a question the client can settle locally and which saves
 * a guaranteed-to-fail round trip on every page load.
 */
export function decodeJwt(token: string): JwtClaims | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

/**
 * Whether a token is still usable.
 *
 * A 30-second skew is subtracted from the expiry so a token that is about to
 * lapse is treated as already gone. Otherwise a request can be issued with a
 * token that expires in flight, which surfaces as a random 401 in the middle of
 * a page rather than a clean redirect to sign-in.
 */
export function isTokenFresh(token: string | null | undefined): boolean {
  if (!token) return false;
  const claims = decodeJwt(token);
  if (!claims?.exp) return true; // No expiry claim: let the server decide.
  return claims.exp * 1000 - 30_000 > Date.now();
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Private mode and some embedded webviews throw on access.
    return null;
  }
}

export function getToken(scope: SessionScope): string | null {
  const store = storage();
  if (!store) return null;
  const token = store.getItem(KEYS[scope].token);
  if (!token) return null;
  if (!isTokenFresh(token)) {
    // Drop it rather than hand back something the server will reject.
    clearSession(scope);
    return null;
  }
  return token;
}

export function getUser(scope: SessionScope): SessionUser | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(KEYS[scope].user);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function writeSession(scope: SessionScope, token: string, user: SessionUser): void {
  const store = storage();
  if (!store) return;
  store.setItem(KEYS[scope].token, token);
  store.setItem(KEYS[scope].user, JSON.stringify(user));
}

export function clearSession(scope: SessionScope): void {
  const store = storage();
  if (!store) return;
  store.removeItem(KEYS[scope].token);
  store.removeItem(KEYS[scope].user);
}

/**
 * The JWT the room socket should authenticate with.
 *
 * A host walking into their own room has no participant session — they never
 * registered — so the console token is the correct fallback. Without it the
 * room page would bounce staff to the registration form for their own webinar.
 */
export function roomToken(): string | null {
  return getToken('participant') ?? getToken('admin');
}

/** Tells the console that its session is gone, so it can redirect. */
export function notifyAdminUnauthorized(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ADMIN_UNAUTHORIZED_EVENT));
}
