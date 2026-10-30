/**
 * Participant sidebar tabs — People, Q&A and Polls are opt-in per webinar.
 *
 * The property that matters: all three default to **off**, and the flag reaches
 * the client in the join snapshot. The gating itself is client-side (staff must
 * always see every tab), so the server's job is to store the choice and ship it
 * to the room — which is exactly what this suite pins down.
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

runSuite('participant tabs', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  let wid = null;
  const sockets = [];

  /** Register, then join the room over the socket. Returns the join ack. */
  async function joinAs(name, slug) {
    const reg = await register(
      slug,
      name,
      `tabs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`
    );
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

    /* ── the defaults ── */
    const list = await api('/api/admin/webinars', { token });
    const row = list.json?.webinars?.find((w) => w.id === wid);
    check('the webinar is listed', Boolean(row));
    check('the People tab is off by default', row?.settings?.showPeopleTab === false);
    check('the Q&A tab is off by default', row?.settings?.showQaTab === false);
    check('the Polls tab is off by default', row?.settings?.showPollsTab === false);

    /* ── the public projection carries them too ── */
    const pub = await api(`/api/webinars/${webinar.slug}/public`);
    check('the public projection is served', pub.status === 200, pub.text?.slice(0, 160));
    check(
      'the public projection reports the People tab as off',
      pub.json?.webinar?.settings?.showPeopleTab === false
    );
    check(
      'the public projection reports the Q&A tab as off',
      pub.json?.webinar?.settings?.showQaTab === false
    );
    check(
      'the public projection reports the Polls tab as off',
      pub.json?.webinar?.settings?.showPollsTab === false
    );

    /* ── a participant's snapshot carries the flags ── */
    const first = await joinAs('Tab Viewer', webinar.slug);
    check('a participant can register', typeof first.jwt === 'string');
    check('the participant joins the room', first.ack?.ok === true, first.ack?.error);
    const s1 = first.ack?.data?.snapshot?.settings;
    check('the snapshot carries the People flag', s1?.showPeopleTab === false);
    check('the snapshot carries the Q&A flag', s1?.showQaTab === false);
    check('the snapshot carries the Polls flag', s1?.showPollsTab === false);

    /* ── turning them on ── */
    const on = await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: {
        settings: { showPeopleTab: true, showQaTab: true, showPollsTab: true },
      },
    });
    check('the flags can be turned on', on.status === 200, on.text?.slice(0, 160));
    check('the People tab is now on', on.json?.webinar?.settings?.showPeopleTab === true);
    check('the Q&A tab is now on', on.json?.webinar?.settings?.showQaTab === true);
    check('the Polls tab is now on', on.json?.webinar?.settings?.showPollsTab === true);

    /* ── a fresh join sees the new values ── */
    const second = await joinAs('Tab Viewer Two', webinar.slug);
    check('a second participant joins', second.ack?.ok === true, second.ack?.error);
    const s2 = second.ack?.data?.snapshot?.settings;
    check('the new snapshot reports the People tab as on', s2?.showPeopleTab === true);
    check('the new snapshot reports the Q&A tab as on', s2?.showQaTab === true);
    check('the new snapshot reports the Polls tab as on', s2?.showPollsTab === true);

    /* ── a partial patch must not disturb the others ── */
    const partial = await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: { settings: { showQaTab: false } },
    });
    check('a partial settings patch succeeds', partial.status === 200);
    check('the People tab is untouched', partial.json?.webinar?.settings?.showPeopleTab === true);
    check('the Q&A tab is turned off', partial.json?.webinar?.settings?.showQaTab === false);
    check('the Polls tab is untouched', partial.json?.webinar?.settings?.showPollsTab === true);

    /* ── an unrelated patch must not reset them ── */
    const unrelated = await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: { title: 'Participant Tabs Fixture (renamed)' },
    });
    check('an unrelated patch succeeds', unrelated.status === 200);
    check(
      'an unrelated patch leaves the People tab alone',
      unrelated.json?.webinar?.settings?.showPeopleTab === true
    );
    check(
      'an unrelated patch leaves the Polls tab alone',
      unrelated.json?.webinar?.settings?.showPollsTab === true
    );

    /* ── a series occurrence inherits the flags ── */
    const series = await api(`/api/admin/${wid}/series`, {
      method: 'POST',
      token,
      body: {
        frequency: 'WEEKLY',
        interval: 1,
        count: 2,
        startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
    });
    check('a series can be created', series.status === 201, series.text?.slice(0, 200));

    const after = await api('/api/admin/webinars', { token });
    const occurrences = (after.json?.webinars ?? []).filter(
      (w) => w.id !== wid && w.title === 'Participant Tabs Fixture (renamed)'
    );
    check('the series produced occurrences', occurrences.length >= 1, String(occurrences.length));
    check(
      'an occurrence inherits the People tab flag',
      occurrences.every((w) => w.settings?.showPeopleTab === true)
    );
    check(
      'an occurrence inherits the Polls tab flag',
      occurrences.every((w) => w.settings?.showPollsTab === true)
    );

    for (const w of occurrences) {
      await api(`/api/admin/webinars/${w.id}`, { method: 'DELETE', token });
    }
  } finally {
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        /* already gone */
      }
    }
    if (wid) await dropWebinar(token, wid);
  }

  finish();
});
