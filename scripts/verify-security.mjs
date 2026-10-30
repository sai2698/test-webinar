// Verifies the access-control features end to end.
//
//   passcode     : required to register, wrong value rejected, right value accepted
//   inviteOnly   : guest join is refused, registration still works
//   requireSignIn: an anonymous registration is refused
//   projection   : passcodeRequired is public, the passcode value never is
//
// The suite creates its own throwaway webinar so it cannot disturb the demo.
// Run with the API on :4000.
import { io } from 'socket.io-client';

const API = 'http://localhost:4000';
const ADMIN = { email: 'admin@webinar.local', password: 'Admin@12345' };

async function json(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

const run = async () => {
  const stamp = Date.now();

  // ── auth ────────────────────────────────────────────────────
  const login = await json('/api/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) });
  check('admin login', login.status === 200 && Boolean(login.body.token), `status ${login.status}`);
  const auth = { Authorization: `Bearer ${login.body.token}` };

  // ── create a throwaway webinar ──────────────────────────────
  // Only the passcode is on at first: the other two gates would block the
  // registration this suite needs in order to obtain a join token.
  const slug = `verify-security-${stamp}`;
  const created = await json('/api/admin/webinars', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      title: 'Verify: security gates',
      slug,
      description: 'Throwaway webinar created by verify-security.mjs',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      settings: {
        passcode: 'open-sesame',
        requireRegistration: false,
      },
    }),
  });
  check('create a webinar with a passcode', created.status === 201, `status ${created.status}`);
  const webinarId = created.body.webinar?.id;
  check('the webinar has an id', Boolean(webinarId), webinarId);
  if (!webinarId) return;

  // ── the public projection ───────────────────────────────────
  const pub = await json(`/api/webinars/${slug}/public`);
  check('the public page loads', pub.status === 200, `status ${pub.status}`);
  const settings = pub.body.webinar?.settings ?? {};
  check('passcodeRequired is public', settings.passcodeRequired === true);
  check('inviteOnly is public', settings.inviteOnly === false);
  check('requireSignIn is public', settings.requireSignIn === false);
  check(
    'the passcode value is never serialised',
    !JSON.stringify(pub.body).includes('open-sesame')
  );

  // ── passcode enforcement on register ────────────────────────
  const noPass = await json(`/api/webinars/${slug}/register`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'No Pass',
      email: `nopass-${stamp}@example.com`,
      phone: '+91 98765 43210',
    }),
  });
  check('register without a passcode is refused', noPass.status === 400, `status ${noPass.status}`);
  check(
    'the error names the passcode',
    /passcode/i.test(noPass.body?.error ?? ''),
    noPass.body?.error
  );

  const wrongPass = await json(`/api/webinars/${slug}/register`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Wrong Pass',
      email: `wrongpass-${stamp}@example.com`,
      phone: '+91 98765 43210',
      passcode: 'not-the-passcode',
    }),
  });
  check('a wrong passcode is refused', wrongPass.status === 400, `status ${wrongPass.status}`);
  check(
    'the error says the passcode is wrong',
    /incorrect/i.test(wrongPass.body?.error ?? ''),
    wrongPass.body?.error
  );

  const rightPass = await json(`/api/webinars/${slug}/register`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Right Pass',
      email: `rightpass-${stamp}@example.com`,
      phone: '+91 98765 43210',
      passcode: 'open-sesame',
    }),
  });
  check(
    'the right passcode registers',
    rightPass.status === 200,
    `status ${rightPass.status} ${rightPass.body?.error ?? ''}`
  );
  const joinToken = rightPass.body?.registration?.joinToken;
  check('registration returns a join token', Boolean(joinToken));

  // ── join-info advertises the requirement ────────────────────
  const joinInfo = await json(`/api/webinars/${slug}/join-info?token=${joinToken}`);
  check('join-info resolves the token', joinInfo.status === 200, `status ${joinInfo.status}`);
  check(
    'join-info advertises the passcode requirement',
    joinInfo.body?.passcodeRequired === true,
    JSON.stringify(joinInfo.body?.passcodeRequired)
  );

  // ── claim also enforces the passcode ────────────────────────
  const claimNoPass = await json(`/api/webinars/${slug}/claim`, {
    method: 'POST',
    body: JSON.stringify({ token: joinToken, name: 'Claimer', phone: '+91 90000 11111' }),
  });
  check('claim without a passcode is refused', claimNoPass.status === 400, `status ${claimNoPass.status}`);

  const claimOk = await json(`/api/webinars/${slug}/claim`, {
    method: 'POST',
    body: JSON.stringify({
      token: joinToken,
      name: 'Claimer',
      phone: '+91 90000 11111',
      passcode: 'open-sesame',
    }),
  });
  check(
    'claim with the passcode returns a JWT',
    claimOk.status === 200 && Boolean(claimOk.body?.token),
    `status ${claimOk.status}`
  );

  // ── turn on requireSignIn ───────────────────────────────────
  // One gate at a time. `assertAccess` evaluates requireSignIn, then
  // inviteOnly, then passcode, and each one short-circuits the next — so
  // enabling two at once only ever proves the first one works.
  const gated = await json(`/api/admin/webinars/${webinarId}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ settings: { requireSignIn: true } }),
  });
  check('the extra gates can be enabled', gated.status === 200, `status ${gated.status}`);

  const gatedPub = await json(`/api/webinars/${slug}/public`);
  check(
    'requireSignIn is now public',
    gatedPub.body?.webinar?.settings?.requireSignIn === true,
    JSON.stringify(gatedPub.body?.webinar?.settings?.requireSignIn)
  );

  // requireSignIn is checked first, so an anonymous caller is told to sign in
  // even when they also supplied the right passcode.
  const anon = await json(`/api/webinars/${slug}/register`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Anon',
      email: `anon-${stamp}@example.com`,
      phone: '+91 98765 43210',
      passcode: 'open-sesame',
    }),
  });
  check('requireSignIn refuses an anonymous registration', anon.status === 400, `status ${anon.status}`);
  check(
    'the error asks the caller to sign in',
    /sign in/i.test(anon.body?.error ?? ''),
    anon.body?.error
  );

  // A signed-in caller with the right passcode gets through. The admin account
  // is a signed-in user, which is all this rule cares about.
  const signedIn = await json(`/api/webinars/${slug}/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'Signed In',
      email: `signedin-${stamp}@example.com`,
      phone: '+91 98765 43210',
      passcode: 'open-sesame',
    }),
  });
  check(
    'a signed-in caller with the right passcode registers',
    signedIn.status === 200,
    `status ${signedIn.status} ${signedIn.body?.error ?? ''}`
  );

  // ── inviteOnly blocks guest join ────────────────────────────
  // requireSignIn is checked first, so it has to come off before the
  // invite-only rule can be observed on its own.
  await json(`/api/admin/webinars/${webinarId}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ settings: { requireSignIn: false, inviteOnly: true } }),
  });

  const invitePub = await json(`/api/webinars/${slug}/public`);
  check(
    'inviteOnly is now public',
    invitePub.body?.webinar?.settings?.inviteOnly === true,
    JSON.stringify(invitePub.body?.webinar?.settings?.inviteOnly)
  );

  // The invite-only rule is enforced on the registration path too, not just
  // the guest path — otherwise a walk-in could simply register instead.
  const uninvited = await json(`/api/webinars/${slug}/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'Uninvited',
      email: `uninvited-${stamp}@example.com`,
      phone: '+91 98765 43210',
      passcode: 'open-sesame',
    }),
  });
  check(
    'inviteOnly refuses an uninvited registration',
    uninvited.status === 403,
    `status ${uninvited.status} ${uninvited.body?.error ?? ''}`
  );
  check(
    'the registration error says invite-only',
    /invite-only/i.test(uninvited.body?.error ?? ''),
    uninvited.body?.error
  );

  const guest = await json(`/api/webinars/${slug}/guest`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Walk In', passcode: 'open-sesame' }),
  });
  check('inviteOnly refuses a guest join', guest.status === 400, `status ${guest.status}`);
  check(
    'the error says invite-only',
    /invite-only/i.test(guest.body?.error ?? ''),
    guest.body?.error
  );

  // ── the socket join still works for a registered attendee ───
  const socket = io(API, { auth: { token: claimOk.body.token }, transports: ['websocket'] });
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 8000);
  });
  const joinAck = await new Promise((resolve) =>
    socket.emit('join', { slug, token: claimOk.body.token }, resolve)
  );
  check('a registered attendee can join the room', joinAck?.ok === true, joinAck?.error ?? '');
  socket.disconnect();

  // ── relaxing the gates re-opens the webinar ─────────────────
  const relaxed = await json(`/api/admin/webinars/${webinarId}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({
      settings: { passcode: '', inviteOnly: false, requireSignIn: false },
    }),
  });
  check('the gates can be relaxed', relaxed.status === 200, `status ${relaxed.status}`);

  const afterRelax = await json(`/api/webinars/${slug}/public`);
  check(
    'passcodeRequired clears when the passcode is removed',
    afterRelax.body?.webinar?.settings?.passcodeRequired === false,
    JSON.stringify(afterRelax.body?.webinar?.settings?.passcodeRequired)
  );

  const openRegister = await json(`/api/webinars/${slug}/register`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Open Caller',
      email: `open-${stamp}@example.com`,
      phone: '+91 98765 43210',
    }),
  });
  check(
    'registration works once the gates are off',
    openRegister.status === 200,
    `status ${openRegister.status} ${openRegister.body?.error ?? ''}`
  );

  // ── cleanup ─────────────────────────────────────────────────
  const del = await json(`/api/admin/webinars/${webinarId}`, { method: 'DELETE', headers: auth });
  check('the throwaway webinar is deleted', del.status === 200, `status ${del.status}`);

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
};

run().catch((err) => {
  console.error('\nFATAL:', err);
  process.exitCode = 1;
});
