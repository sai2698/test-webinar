/**
 * Public API — the token-authenticated `/api/v1` surface.
 *
 * The properties that matter: the plaintext token is shown exactly once and
 * stored hashed, a revoked token stops working immediately, and every response
 * uses the `{ success, data }` envelope so a machine client never has to guess
 * whether a body is a payload or an error.
 */
import { api, createChecker, dropWebinar, login, makeWebinar, runSuite } from './lib/parity-harness.mjs';

runSuite('public api', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  let wid = null;
  let tokenId = null;

  try {
    /* ── token lifecycle ── */
    const list = await api('/api/admin/api-tokens', { token });
    check('the token list is reachable', list.status === 200);
    check('the token list is an array', Array.isArray(list.json?.tokens));

    const made = await api('/api/admin/api-tokens', {
      method: 'POST',
      token,
      body: { name: 'Parity Suite Token' },
    });
    check('a token can be created', made.status === 201, `got ${made.status}`);
    tokenId = made.json?.token?.id;
    const plaintext = made.json?.plaintext;

    check('the token id is returned', Boolean(tokenId));
    check('the plaintext is returned once', typeof plaintext === 'string' && plaintext.length > 20);
    check('a prefix is exposed for identification', typeof made.json?.token?.prefix === 'string');
    check('the prefix is a prefix of the plaintext', plaintext?.startsWith(made.json?.token?.prefix));
    check('the plaintext is not the whole token in the list', made.json?.token?.tokenHash === undefined);

    const listed = await api('/api/admin/api-tokens', { token });
    const row = listed.json?.tokens?.find((t) => t.id === tokenId);
    check('the new token is listed', Boolean(row));
    check('the list never leaks the plaintext', row?.plaintext === undefined);
    check('a fresh token has no lastUsedAt', row?.lastUsedAt === null);

    const noName = await api('/api/admin/api-tokens', { method: 'POST', token, body: { name: '' } });
    check('a token needs a name', noName.status === 400, `got ${noName.status}`);

    /* ── authentication ── */
    const noAuth = await api('/api/v1/webinars');
    check('the v1 api rejects a missing token', noAuth.status === 401, `got ${noAuth.status}`);
    check('the rejection uses the envelope', noAuth.json?.success === false);
    check('the rejection carries a message', typeof noAuth.json?.error === 'string');

    const badAuth = await api('/api/v1/webinars', { token: 'nope-not-a-token' });
    check('the v1 api rejects an unknown token', badAuth.status === 401, `got ${badAuth.status}`);

    /* ── the envelope ── */
    const authed = await api('/api/v1/webinars', { token: plaintext });
    check('a valid token is accepted', authed.status === 200, authed.text?.slice(0, 120));
    check('the response uses the success envelope', authed.json?.success === true);
    check('the payload is nested under data', Array.isArray(authed.json?.data?.webinars));
    check('pagination is present', typeof authed.json?.data?.pagination?.total === 'number');
    check('pagination reports hasMore', typeof authed.json?.data?.pagination?.hasMore === 'boolean');

    const capped = await api('/api/v1/webinars?limit=500', { token: plaintext });
    check('the page size is capped', capped.status === 400, `got ${capped.status}`);

    /* ── a fixture to read back ── */
    const webinar = await makeWebinar(token);
    wid = webinar.id;
    check('a fixture webinar is created', Boolean(wid), webinar.slug);

    const one = await api(`/api/v1/webinars/${webinar.slug}`, { token: plaintext });
    check('a webinar can be read by slug', one.status === 200, one.text?.slice(0, 120));
    check('the webinar carries its slug', one.json?.data?.webinar?.slug === webinar.slug);
    check('the webinar carries a registration count', typeof one.json?.data?.webinar?.registrationCount === 'number');
    check('the webinar carries its custom fields', Array.isArray(one.json?.data?.webinar?.customFields));

    const missing = await api('/api/v1/webinars/no-such-webinar', { token: plaintext });
    check('an unknown webinar is a 404', missing.status === 404, `got ${missing.status}`);
    check('the 404 uses the envelope', missing.json?.success === false);

    /* ── lifecycle ── */
    const status = await api(`/api/v1/webinars/${wid}/status`, { token: plaintext });
    check('the status endpoint is reachable', status.status === 200);
    check('the status is reported', typeof status.json?.data?.status === 'string', status.json?.data?.status);
    check('the status carries no title', status.json?.data?.title === undefined);

    /* ── metrics ── */
    const metrics = await api(`/api/v1/webinars/${wid}/metrics`, { token: plaintext });
    check('metrics are reachable', metrics.status === 200, metrics.text?.slice(0, 120));
    check('metrics report total users', typeof metrics.json?.data?.metrics?.totalUsers === 'number');
    check('metrics report a time series', Array.isArray(metrics.json?.data?.metrics?.timeSeries));
    check('metrics report engagement', typeof metrics.json?.data?.metrics?.engagement === 'object');

    /* ── registrations ── */
    const regs = await api(`/api/v1/webinars/${wid}/registrations`, { token: plaintext });
    check('registrations are reachable', regs.status === 200);
    check('registrations are paginated', typeof regs.json?.data?.pagination?.total === 'number');

    /* ── join tokens ── */
    const jt = await api(`/api/v1/webinars/${wid}/join-tokens`, {
      method: 'POST',
      token: plaintext,
      body: { email: 'api-guest@example.com', name: 'API Guest' },
    });
    check('a join token can be minted', jt.status === 201, jt.text?.slice(0, 120));
    check('the join token is returned', typeof jt.json?.data?.token === 'string');
    check('the join token expires', typeof jt.json?.data?.expiresAt === 'string');
    check('the join token has a use cap', jt.json?.data?.maxUses === 10);
    check('a join url is provided', typeof jt.json?.data?.joinUrl === 'string' && jt.json.data.joinUrl.includes('jt='));

    const badJt = await api(`/api/v1/webinars/${wid}/join-tokens`, {
      method: 'POST',
      token: plaintext,
      body: { email: 'not-an-email', name: 'Nope' },
    });
    check('a malformed join-token email is rejected', badJt.status === 400, `got ${badJt.status}`);

    /* ── write access ── */
    const created = await api('/api/v1/webinars', {
      method: 'POST',
      token: plaintext,
      body: {
        title: `API Created ${Date.now()}`,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        durationMins: 45,
        timezone: 'Asia/Kolkata',
      },
    });
    check('a webinar can be created over the api', created.status === 201, created.text?.slice(0, 160));
    const apiWid = created.json?.data?.webinar?.id;
    check('the created webinar has an id', Boolean(apiWid));

    if (apiWid) {
      const patched = await api(`/api/v1/webinars/${apiWid}`, {
        method: 'PATCH',
        token: plaintext,
        body: { title: 'Renamed over the API' },
      });
      check('a webinar can be patched over the api', patched.status === 200 && patched.json?.data?.webinar?.title === 'Renamed over the API');

      const deleted = await api(`/api/v1/webinars/${apiWid}`, { method: 'DELETE', token: plaintext });
      check('a webinar can be deleted over the api', deleted.status === 200 && deleted.json?.data?.deleted === true);
    }

    /* ── revocation ── */
    const revoked = await api(`/api/admin/api-tokens/${tokenId}`, { method: 'DELETE', token });
    check('a token can be revoked', revoked.status === 200 && revoked.json?.ok === true);

    const afterRevoke = await api('/api/v1/webinars', { token: plaintext });
    check('a revoked token stops working', afterRevoke.status === 401, `got ${afterRevoke.status}`);

    const stillListed = await api('/api/admin/api-tokens', { token });
    const revokedRow = stillListed.json?.tokens?.find((t) => t.id === tokenId);
    check('a revoked token survives for the audit', Boolean(revokedRow));
    check('the revoked row records when', typeof revokedRow?.revokedAt === 'string');
    tokenId = null;
  } finally {
    if (tokenId) await api(`/api/admin/api-tokens/${tokenId}`, { method: 'DELETE', token });
    await dropWebinar(token, wid);
    finish();
  }
});
