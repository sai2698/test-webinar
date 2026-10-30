/**
 * Embed — framing the room on someone else's page.
 *
 * The one property that must hold: a wildcard origin is rejected. `*` in an
 * allow-list is the same as no allow-list, and the whole point of the list is
 * to stop a random page framing a private room.
 */
import { api, createChecker, dropWebinar, login, makeWebinar, runSuite } from './lib/parity-harness.mjs';

runSuite('embed', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  let wid = null;

  try {
    const webinar = await makeWebinar(token);
    wid = webinar.id;
    check('a fixture webinar is created', Boolean(wid), webinar.slug);

    /* ── defaults ── */
    const initial = await api(`/api/admin/${wid}/embed`, { token });
    check('the embed config is reachable', initial.status === 200, initial.text?.slice(0, 120));
    check('embedding is off by default', initial.json?.embed?.enabled === false);
    check('the allow-list starts empty', Array.isArray(initial.json?.embed?.allowedOrigins) && initial.json.embed.allowedOrigins.length === 0);
    check('a snippet is provided', typeof initial.json?.snippet === 'string');
    check('the snippet is an iframe', initial.json?.snippet?.includes('<iframe'));
    check('the snippet points at the embed route', initial.json?.snippet?.includes('/embed/'));
    check('the snippet carries the slug', initial.json?.snippet?.includes(webinar.slug));
    check(
      'the snippet grants camera and microphone',
      initial.json?.snippet?.includes('camera') && initial.json?.snippet?.includes('microphone')
    );

    /* ── enable ── */
    const enabled = await api(`/api/admin/${wid}/embed`, {
      method: 'PATCH',
      token,
      body: { enabled: true, allowedOrigins: ['https://example.com', 'https://partner.example.org'] },
    });
    check('embedding can be enabled', enabled.status === 200, enabled.text?.slice(0, 120));
    check('the enabled flag is stored', enabled.json?.embed?.enabled === true);
    check('the allow-list is stored', enabled.json?.embed?.allowedOrigins?.length === 2);
    check('the origins are preserved verbatim', enabled.json?.embed?.allowedOrigins?.includes('https://example.com'));

    /* ── the wildcard must be refused ── */
    const wildcard = await api(`/api/admin/${wid}/embed`, {
      method: 'PATCH',
      token,
      body: { enabled: true, allowedOrigins: ['*'] },
    });
    check('a bare wildcard origin is rejected', wildcard.status === 400, `got ${wildcard.status}`);

    const wildcardHost = await api(`/api/admin/${wid}/embed`, {
      method: 'PATCH',
      token,
      body: { enabled: true, allowedOrigins: ['https://*.example.com'] },
    });
    check('a wildcard subdomain is rejected', wildcardHost.status === 400, `got ${wildcardHost.status}`);

    const notAUrl = await api(`/api/admin/${wid}/embed`, {
      method: 'PATCH',
      token,
      body: { enabled: true, allowedOrigins: ['example.com'] },
    });
    check('an origin without a scheme is rejected', notAUrl.status === 400, `got ${notAUrl.status}`);

    const tooMany = await api(`/api/admin/${wid}/embed`, {
      method: 'PATCH',
      token,
      body: {
        enabled: true,
        allowedOrigins: Array.from({ length: 21 }, (_, i) => `https://site${i}.example.com`),
      },
    });
    check('the allow-list is capped', tooMany.status === 400, `got ${tooMany.status}`);

    /* ── the rejected writes must not have changed anything ── */
    const unchanged = await api(`/api/admin/${wid}/embed`, { token });
    check('a rejected write leaves the config intact', unchanged.json?.embed?.allowedOrigins?.length === 2);

    /* ── the public policy ── */
    const policy = await api(`/api/webinars/${webinar.slug}/embed-policy`);
    check('the public policy is reachable without auth', policy.status === 200, `got ${policy.status}`);
    check('the public policy reports enabled', policy.json?.embed?.enabled === true);
    check('the public policy lists the origins', policy.json?.embed?.allowedOrigins?.length === 2);
    check('the public policy leaks nothing else', policy.json?.embed?.title === undefined && policy.json?.embed?.slug === undefined);

    const ghost = await api('/api/webinars/no-such-webinar/embed-policy');
    check('an unknown slug is a 404', ghost.status === 404, `got ${ghost.status}`);

    /* ── disable ── */
    const disabled = await api(`/api/admin/${wid}/embed`, {
      method: 'PATCH',
      token,
      body: { enabled: false, allowedOrigins: [] },
    });
    check('embedding can be disabled', disabled.status === 200 && disabled.json?.embed?.enabled === false);
    check('disabling clears the allow-list', disabled.json?.embed?.allowedOrigins?.length === 0);

    const policyOff = await api(`/api/webinars/${webinar.slug}/embed-policy`);
    check('the public policy reflects the change', policyOff.json?.embed?.enabled === false);

    /* ── a missing webinar ── */
    const missing = await api('/api/admin/does-not-exist/embed', { token });
    check('an unknown webinar is a 404', missing.status === 404, `got ${missing.status}`);
  } finally {
    await dropWebinar(token, wid);
    finish();
  }
});
