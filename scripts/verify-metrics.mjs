/**
 * Metrics — the post-webinar report.
 *
 * The property that matters most: the cache is only served for an ENDED
 * webinar. Serving a cached report for a LIVE one would show a host numbers
 * that are still moving, and they would reasonably conclude the feature is
 * broken.
 */
import { api, createChecker, dropWebinar, login, makeWebinar, register, runSuite } from './lib/parity-harness.mjs';

runSuite('metrics', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  let wid = null;

  try {
    const webinar = await makeWebinar(token);
    wid = webinar.id;
    check('a fixture webinar is created', Boolean(wid), webinar.slug);

    /* ── a token to reach the v1 api ── */
    const minted = await api('/api/admin/api-tokens', {
      method: 'POST',
      token,
      body: { name: `metrics-${Date.now()}` },
    });
    const apiToken = minted.json?.plaintext;
    check('an api token is minted', typeof apiToken === 'string' && apiToken.startsWith('nxl_'));
    const tokenId = minted.json?.token?.id;

    try {
      /* ── a draft webinar ── */
      const draft = await api(`/api/v1/webinars/${wid}/metrics`, { token: apiToken });
      check('metrics are reachable', draft.status === 200, draft.text?.slice(0, 160));
      check('the payload is nested under data', Boolean(draft.json?.data?.metrics));
      check('total users is reported', typeof draft.json?.data?.metrics?.totalUsers === 'number');
      check('max live users is reported', typeof draft.json?.data?.metrics?.maxLiveUsers === 'number');
      check('duration is reported', typeof draft.json?.data?.metrics?.durationMinutes === 'number');
      check('a time series is reported', Array.isArray(draft.json?.data?.metrics?.timeSeries));
      check('engagement is reported', typeof draft.json?.data?.metrics?.engagement === 'object');
      check('a computed timestamp is reported', typeof draft.json?.data?.metrics?.computedAt === 'string');

      /* ── registrations must move the number ── */
      for (let i = 0; i < 3; i += 1) {
        await register(webinar.slug, `Metric Tester ${i}`, `metric${i}-${Date.now()}@example.com`);
      }

      const afterRegs = await api(`/api/v1/webinars/${wid}/metrics`, { token: apiToken });
      check(
        'registrations are counted',
        afterRegs.json?.data?.metrics?.totalUsers >= 3,
        String(afterRegs.json?.data?.metrics?.totalUsers)
      );

      /* ── a live webinar must not serve a stale cache ── */
      await api(`/api/admin/webinars/${wid}`, {
        method: 'PATCH',
        token,
        body: { status: 'LIVE', startedAt: new Date().toISOString() },
      });

      const live = await api(`/api/v1/webinars/${wid}/metrics`, { token: apiToken });
      check('a live webinar still reports metrics', live.status === 200, `got ${live.status}`);
      check(
        'a live webinar recomputes rather than serving the cache',
        live.json?.data?.metrics?.computedAt !== afterRegs.json?.data?.metrics?.computedAt,
        `${live.json?.data?.metrics?.computedAt} vs ${afterRegs.json?.data?.metrics?.computedAt}`
      );

      /* ── ending it writes the cache ── */
      await api(`/api/admin/webinars/${wid}`, {
        method: 'PATCH',
        token,
        body: { status: 'ENDED' },
      });

      const ended = await api(`/api/v1/webinars/${wid}/metrics`, { token: apiToken });
      check('an ended webinar reports metrics', ended.status === 200);
      const firstComputedAt = ended.json?.data?.metrics?.computedAt;

      const again = await api(`/api/v1/webinars/${wid}/metrics`, { token: apiToken });
      check(
        'an ended webinar serves the cache',
        again.json?.data?.metrics?.computedAt === firstComputedAt,
        `${again.json?.data?.metrics?.computedAt} vs ${firstComputedAt}`
      );
      check('the cached report still counts users', again.json?.data?.metrics?.totalUsers >= 3);

      /* ── the cache row exists ── */
      const stored = await api(`/api/admin/webinars`, { token });
      const row = stored.json?.webinars?.find((w) => w.id === wid);
      check('the webinar is still listed after ending', Boolean(row));
      check('the webinar reports its ended status', row?.status === 'ENDED', row?.status);

      /* ── an unknown webinar ── */
      const missing = await api('/api/v1/webinars/does-not-exist/metrics', { token: apiToken });
      check('an unknown webinar is a 404', missing.status === 404, `got ${missing.status}`);
      check('the 404 uses the envelope', missing.json?.success === false);
    } finally {
      if (tokenId) await api(`/api/admin/api-tokens/${tokenId}`, { method: 'DELETE', token });
    }
  } finally {
    await dropWebinar(token, wid);
    finish();
  }
});
