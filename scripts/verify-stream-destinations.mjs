/**
 * Stream destinations — simulcast to YouTube / Facebook / a custom RTMP host.
 *
 * The properties that matter: a stream key is never returned by a list (a
 * `keyHint` is enough to tell two keys apart), the keys are locked once the
 * webinar is live (changing a key mid-broadcast silently kills the feed), and
 * the generated FFmpeg command *does* contain the key — the command is useless
 * without it, and it is served with `no-store`.
 */
import { api, createChecker, dropWebinar, login, makeWebinar, runSuite } from './lib/parity-harness.mjs';

runSuite('stream destinations', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  let wid = null;

  try {
    const webinar = await makeWebinar(token);
    wid = webinar.id;
    check('a fixture webinar is created', Boolean(wid), webinar.slug);

    /* ── empty state ── */
    const empty = await api(`/api/admin/${wid}/stream-destinations`, { token });
    check('the destination list is reachable', empty.status === 200, empty.text?.slice(0, 120));
    check('a fresh webinar has no destinations', Array.isArray(empty.json?.destinations) && empty.json.destinations.length === 0);
    check('the cap is exposed', typeof empty.json?.maxDestinations === 'number', String(empty.json?.maxDestinations));
    check('a draft webinar is editable', empty.json?.editable === true);

    /* ── validation ── */
    const noKey = await api(`/api/admin/${wid}/stream-destinations`, {
      method: 'POST',
      token,
      body: { platform: 'youtube' },
    });
    check('a destination needs a stream key', noKey.status === 400, `got ${noKey.status}`);

    const badPlatform = await api(`/api/admin/${wid}/stream-destinations`, {
      method: 'POST',
      token,
      body: { platform: 'vimeo', streamKey: 'abc' },
    });
    check('an unknown platform is rejected', badPlatform.status === 400, `got ${badPlatform.status}`);

    const customNoUrl = await api(`/api/admin/${wid}/stream-destinations`, {
      method: 'POST',
      token,
      body: { platform: 'custom', streamKey: 'abc' },
    });
    check('a custom destination needs an rtmp url', customNoUrl.status === 400, `got ${customNoUrl.status}`);

    /* ── create ── */
    const youtube = await api(`/api/admin/${wid}/stream-destinations`, {
      method: 'POST',
      token,
      body: { platform: 'youtube', streamKey: 'abcd-1234-efgh-5678' },
    });
    check('a youtube destination can be added', youtube.status === 201, youtube.text?.slice(0, 160));
    check('the destination is returned', Boolean(youtube.json?.destination?.id));
    check('the platform is recorded', youtube.json?.destination?.platform === 'youtube');
    check('the key is never echoed back', youtube.json?.destination?.streamKey === undefined);
    check('a key hint is provided', typeof youtube.json?.destination?.keyHint === 'string', youtube.json?.destination?.keyHint);
    check('the hint is the tail of the key', youtube.json?.destination?.keyHint === '5678', youtube.json?.destination?.keyHint);
    check('the destination is editable', youtube.json?.destination?.editable === true);

    const custom = await api(`/api/admin/${wid}/stream-destinations`, {
      method: 'POST',
      token,
      body: { platform: 'custom', streamKey: 'zzzz-9999', rtmpUrl: 'rtmp://live.example.com/app' },
    });
    check('a custom destination can be added', custom.status === 201, custom.text?.slice(0, 160));
    check(
      'the custom ingest url is recorded',
      custom.json?.destination?.rtmpHost === 'rtmp://live.example.com/app',
      custom.json?.destination?.rtmpHost
    );

    /* ── duplicates ── */
    const duplicate = await api(`/api/admin/${wid}/stream-destinations`, {
      method: 'POST',
      token,
      body: { platform: 'youtube', streamKey: 'other-key' },
    });
    check('a duplicate platform is rejected', duplicate.status === 400, `got ${duplicate.status}`);

    /* ── list ── */
    const list = await api(`/api/admin/${wid}/stream-destinations`, { token });
    check('both destinations are listed', list.json?.destinations?.length === 2);
    check('the list never leaks a key', !JSON.stringify(list.json).includes('abcd-1234-efgh-5678'));
    check('the list never leaks the custom key', !JSON.stringify(list.json).includes('zzzz-9999'));
    check('the list carries hints', list.json?.destinations?.every((d) => typeof d.keyHint === 'string'));

    /* ── the ffmpeg command ── */
    const ffmpeg = await api(`/api/admin/${wid}/stream-destinations/ffmpeg`, { token });
    check('the ffmpeg command is generated', ffmpeg.status === 200, ffmpeg.text?.slice(0, 160));
    check('the command is a string', typeof ffmpeg.json?.command === 'string');
    check('the command invokes ffmpeg', ffmpeg.json?.command?.includes('ffmpeg'));
    check('the command counts its destinations', ffmpeg.json?.destinationCount === 2, String(ffmpeg.json?.destinationCount));
    check('the command contains the real key', ffmpeg.json?.command?.includes('abcd-1234-efgh-5678'));
    check('the command contains the custom host', ffmpeg.json?.command?.includes('live.example.com'));

    /* ── delete ── */
    const removed = await api(`/api/admin/stream-destinations/${custom.json.destination.id}`, {
      method: 'DELETE',
      token,
    });
    check('a destination can be removed', removed.status === 200 && removed.json?.ok === true);

    const afterDelete = await api(`/api/admin/${wid}/stream-destinations`, { token });
    check('the removed destination is gone', afterDelete.json?.destinations?.length === 1);

    const ghost = await api('/api/admin/stream-destinations/does-not-exist', { method: 'DELETE', token });
    check('an unknown destination is a 404', ghost.status === 404, `got ${ghost.status}`);

    /* ── the LIVE lock ── */
    await api(`/api/admin/webinars/${wid}`, {
      method: 'PATCH',
      token,
      body: { status: 'LIVE', startedAt: new Date().toISOString() },
    });

    const liveList = await api(`/api/admin/${wid}/stream-destinations`, { token });
    check('a live webinar is not editable', liveList.json?.editable === false);
    check('the existing destination is marked read-only', liveList.json?.destinations?.[0]?.editable === false);

    const liveAdd = await api(`/api/admin/${wid}/stream-destinations`, {
      method: 'POST',
      token,
      body: { platform: 'facebook', streamKey: 'fb-key-1234' },
    });
    check('a live webinar refuses a new destination', liveAdd.status === 400, `got ${liveAdd.status}`);

    const liveDelete = await api(`/api/admin/stream-destinations/${youtube.json.destination.id}`, {
      method: 'DELETE',
      token,
    });
    check('a live webinar refuses a removal', liveDelete.status === 400, `got ${liveDelete.status}`);

    /* ── no destinations, no command ── */
    const emptyWebinar = await makeWebinar(token);
    const noDest = await api(`/api/admin/${emptyWebinar.id}/stream-destinations/ffmpeg`, { token });
    check('a command needs a destination', noDest.status === 400, `got ${noDest.status}`);
    await dropWebinar(token, emptyWebinar.id);

    /* ── a missing webinar ── */
    const missing = await api('/api/admin/does-not-exist/stream-destinations', { token });
    check('an unknown webinar is a 404', missing.status === 404, `got ${missing.status}`);
  } finally {
    await dropWebinar(token, wid);
    finish();
  }
});
