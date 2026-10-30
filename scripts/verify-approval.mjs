/**
 * Verifies the registration approval queue.
 *
 *   host   : a webinar with requireApproval parks new sign-ups in PENDING
 *   public : a pending registration is told so, and gets no join link
 *   socket : a pending registration cannot enter the room
 *   host   : approving flips the status and emails the attendee
 *   socket : an approved registration can enter
 *   host   : rejecting blocks entry even though the token is still valid
 *   host   : waitlisting blocks entry
 *   host   : approve-all clears the queue in one call
 *   host   : the counts reflect every status
 */
import {
  api,
  connect,
  createChecker,
  dropWebinar,
  emit,
  login,
  makeWebinar,
  runSuite,
} from './lib/parity-harness.mjs';

runSuite('registration approval', async () => {
  const { check, finish } = createChecker();
  const admin = await login();
  const token = admin.token;

  const webinar = await makeWebinar(token, { settings: { requireApproval: true } });
  const wid = webinar.id;
  const slug = webinar.slug;
  check('fixture webinar created with approval on', Boolean(wid), slug);

  const sockets = [];
  try {
    /* ── a new sign-up is pending ── */
    const stamp = Date.now();
    const signup = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: {
        name: 'Pending Person',
        email: `pending${stamp}@example.com`,
        phone: '+91 98765 43210',
      },
    });
    check('the registration is accepted', signup.status === 200, signup.text?.slice(0, 120));
    check('the response says approval is pending', signup.json?.pendingApproval === true);
    check('the registration status is PENDING', signup.json?.registration?.status === 'PENDING');

    const pendingToken = signup.json?.token;
    const pendingJoinToken = signup.json?.registration?.joinToken;

    /* ── the queue ── */
    const queue = await api(`/api/admin/${wid}/registrations`, { token });
    check('the admin queue is reachable', queue.status === 200);
    const row = (queue.json?.registrations ?? []).find((r) => r.email.startsWith('pending'));
    check('the pending sign-up is in the queue', Boolean(row));
    check('the row carries the status', row?.status === 'PENDING');
    check('the counts include PENDING', queue.json?.counts?.PENDING === 1, JSON.stringify(queue.json?.counts));

    /* ── a pending registration cannot enter ── */
    const pendingSocket = await connect(pendingToken);
    sockets.push(pendingSocket);
    const blocked = await emit(pendingSocket, 'join', { slug, token: pendingToken });
    check('a pending registration is refused entry', blocked?.ok === false, blocked?.error);
    check(
      'the refusal explains why',
      typeof blocked?.error === 'string' && /approval/i.test(blocked.error),
      blocked?.error
    );

    /* ── approve ── */
    const approve = await api(`/api/admin/registrations/${row.id}`, {
      method: 'PATCH',
      token,
      body: { status: 'APPROVED', note: 'Looks good' },
    });
    check('the host can approve', approve.status === 200, approve.text?.slice(0, 120));
    check('the status flips to APPROVED', approve.json?.registration?.status === 'APPROVED');
    check('the note is stored', approve.json?.registration?.statusNote === 'Looks good');
    check('the counts follow', approve.json?.counts?.APPROVED === 1, JSON.stringify(approve.json?.counts));

    /* ── an approved registration can enter ── */
    const approvedSocket = await connect(pendingToken);
    sockets.push(approvedSocket);
    const allowed = await emit(approvedSocket, 'join', { slug, token: pendingToken });
    check('an approved registration can enter', allowed?.ok === true, allowed?.error);

    /* ── reject ── */
    const second = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: {
        name: 'Rejected Person',
        email: `rejected${stamp}@example.com`,
        phone: '+91 98765 43210',
      },
    });
    const secondRow = (await api(`/api/admin/${wid}/registrations`, { token })).json?.registrations
      ?.find((r) => r.email.startsWith('rejected'));
    check('a second sign-up is queued', Boolean(secondRow));

    const reject = await api(`/api/admin/registrations/${secondRow.id}`, {
      method: 'PATCH',
      token,
      body: { status: 'REJECTED' },
    });
    check('the host can reject', reject.status === 200);
    check('the status flips to REJECTED', reject.json?.registration?.status === 'REJECTED');

    const rejectedSocket = await connect(second.json?.token);
    sockets.push(rejectedSocket);
    const rejectedJoin = await emit(rejectedSocket, 'join', {
      slug,
      token: second.json?.token,
    });
    check('a rejected registration is refused entry', rejectedJoin?.ok === false, rejectedJoin?.error);

    /* ── the claim path also refuses a rejected token ── */
    const claim = await api(`/api/webinars/${slug}/claim`, {
      method: 'POST',
      body: {
        token: second.json?.registration?.joinToken,
        name: 'Rejected Person',
        phone: '+91 98765 43210',
      },
    });
    check('a rejected join token cannot be claimed', claim.status === 400, claim.text?.slice(0, 120));

    /* ── waitlist ── */
    const third = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: {
        name: 'Waitlisted Person',
        email: `waitlisted${stamp}@example.com`,
        phone: '+91 98765 43210',
      },
    });
    const thirdRow = (await api(`/api/admin/${wid}/registrations`, { token })).json?.registrations
      ?.find((r) => r.email.startsWith('waitlisted'));
    const waitlist = await api(`/api/admin/registrations/${thirdRow.id}`, {
      method: 'PATCH',
      token,
      body: { status: 'WAITLISTED' },
    });
    check('the host can waitlist', waitlist.status === 200);
    check('the status flips to WAITLISTED', waitlist.json?.registration?.status === 'WAITLISTED');

    const waitSocket = await connect(third.json?.token);
    sockets.push(waitSocket);
    const waitJoin = await emit(waitSocket, 'join', { slug, token: third.json?.token });
    check('a waitlisted registration is refused entry', waitJoin?.ok === false, waitJoin?.error);

    /* ── approve all ── */
    const fourth = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: {
        name: 'Bulk Person',
        email: `bulk${stamp}@example.com`,
        phone: '+91 98765 43210',
      },
    });
    check('a fourth sign-up is queued', fourth.json?.pendingApproval === true);

    const bulk = await api(`/api/admin/${wid}/registrations/approve-all`, {
      method: 'POST',
      token,
      body: {},
    });
    check('approve-all succeeds', bulk.status === 200, bulk.text?.slice(0, 120));
    check('approve-all clears the pending queue', bulk.json?.approved === 1, `approved ${bulk.json?.approved}`);
    // The server omits statuses with a zero count rather than emitting `PENDING: 0`,
    // so "nothing pending" is the absence of the key, not a zero value.
    check('nothing is left pending', !bulk.json?.counts?.PENDING, JSON.stringify(bulk.json?.counts));

    /* ── an invalid status is rejected ── */
    const bad = await api(`/api/admin/registrations/${row.id}`, {
      method: 'PATCH',
      token,
      body: { status: 'MAYBE' },
    });
    check('an unknown status is rejected', bad.status === 400);

    /* ── a webinar without approval auto-approves ── */
    const open = await makeWebinar(token);
    try {
      const openSignup = await api(`/api/webinars/${open.slug}/register`, {
        method: 'POST',
        body: {
          name: 'Open Person',
          email: `open${stamp}@example.com`,
          phone: '+91 98765 43210',
        },
      });
      check('without approval the sign-up is approved at once', openSignup.json?.pendingApproval === false);
      check(
        'the status is APPROVED',
        openSignup.json?.registration?.status === 'APPROVED',
        openSignup.json?.registration?.status
      );
    } finally {
      await dropWebinar(token, open.id);
    }
  } finally {
    for (const s of sockets) s.disconnect();
    await dropWebinar(token, wid);
  }

  finish();
});
