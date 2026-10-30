/**
 * Verifies bulk invites and the invite-only gate.
 *
 *   host   : inviting an address creates a real registration with a join token
 *   host   : re-inviting the same address is not an error
 *   host   : a malformed address is reported per-address, not as a 500
 *   public : with inviteOnly on, an uninvited address is refused
 *   public : an invited address is let through
 *   host   : uninviting cancels rather than deletes, so the audit trail survives
 *   public : an uninvited address is refused again
 */
import {
  api,
  createChecker,
  dropWebinar,
  login,
  makeWebinar,
  runSuite,
} from './lib/parity-harness.mjs';

runSuite('invites', async () => {
  const { check, finish } = createChecker();
  const admin = await login();
  const token = admin.token;

  const webinar = await makeWebinar(token, { settings: { inviteOnly: true } });
  const wid = webinar.id;
  const slug = webinar.slug;
  check('fixture webinar created invite-only', Boolean(wid), slug);

  try {
    const stamp = Date.now();
    const invited = `invited${stamp}@example.com`;
    const stranger = `stranger${stamp}@example.com`;

    /* ── invite ── */
    const invite = await api(`/api/admin/${wid}/invite`, {
      method: 'POST',
      token,
      body: { emails: [invited] },
    });
    check('the invite call succeeds', invite.status === 200, invite.text?.slice(0, 120));
    check('one address is invited', invite.json?.invited === 1, `invited ${invite.json?.invited}`);
    check('the per-address result is reported', invite.json?.results?.[0]?.invited === true);

    const regs = await api(`/api/admin/${wid}/registrations`, { token });
    const row = (regs.json?.registrations ?? []).find((r) => r.email === invited);
    check('the invite created a registration', Boolean(row));
    check('the invite carries a join token', Boolean(row?.joinToken));

    /* ── re-invite is idempotent ── */
    const again = await api(`/api/admin/${wid}/invite`, {
      method: 'POST',
      token,
      body: { emails: [invited] },
    });
    check('re-inviting is not an error', again.status === 200);
    check(
      're-inviting does not create a duplicate',
      (await api(`/api/admin/${wid}/registrations`, { token })).json?.registrations?.filter(
        (r) => r.email === invited
      ).length === 1
    );

    /* ── a malformed address is reported, not fatal ── */
    const mixed = await api(`/api/admin/${wid}/invite`, {
      method: 'POST',
      token,
      body: { emails: [`good${stamp}@example.com`, 'not-an-email'] },
    });
    check('a mixed batch still succeeds', mixed.status === 200);
    check('the good address is invited', mixed.json?.invited === 1, `invited ${mixed.json?.invited}`);
    const badResult = (mixed.json?.results ?? []).find((r) => r.email === 'not-an-email');
    check('the bad address is reported as skipped', badResult?.invited === false);
    check('the bad address carries a reason', typeof badResult?.reason === 'string', badResult?.reason);

    /* ── the gate ── */
    const blocked = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: { name: 'Stranger', email: stranger, phone: '+91 98765 43210' },
    });
    check('an uninvited address is refused', blocked.status === 403, `got ${blocked.status}`);
    check(
      'the refusal mentions the invite',
      typeof blocked.json?.error === 'string' && /invit/i.test(blocked.json.error),
      blocked.json?.error
    );

    const allowed = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: { name: 'Invited', email: invited, phone: '+91 98765 43210' },
    });
    check('an invited address is let through', allowed.status === 200, allowed.text?.slice(0, 120));

    /* ── uninvite ── */
    const uninvite = await api(
      `/api/admin/${wid}/invite?email=${encodeURIComponent(invited)}`,
      { method: 'DELETE', token }
    );
    check('uninviting succeeds', uninvite.status === 200, uninvite.text?.slice(0, 120));

    const after = await api(`/api/admin/${wid}/registrations`, { token });
    const cancelled = (after.json?.registrations ?? []).find((r) => r.email === invited);
    check('the row is cancelled, not deleted', cancelled?.status === 'CANCELLED', cancelled?.status);

    const refused = await api(`/api/webinars/${slug}/register`, {
      method: 'POST',
      body: { name: 'Invited', email: invited, phone: '+91 98765 43210' },
    });
    check('an uninvited address is refused again', refused.status === 403, `got ${refused.status}`);

    /* ── an empty batch is rejected ── */
    const empty = await api(`/api/admin/${wid}/invite`, {
      method: 'POST',
      token,
      body: { emails: [] },
    });
    check('an empty invite batch is rejected', empty.status === 400);
  } finally {
    await dropWebinar(token, wid);
  }

  finish();
});
