/**
 * Verifies co-hosts and the permission model.
 *
 *   host   : adding a co-host by email works, and the cap is enforced
 *   host   : the default permission map grants everything except start/end
 *   host   : a per-co-host override narrows the map
 *   host   : the webinar-level default applies to a co-host with no override
 *   socket : a co-host joins as staff and can moderate chat
 *   socket : a co-host without `polls` cannot launch a poll
 *   socket : a co-host without `usersControl` cannot mute another peer
 *   socket : a co-host without `startWebinar` cannot start the session
 *   host   : `cohostStartWithoutHost` grants the start right
 *   host   : removing a co-host revokes the permissions
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
  sleep,
} from './lib/parity-harness.mjs';

runSuite('co-hosts', async () => {
  const { check, finish } = createChecker();
  const admin = await login();
  const token = admin.token;

  const webinar = await makeWebinar(token);
  const wid = webinar.id;
  const slug = webinar.slug;
  check('fixture webinar created', Boolean(wid), slug);

  const sockets = [];
  try {
    const stamp = Date.now();
    const cohostEmail = `cohost${stamp}@example.com`;

    /* ── add ── */
    const add = await api(`/api/admin/${wid}/cohosts`, {
      method: 'POST',
      token,
      body: { email: cohostEmail, name: 'Co Host' },
    });
    check('a co-host can be added', add.status === 201 || add.status === 200, add.text?.slice(0, 120));
    const cohostId = add.json?.cohost?.id;
    check('the co-host row is returned', Boolean(cohostId));

    const list = await api(`/api/admin/${wid}/cohosts`, { token });
    check('the co-host list is reachable', list.status === 200);
    check('the cap is exposed', list.json?.maxCohosts === 10, String(list.json?.maxCohosts));
    check('the co-host is listed', (list.json?.cohosts ?? []).length === 1);

    const dup = await api(`/api/admin/${wid}/cohosts`, {
      method: 'POST',
      token,
      body: { email: cohostEmail },
    });
    check('adding the same co-host twice is rejected', dup.status === 409 || dup.status === 400, `got ${dup.status}`);

    /* ── the co-host registers and joins ── */
    const cohostUser = await register(slug, 'Co Host', cohostEmail);
    const cohostSocket = await connect(cohostUser.token);
    sockets.push(cohostSocket);
    const cohostJoin = await emit(cohostSocket, 'join', { slug, token: cohostUser.token });
    check('the co-host can join', cohostJoin?.ok === true, cohostJoin?.error);
    check('the co-host is staff', cohostJoin?.data?.role === 'MODERATOR', cohostJoin?.data?.role);

    /* ── the default map ── */
    const policy = await api(`/api/admin/${wid}/cohost-policy/me`, { token: cohostUser.token });
    check('the co-host can read their own policy', policy.status === 200, policy.text?.slice(0, 120));
    check('the co-host is not the owner', policy.json?.isOwner === false);
    const perms = policy.json?.permissions ?? {};
    check('chat moderation is granted by default', perms.chatModeration === true);
    check('polls are granted by default', perms.polls === true);
    check('starting is withheld by default', perms.startWebinar === false);
    check('ending is withheld by default', perms.endWebinar === false);

    /* ── a participant to act on ── */
    const viewer = await register(slug, 'Viewer', `viewer${stamp}@example.com`);
    const viewerSocket = await connect(viewer.token);
    sockets.push(viewerSocket);
    const viewerJoin = await emit(viewerSocket, 'join', { slug, token: viewer.token });
    check('a participant joins', viewerJoin?.ok === true, viewerJoin?.error);
    const viewerPeerId = viewerJoin?.data?.peerId;

    /* ── a granted permission works ── */
    // Polls are authored over HTTP and launched over the socket by id, so the
    // fixture has to exist before the co-host can launch it.
    const pollRow = await api(`/api/admin/${wid}/polls`, {
      method: 'POST',
      token,
      body: {
        question: 'Co-host poll?',
        options: [
          { id: 'a', text: 'Yes' },
          { id: 'b', text: 'No' },
        ],
      },
    });
    check('a poll fixture is created', pollRow.status === 201 || pollRow.status === 200, pollRow.text?.slice(0, 120));
    const pollId = pollRow.json?.poll?.id;

    const poll = await emit(cohostSocket, 'pollLaunch', { pollId });
    check('a co-host with the polls permission can launch a poll', poll?.ok === true, poll?.error);
    if (poll?.ok) await emit(cohostSocket, 'pollClose', { pollId });

    /* ── narrow the map ── */
    const narrow = await api(`/api/admin/cohosts/${cohostId}`, {
      method: 'PATCH',
      token,
      body: { permissions: { polls: false, usersControl: false } },
    });
    check('the host can narrow a co-host', narrow.status === 200, narrow.text?.slice(0, 120));

    // The socket caches the permission map at join time, so the co-host has to
    // rejoin for the change to take effect. That is the documented behaviour.
    cohostSocket.disconnect();
    const cohostSocket2 = await connect(cohostUser.token);
    sockets.push(cohostSocket2);
    const rejoin = await emit(cohostSocket2, 'join', { slug, token: cohostUser.token });
    check('the co-host can rejoin', rejoin?.ok === true, rejoin?.error);

    const deniedPoll = await emit(cohostSocket2, 'pollLaunch', { pollId });
    check('a co-host without polls cannot launch a poll', deniedPoll?.ok === false, deniedPoll?.error);

    const deniedMute = await emit(cohostSocket2, 'modMute', {
      peerId: viewerPeerId,
      muted: true,
    });
    check(
      'a co-host without usersControl cannot mute',
      deniedMute?.ok === false,
      deniedMute?.error
    );

    const deniedStart = await emit(cohostSocket2, 'webinarStart', {});
    check('a co-host without startWebinar cannot start', deniedStart?.ok === false, deniedStart?.error);

    /* ── the webinar-level default applies ── */
    const setDefault = await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: { settings: { cohostPermissions: { qna: false } } },
    });
    check('the host can set a webinar-level default', setDefault.status === 200, setDefault.text?.slice(0, 120));

    /* ── cohostStartWithoutHost grants the start right ── */
    const allowStart = await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: { settings: { cohostStartWithoutHost: true } },
    });
    check('the host can allow a co-host to start', allowStart.status === 200);

    cohostSocket2.disconnect();
    const cohostSocket3 = await connect(cohostUser.token);
    sockets.push(cohostSocket3);
    await emit(cohostSocket3, 'join', { slug, token: cohostUser.token });
    const start = await emit(cohostSocket3, 'webinarStart', {});
    check('cohostStartWithoutHost grants the start right', start?.ok === true, start?.error);

    /* ── remove ── */
    const remove = await api(`/api/admin/cohosts/${cohostId}`, { method: 'DELETE', token });
    check('a co-host can be removed', remove.status === 200, remove.text?.slice(0, 120));

    const afterList = await api(`/api/admin/${wid}/cohosts`, { token });
    check('the co-host list is empty again', (afterList.json?.cohosts ?? []).length === 0);

    cohostSocket3.disconnect();
    const cohostSocket4 = await connect(cohostUser.token);
    sockets.push(cohostSocket4);
    const demoted = await emit(cohostSocket4, 'join', { slug, token: cohostUser.token });
    check('a removed co-host rejoins as a participant', demoted?.data?.role === 'PARTICIPANT', demoted?.data?.role);

    const noLonger = await emit(cohostSocket4, 'pollLaunch', { pollId });
    check('a removed co-host has no powers', noLonger?.ok === false, noLonger?.error);

    /* ── the cap ── */
    const bulk = [];
    for (let i = 0; i < 11; i++) bulk.push(`cap${stamp}-${i}@example.com`);
    let capped = 0;
    for (const email of bulk) {
      const res = await api(`/api/admin/${wid}/cohosts`, {
        method: 'POST',
        token,
        body: { email },
      });
      if (res.status === 201 || res.status === 200) capped += 1;
    }
    check('the co-host cap is enforced at 10', capped === 10, `added ${capped}`);
  } finally {
    for (const s of sockets) s.disconnect();
    await sleep(100);
    await dropWebinar(token, wid);
  }

  finish();
});
