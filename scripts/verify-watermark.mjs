/**
 * Watermark — a per-viewer identity band burned over the stage.
 *
 * The property that matters: the watermark carries the *viewer's own* name and
 * id, not a generic label. A generic label cannot be traced back to the account
 * that leaked the recording, which is the entire reason the feature exists.
 */
import {
  api,
  connect,
  createChecker,
  dropWebinar,
  emit,
  login,
  makeWebinar,
  register,
  runSuite,
} from './lib/parity-harness.mjs';

runSuite('watermark', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  let wid = null;
  const sockets = [];

  /** Register, then join the room over the socket. Returns the join ack. */
  async function joinAs(name, slug) {
    const reg = await register(slug, name, `wm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const jwt = reg.token;
    const socket = await connect(jwt);
    sockets.push(socket);
    const ack = await emit(socket, 'join', { slug, token: jwt });
    return { reg, jwt, ack };
  }

  try {
    const webinar = await makeWebinar(token);
    wid = webinar.id;
    check('a fixture webinar is created', Boolean(wid), webinar.slug);

    /* ── off by default ── */
    const list = await api('/api/admin/webinars', { token });
    const row = list.json?.webinars?.find((w) => w.id === wid);
    check('the webinar is listed', Boolean(row));
    check('the watermark is off by default', row?.settings?.watermarkEnabled === false);

    /* ── a join with it off ── */
    const first = await joinAs('Watermark Viewer', webinar.slug);
    check('a participant can register', typeof first.jwt === 'string');
    check('the participant joins the room', first.ack?.ok === true, first.ack?.error);
    check('the snapshot carries a watermark field', first.ack?.data?.snapshot?.watermark === null);

    /* ── the shared-link claim path also works ── */
    const claimReg = await register(webinar.slug, 'Claim Viewer', `claim-${Date.now()}@example.com`);
    const claim = await api(`/api/webinars/${webinar.slug}/claim`, {
      method: 'POST',
      body: { token: claimReg.registration.joinToken, name: 'Claim Viewer', phone: '+91 98765 43210' },
    });
    check('a shared link can be claimed', claim.status === 200, claim.text?.slice(0, 160));
    check('the claim returns a session', typeof claim.json?.token === 'string');

    /* ── turn it on ── */
    const enabled = await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: { settings: { watermarkEnabled: true } },
    });
    check('the watermark can be enabled', enabled.status === 200, enabled.text?.slice(0, 160));

    const reread = await api('/api/admin/webinars', { token });
    check(
      'the setting is stored',
      reread.json?.webinars?.find((w) => w.id === wid)?.settings?.watermarkEnabled === true
    );

    /* ── a fresh join sees it ── */
    const second = await joinAs('Second Viewer', webinar.slug);
    check('a second participant joins', second.ack?.ok === true, second.ack?.error);

    const wm = second.ack?.data?.snapshot?.watermark;
    check('the snapshot carries a watermark', Boolean(wm));
    check('the watermark is enabled', wm?.enabled === true);
    check('the watermark carries the viewer name', wm?.label === 'Second Viewer', wm?.label);
    check('the watermark carries the viewer id', typeof wm?.userId === 'string' && wm.userId.length > 0, wm?.userId);
    check(
      'the watermark id is the joining peer',
      wm?.userId === second.ack?.data?.userId,
      `${wm?.userId} vs ${second.ack?.data?.userId}`
    );

    /* ── each viewer gets their own ── */
    const third = await joinAs('Third Viewer', webinar.slug);
    const wm3 = third.ack?.data?.snapshot?.watermark;
    check('a third viewer gets their own label', wm3?.label === 'Third Viewer', wm3?.label);
    check('the labels differ per viewer', wm3?.label !== wm?.label);
    check('the ids differ per viewer', wm3?.userId !== wm?.userId);

    /* ── the host sees their own too ── */
    const hostSocket = await connect(token);
    sockets.push(hostSocket);
    const hostJoined = await emit(hostSocket, 'join', { slug: webinar.slug, token });
    check('the host joins', hostJoined?.ok === true, hostJoined?.error);
    check(
      'the host is staff',
      hostJoined?.data?.role === 'HOST' || hostJoined?.data?.role === 'ADMIN',
      hostJoined?.data?.role
    );
    check('the host carries a watermark too', hostJoined?.data?.snapshot?.watermark?.enabled === true);
    check(
      'the host watermark names the host',
      hostJoined?.data?.snapshot?.watermark?.label === hostJoined?.data?.name,
      hostJoined?.data?.snapshot?.watermark?.label
    );

    /* ── turn it off again ── */
    const disabled = await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: { settings: { watermarkEnabled: false } },
    });
    check('the watermark can be disabled', disabled.status === 200);

    const fourth = await joinAs('Fourth Viewer', webinar.slug);
    check('a join after disabling carries no watermark', fourth.ack?.data?.snapshot?.watermark === null);
  } finally {
    for (const s of sockets) {
      try {
        s.disconnect();
      } catch {
        /* already gone */
      }
    }
    await dropWebinar(token, wid);
    finish();
  }
});
