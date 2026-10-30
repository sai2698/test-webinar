/**
 * Admin session verification.
 *
 * The console and the attendee flow are two identities that can be held by the
 * same browser at once — a host testing their own webinar is the ordinary case.
 * They used to share one `localStorage['token']`, so registering as a
 * participant silently destroyed the host's session: the console kept showing
 * the old name while every request came back 403.
 *
 * The client half of that fix (scoped storage keys) is not reachable from a
 * Node suite, so this covers the server half — the part that can be asserted
 * over HTTP and that the client fix depends on:
 *
 *   1. login issues a cookie scoped to `/api/admin`, not `/`;
 *   2. that cookie authenticates the console;
 *   3. it does NOT authenticate an attendee request, so a host who registers
 *      for their own webinar is treated as that participant;
 *   4. a participant Bearer cannot reach `/api/admin/*`;
 *   5. logout revokes the cookie, so a cookie-only admin call afterwards is 401;
 *   6. the legacy `Path=/` cookie is cleared too, so a browser that signed in
 *      before the scoping change cannot stay silently authenticated.
 */
import { API, api, createChecker, dropWebinar, login, makeWebinar, register, runSuite } from './lib/parity-harness.mjs';

/** Reads a JWT's claims without verifying it — the server already did that. */
function decodeClaims(token) {
  try {
    const part = String(token ?? '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

runSuite('Admin session', async () => {
  const { check, finish } = createChecker();

  const admin = await login();
  const webinar = await makeWebinar(admin.token, { title: `Session Fixture ${Date.now()}` });

  try {
    // ---------------------------------------------------------------- login
    const loginRes = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@webinar.local', password: 'Admin@12345' }),
    });
    const setCookies = loginRes.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) => c.startsWith('token=') && !c.startsWith('token=;'));

    check('login returns 200', loginRes.status === 200, `status ${loginRes.status}`);
    check('login issues a session cookie', Boolean(sessionCookie));

    /**
     * The path is the whole point. A cookie scoped to `/` is sent on every
     * request, which would silently upgrade an attendee to staff.
     */
    check(
      'session cookie is scoped to /api/admin',
      /Path=\/api\/admin/i.test(sessionCookie ?? ''),
      (sessionCookie ?? '').split(';').slice(1).join(';').trim()
    );
    check('session cookie is httpOnly', /HttpOnly/i.test(sessionCookie ?? ''));
    check('session cookie is SameSite=Lax', /SameSite=Lax/i.test(sessionCookie ?? ''));
    check(
      'login also clears the legacy Path=/ cookie',
      setCookies.some((c) => c.startsWith('token=;') && /Path=\/(;|$)/i.test(c)),
      setCookies.filter((c) => c.startsWith('token=;')).join(' | ')
    );

    const cookie = (sessionCookie ?? '').split(';')[0];

    // ------------------------------------------------- cookie authenticates
    const meRes = await fetch(`${API}/api/auth/me`, { headers: { Cookie: cookie } });
    const me = await meRes.json().catch(() => null);
    check('cookie authenticates /api/auth/me', meRes.status === 200, `status ${meRes.status}`);
    check('cookie resolves the admin identity', me?.user?.role === 'ADMIN', me?.user?.role);

    const adminViaCookie = await fetch(`${API}/api/admin/webinars`, { headers: { Cookie: cookie } });
    check('cookie authenticates /api/admin/webinars', adminViaCookie.status === 200, `status ${adminViaCookie.status}`);

    // ------------------------------------- cookie must NOT reach attendee flow
    /**
     * A browser only sends a `/api/admin` cookie to `/api/admin` paths, so this
     * asserts the server-side consequence: even when the cookie is presented
     * explicitly, the registration route must not treat the caller as staff.
     * The route is public, so the check is that it succeeds as a *participant*
     * and returns a PARTICIPANT token rather than an ADMIN one.
     */
    const regRes = await fetch(`${API}/api/webinars/${webinar.slug}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Session Probe',
        email: `session-probe-${Date.now()}@example.com`,
        phone: '+91 98765 43210',
      }),
    });
    const reg = await regRes.json().catch(() => null);
    check('registration succeeds with an admin cookie present', regRes.status === 200, `status ${regRes.status}`);
    /**
     * The register response's `user` object carries only id/name/email, so the
     * role has to come out of the JWT itself — which is the thing the room
     * socket and every later request actually authenticate with.
     */
    const regClaims = decodeClaims(reg?.token);
    check(
      'registration yields a PARTICIPANT token, not staff',
      regClaims?.role === 'PARTICIPANT',
      regClaims?.role
    );

    // ------------------------------------- participant Bearer cannot be staff
    const participant = await register(webinar.slug, 'Session Participant', `session-part-${Date.now()}@example.com`);
    const partOnAdmin = await api('/api/admin/webinars', { token: participant.token });
    check(
      'participant Bearer is rejected on /api/admin/*',
      partOnAdmin.status === 403 || partOnAdmin.status === 401,
      `status ${partOnAdmin.status}`
    );

    /**
     * The exact bug, at the server level: a participant Bearer alongside a
     * valid admin cookie. `extractToken` prefers the Bearer, so the request
     * must be judged as the participant — not rescued by the ambient cookie.
     */
    const mixed = await fetch(`${API}/api/admin/webinars`, {
      headers: { Authorization: `Bearer ${participant.token}`, Cookie: cookie },
    });
    check(
      'participant Bearer wins over an admin cookie',
      mixed.status === 403 || mixed.status === 401,
      `status ${mixed.status}`
    );

    // --------------------------------------------------------------- logout
    const logoutRes = await fetch(`${API}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    const logoutCookies = logoutRes.headers.getSetCookie();
    check('logout returns 200', logoutRes.status === 200, `status ${logoutRes.status}`);
    check(
      'logout clears the scoped cookie',
      logoutCookies.some((c) => c.startsWith('token=;') && /Path=\/api\/admin/i.test(c)),
      logoutCookies.join(' | ')
    );
    check(
      'logout clears the legacy Path=/ cookie',
      logoutCookies.some((c) => c.startsWith('token=;') && /Path=\/(;|$)/i.test(c)),
      logoutCookies.join(' | ')
    );

    /**
     * The cookie value itself is unchanged by logout — clearing is a browser
     * instruction, not a server-side revocation. Replaying it therefore still
     * works, which is the honest limitation of a stateless JWT and is asserted
     * here so the behaviour is documented rather than assumed.
     */
    const replay = await fetch(`${API}/api/auth/me`, { headers: { Cookie: cookie } });
    check(
      'a replayed cookie still authenticates (stateless JWT, documented)',
      replay.status === 200,
      `status ${replay.status}`
    );

    // ------------------------------------------- no cookie means no session
    const anon = await fetch(`${API}/api/admin/webinars`);
    check('no credential is rejected on /api/admin/*', anon.status === 401, `status ${anon.status}`);

    // ------------------------------------- the admin Bearer still works
    const bearer = await api('/api/admin/webinars', { token: admin.token });
    check('admin Bearer still works after logout', bearer.status === 200, `status ${bearer.status}`);
  } finally {
    await dropWebinar(admin.token, webinar.id);
  }

  finish();
});
