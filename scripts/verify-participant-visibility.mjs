/**
 * Participant media visibility — `showParticipantsToEachOther`.
 *
 * The property that matters is a privacy one, and it cannot be tested in the
 * UI: hiding a tile is not a guarantee, because the media is still flowing.
 * What has to hold is that the SFU never creates a Consumer that would deliver
 * one participant's media to another. So this suite drives the socket directly
 * and asserts on the two server-side gates:
 *
 *   1. `snapshotFor` — does the viewer even learn the other peer exists?
 *   2. `consume`     — is the request rejected when it should be?
 *
 * Both must flip together when the host changes the setting, and the change
 * must take effect on a live room without anyone rejoining.
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

/** A minimal VP8 producer payload. Distinct `mid`/`ssrc` per producer. */
function videoParams(mid, ssrc) {
  return {
    mid,
    codecs: [{ mimeType: 'video/VP8', clockRate: 90000, payloadType: 96, parameters: {} }],
    headerExtensions: [],
    encodings: [{ ssrc }],
    rtcp: {},
  };
}

runSuite('participant visibility', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  let wid = null;
  const sockets = [];

  async function joinAs(name, slug) {
    const reg = await register(
      slug,
      name,
      `vis-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`
    );
    const socket = await connect(reg.token);
    sockets.push(socket);
    const ack = await emit(socket, 'join', { slug, token: reg.token });
    return { reg, socket, ack };
  }

  try {
    // Participants may only publish once a moderator approves their hand, and
    // only when the webinar allows video at all — so the fixture has to permit
    // it, otherwise the publish step fails for a reason unrelated to visibility.
    const webinar = await makeWebinar(token, {
      settings: { allowVideo: true, allowMic: true },
    });
    wid = webinar.id;
    check('a fixture webinar is created', Boolean(wid), webinar.slug);

    /* ── the default ── */
    const list = await api('/api/admin/webinars', { token });
    const row = list.json?.webinars?.find((w) => w.id === wid);
    check(
      'participants are hidden from each other by default',
      row?.settings?.showParticipantsToEachOther === false
    );

    const pub = await api(`/api/webinars/${webinar.slug}/public`);
    check(
      'the public projection reports the setting as off',
      pub.json?.webinar?.settings?.showParticipantsToEachOther === false
    );

    /* ── two participants, setting OFF ── */
    const a = await joinAs('Visibility Alpha', webinar.slug);
    check('participant A joins', a.ack?.ok === true, a.ack?.error);
    check(
      'the snapshot carries the setting',
      a.ack?.data?.snapshot?.settings?.showParticipantsToEachOther === false
    );

    const b = await joinAs('Visibility Bravo', webinar.slug);
    check('participant B joins', b.ack?.ok === true, b.ack?.error);

    // Roster check first, while B is still an ordinary attendee. An approved
    // speaker is deliberately visible to the room — that is the whole point of
    // approving them — so the "hidden" assertion only holds before approval.
    const aPeers = a.ack.data?.snapshot?.peers ?? [];
    check(
      'A does not see B in the roster while the setting is off',
      !aPeers.some((p) => p.peerId === b.ack.data.peerId),
      JSON.stringify(aPeers.map((p) => p.name))
    );

    // B publishes a camera. A must not be able to consume it. A participant can
    // only publish after a moderator approves their hand, so a staff peer has
    // to do that first — and staff means the admin token, not a registered
    // attendee.
    const staffSocket = await connect(token);
    sockets.push(staffSocket);
    const staffAck = await emit(staffSocket, 'join', { slug: webinar.slug, token });
    check('a staff peer joins', staffAck?.ok === true, staffAck?.error);

    const approve = await emit(staffSocket, 'handApprove', { userId: b.ack.data.userId });
    check('staff can approve B to speak', approve.ok === true, approve.error);

    const bSend = await emit(b.socket, 'createTransport', { direction: 'send' });
    check('B creates a send transport', bSend.ok === true, bSend.error);
    const bProd = await emit(b.socket, 'produce', {
      transportId: bSend.data.id,
      kind: 'video',
      source: 'camera',
      rtpParameters: videoParams('0', 333001),
      appData: { kind: 'video', source: 'camera' },
    });
    check('B publishes a camera producer', bProd.ok === true, bProd.error);

    await sleep(600);

    // The consume gate must reject even though A knows the producer id. This is
    // the assertion that actually protects the audience: the UI hiding a tile
    // means nothing if the SFU would still deliver the media.
    const aRecv = await emit(a.socket, 'createTransport', { direction: 'recv' });
    check('A creates a receive transport', aRecv.ok === true, aRecv.error);
    const denied = await emit(a.socket, 'consume', {
      producerId: bProd.data.producerId,
      rtpCapabilities: a.ack.data.rtpCapabilities,
    });
    check(
      'A is refused B\u2019s producer while the setting is off',
      denied.ok === false,
      denied.ok ? 'consume unexpectedly succeeded' : denied.error
    );

    /* ── the host opens the room up ── */
    const on = await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: { settings: { showParticipantsToEachOther: true } },
    });
    check('the setting can be turned on', on.status === 200, on.text?.slice(0, 160));
    check(
      'the setting reads back as on',
      on.json?.webinar?.settings?.showParticipantsToEachOther === true
    );

    await sleep(600);

    // A re-reads the room. B must now be present.
    const aRejoin2 = await emit(a.socket, 'join', { slug: webinar.slug, token: a.reg.token });
    check('A can re-read the room again', aRejoin2.ok === true, aRejoin2.error);
    const aPeers2 = aRejoin2.data?.snapshot?.peers ?? [];
    check(
      'A sees B in the roster once the setting is on',
      aPeers2.some((p) => p.peerId === b.ack.data.peerId),
      JSON.stringify(aPeers2.map((p) => p.name))
    );
    check(
      'the new snapshot reports the setting as on',
      aRejoin2.data?.snapshot?.settings?.showParticipantsToEachOther === true
    );

    // And the consume gate must now allow it. The capabilities have to be the
    // ones the server handed out at join — a hand-rolled object fails the
    // router's compatibility check before the policy is ever consulted. A
    // re-join builds a fresh Peer, so the receive transport has to be recreated
    // too; the old one died with the previous peer.
    const aRecv2 = await emit(a.socket, 'createTransport', { direction: 'recv' });
    check('A creates a receive transport after rejoining', aRecv2.ok === true, aRecv2.error);
    const allowed = await emit(a.socket, 'consume', {
      producerId: bProd.data.producerId,
      rtpCapabilities: aRejoin2.data.rtpCapabilities,
    });
    check(
      'A may consume B\u2019s producer once the setting is on',
      allowed.ok === true,
      allowed.error
    );

    /* ── turning it back off revokes access ── */
    const off = await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: { settings: { showParticipantsToEachOther: false } },
    });
    check('the setting can be turned back off', off.status === 200);
    check(
      'the setting reads back as off',
      off.json?.webinar?.settings?.showParticipantsToEachOther === false
    );

    await sleep(600);

    // The live room must have torn the consumer down, not merely stopped
    // advertising it — otherwise A keeps receiving B's camera after the host
    // closed the room.
    const revoked = await emit(a.socket, 'consume', {
      producerId: bProd.data.producerId,
      rtpCapabilities: aRejoin2.data.rtpCapabilities,
    });
    check(
      'A is refused again once the setting is off',
      revoked.ok === false,
      revoked.ok ? 'consume unexpectedly succeeded' : revoked.error
    );

    /* ── an unrelated patch must not reset it ── */
    const unrelated = await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: { title: 'Participant Visibility Fixture (renamed)' },
    });
    check('an unrelated patch succeeds', unrelated.status === 200);
    check(
      'an unrelated patch leaves the setting alone',
      unrelated.json?.webinar?.settings?.showParticipantsToEachOther === false
    );
  } finally {
    for (const s of sockets) {
      try {
        s.disconnect();
      } catch {
        /* already gone */
      }
    }
    if (wid) await dropWebinar(token, wid);
    finish();
  }
});
