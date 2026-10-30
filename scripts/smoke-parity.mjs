/**
 * Smoke test for the webinar.gg parity endpoints.
 *
 * Not a full verification suite — it exists to prove every new router is
 * mounted, reachable, and returns the shape the client expects. The per-feature
 * suites go deeper.
 */
const API = 'http://localhost:4000';

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  return { status: res.status, json };
}

async function main() {
  console.log('\n=== parity smoke test ===\n');

  const health = await api('/api/health');
  check('health responds', health.status === 200 && health.json?.ok === true);

  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@webinar.local', password: 'Admin@12345' },
  });
  check('admin login', login.status === 200 && Boolean(login.json?.token), JSON.stringify(login.json));
  const token = login.json?.token;
  if (!token) {
    console.log('\nCannot continue without a token.');
    process.exitCode = 1;
    return;
  }

  const webinars = await api('/api/admin/webinars', { token });
  check('admin webinars list', webinars.status === 200 && Array.isArray(webinars.json?.webinars));
  const webinar = webinars.json?.webinars?.find((w) => w.slug === 'live-product-teardown')
    ?? webinars.json?.webinars?.[0];
  check('found a webinar', Boolean(webinar));
  if (!webinar) {
    process.exitCode = 1;
    return;
  }
  const wid = webinar.id;
  console.log(`  using webinar ${webinar.slug} (${wid})\n`);

  /* ── custom fields ── */
  const cfList = await api(`/api/admin/${wid}/custom-fields`, { token });
  check('GET custom-fields', cfList.status === 200 && Array.isArray(cfList.json?.fields));

  const cfCreate = await api(`/api/admin/${wid}/custom-fields`, {
    method: 'POST',
    token,
    body: { label: 'Company', type: 'text', isRequired: false },
  });
  check('POST custom-field', cfCreate.status === 201 && Boolean(cfCreate.json?.field?.id), JSON.stringify(cfCreate.json));
  const fieldId = cfCreate.json?.field?.id;

  const cfOption = await api(`/api/admin/${wid}/custom-fields`, {
    method: 'POST',
    token,
    body: {
      label: 'Team size',
      type: 'select',
      options: [{ label: '1-10' }, { label: '11-50' }],
    },
  });
  check('POST custom-field with options', cfOption.status === 201 && cfOption.json?.field?.options?.length === 2, JSON.stringify(cfOption.json));
  // Both fields must be cleaned up, not just the first — a suite that leaves a
  // row behind makes the next run's list assertion drift and litters the demo.
  const optionFieldId = cfOption.json?.field?.id;

  const cfBad = await api(`/api/admin/${wid}/custom-fields`, {
    method: 'POST',
    token,
    body: { label: 'Bad', type: 'select' },
  });
  check('select without options is rejected', cfBad.status === 400, `got ${cfBad.status}`);

  const form = await api(`/api/webinars/${webinar.slug}/form`);
  check('public form endpoint', form.status === 200 && Array.isArray(form.json?.fields));

  if (fieldId) {
    const cfDel = await api(`/api/admin/custom-fields/${fieldId}`, { method: 'DELETE', token });
    check('DELETE custom-field', cfDel.status === 200);
  }
  if (optionFieldId) {
    const cfDel2 = await api(`/api/admin/custom-fields/${optionFieldId}`, { method: 'DELETE', token });
    check('DELETE custom-field with options', cfDel2.status === 200);
  }

  /* ── cohosts ── */
  const cohostList = await api(`/api/admin/${wid}/cohosts`, { token });
  check('GET cohosts', cohostList.status === 200 && Array.isArray(cohostList.json?.cohosts));
  check('cohost cap exposed', cohostList.json?.maxCohosts === 10);

  const cohostAdd = await api(`/api/admin/${wid}/cohosts`, {
    method: 'POST',
    token,
    body: { email: 'smoke-cohost@example.com', name: 'Smoke Cohost' },
  });
  check('POST cohost', cohostAdd.status === 201 && Boolean(cohostAdd.json?.cohost?.id), JSON.stringify(cohostAdd.json));
  const cohostId = cohostAdd.json?.cohost?.id;

  const cohostDup = await api(`/api/admin/${wid}/cohosts`, {
    method: 'POST',
    token,
    body: { email: 'smoke-cohost@example.com' },
  });
  check('duplicate cohost rejected', cohostDup.status === 409 || cohostDup.status === 400, `got ${cohostDup.status}`);

  const policy = await api(`/api/admin/${wid}/cohost-policy/me`, { token });
  check('GET cohost-policy/me', policy.status === 200 && policy.json?.isOwner === true);

  if (cohostId) {
    const cohostDel = await api(`/api/admin/cohosts/${cohostId}`, { method: 'DELETE', token });
    check('DELETE cohost', cohostDel.status === 200);
  }

  /* ── stream destinations ── */
  // Destinations are locked once a webinar is live, so this section needs a
  // webinar that has not started. That lock is itself a feature — a stream key
  // swapped mid-broadcast would silently kill the feed. Every seeded webinar is
  // LIVE or ENDED, so the test creates its own draft.
  const draft = await api('/api/admin/webinars', {
    method: 'POST',
    token,
    body: {
      title: `Smoke Draft ${Date.now()}`,
      description: 'Temporary webinar for the parity smoke test',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      durationMins: 60,
      timezone: 'Asia/Kolkata',
      status: 'DRAFT',
      moderatorIds: [],
      settings: {},
    },
  });
  check('created a draft webinar', draft.status === 201 && Boolean(draft.json?.webinar?.id), JSON.stringify(draft.json).slice(0, 300));
  const sid = draft.json?.webinar?.id ?? wid;

  const streams = await api(`/api/admin/${sid}/stream-destinations`, { token });
  check('GET stream-destinations', streams.status === 200 && Array.isArray(streams.json?.destinations));

  const streamAdd = await api(`/api/admin/${sid}/stream-destinations`, {
    method: 'POST',
    token,
    body: { platform: 'youtube', streamKey: 'abcd-efgh-ijkl-mnop' },
  });
  check('POST stream-destination', streamAdd.status === 201 && Boolean(streamAdd.json?.destination?.id), JSON.stringify(streamAdd.json));
  check('stream key is not echoed', !JSON.stringify(streamAdd.json ?? {}).includes('abcd-efgh-ijkl-mnop'));
  check('key hint is last 4', streamAdd.json?.destination?.keyHint === 'mnop', streamAdd.json?.destination?.keyHint);

  const ffmpeg = await api(`/api/admin/${sid}/stream-destinations/ffmpeg`, { token });
  check('GET ffmpeg command', ffmpeg.status === 200 && typeof ffmpeg.json?.command === 'string');
  check('ffmpeg command contains the key', String(ffmpeg.json?.command ?? '').includes('abcd-efgh-ijkl-mnop'));

  const streamId = streamAdd.json?.destination?.id;
  if (streamId) {
    const streamDel = await api(`/api/admin/stream-destinations/${streamId}`, { method: 'DELETE', token });
    check('DELETE stream-destination', streamDel.status === 200);
  }

  // The lock itself is worth asserting: a live webinar must refuse a new key.
  const lockedAdd = await api(`/api/admin/${wid}/stream-destinations`, {
    method: 'POST',
    token,
    body: { platform: 'twitch', streamKey: 'live-key-1234' },
  });
  check(
    'live webinar refuses a new stream destination',
    webinar.status !== 'LIVE' || lockedAdd.status === 400,
    `status ${webinar.status}, got ${lockedAdd.status}`
  );

  if (draft.json?.webinar?.id) {
    await api(`/api/admin/webinars/${draft.json.webinar.id}`, { method: 'DELETE', token });
  }

  /* ── webhooks ── */
  const hooks = await api('/api/admin/webhooks', { token });
  check('GET webhooks', hooks.status === 200 && Array.isArray(hooks.json?.endpoints));

  const hookEvents = await api('/api/admin/webhooks/events', { token });
  check('GET webhook event catalogue', hookEvents.status === 200 && Array.isArray(hookEvents.json?.events));

  const hookAdd = await api('/api/admin/webhooks', {
    method: 'POST',
    token,
    body: { url: 'https://example.com/hook', events: ['webinar.created'] },
  });
  check('POST webhook', hookAdd.status === 201 && Boolean(hookAdd.json?.endpoint?.id), JSON.stringify(hookAdd.json));
  check('webhook secret shown once', typeof hookAdd.json?.secret === 'string' && hookAdd.json.secret.length > 20);

  const hookId = hookAdd.json?.endpoint?.id;
  if (hookId) {
    const deliveries = await api(`/api/admin/webhooks/${hookId}/deliveries`, { token });
    check('GET webhook deliveries', deliveries.status === 200 && Array.isArray(deliveries.json?.deliveries));

    const rotate = await api(`/api/admin/webhooks/${hookId}/rotate`, { method: 'POST', token });
    check('POST webhook rotate', rotate.status === 200 && typeof rotate.json?.secret === 'string');

    const hookDel = await api(`/api/admin/webhooks/${hookId}`, { method: 'DELETE', token });
    check('DELETE webhook', hookDel.status === 200);
  }

  /* ── api tokens + public API ── */
  const tokens = await api('/api/admin/api-tokens', { token });
  check('GET api-tokens', tokens.status === 200 && Array.isArray(tokens.json?.tokens));

  const tokenCreate = await api('/api/admin/api-tokens', {
    method: 'POST',
    token,
    body: { name: 'smoke' },
  });
  check('POST api-token', tokenCreate.status === 201 && typeof tokenCreate.json?.plaintext === 'string', JSON.stringify(tokenCreate.json));
  const apiToken = tokenCreate.json?.plaintext;

  if (apiToken) {
    const v1 = await api('/api/v1/webinars', { token: apiToken });
    check('GET /api/v1/webinars', v1.status === 200 && v1.json?.success === true && Array.isArray(v1.json?.data?.webinars), JSON.stringify(v1.json).slice(0, 200));
    check('v1 envelope has pagination', Boolean(v1.json?.data?.pagination));

    const v1One = await api(`/api/v1/webinars/${webinar.slug}`, { token: apiToken });
    check('GET /api/v1/webinars/:slug', v1One.status === 200 && v1One.json?.data?.webinar?.slug === webinar.slug);

    const v1Status = await api(`/api/v1/webinars/${webinar.slug}/status`, { token: apiToken });
    check('GET /api/v1 status', v1Status.status === 200 && typeof v1Status.json?.data?.status === 'string');

    const v1Metrics = await api(`/api/v1/webinars/${webinar.slug}/metrics`, { token: apiToken });
    check('GET /api/v1 metrics', v1Metrics.status === 200 && typeof v1Metrics.json?.data?.metrics?.totalUsers === 'number', JSON.stringify(v1Metrics.json).slice(0, 200));

    const v1Regs = await api(`/api/v1/webinars/${webinar.slug}/registrations`, { token: apiToken });
    check('GET /api/v1 registrations', v1Regs.status === 200 && Array.isArray(v1Regs.json?.data?.registrations));

    const v1Join = await api(`/api/v1/webinars/${webinar.slug}/join-tokens`, {
      method: 'POST',
      token: apiToken,
      body: { email: 'smoke@example.com', name: 'Smoke' },
    });
    check('POST /api/v1 join-tokens', v1Join.status === 201 && typeof v1Join.json?.data?.token === 'string', JSON.stringify(v1Join.json).slice(0, 200));

    const v1NoAuth = await api('/api/v1/webinars');
    check('v1 rejects missing token', v1NoAuth.status === 401);

    const v1BadAuth = await api('/api/v1/webinars', { token: 'nxl_deadbeef' });
    check('v1 rejects unknown token', v1BadAuth.status === 401);

    const tokenId = tokenCreate.json?.token?.id;
    if (tokenId) {
      const revoke = await api(`/api/admin/api-tokens/${tokenId}`, { method: 'DELETE', token });
      check('DELETE api-token', revoke.status === 200);

      const afterRevoke = await api('/api/v1/webinars', { token: apiToken });
      check('revoked token is rejected', afterRevoke.status === 401, `got ${afterRevoke.status}`);
    }
  }

  /* ── embed ── */
  const embed = await api(`/api/admin/${wid}/embed`, { token });
  check('GET embed', embed.status === 200 && typeof embed.json?.embed?.enabled === 'boolean');
  check('embed snippet present', String(embed.json?.snippet ?? '').includes('<iframe'));

  const embedSet = await api(`/api/admin/${wid}/embed`, {
    method: 'PATCH',
    token,
    body: { enabled: true, allowedOrigins: ['https://example.com'] },
  });
  check('PATCH embed', embedSet.status === 200 && embedSet.json?.embed?.enabled === true);

  const embedWild = await api(`/api/admin/${wid}/embed`, {
    method: 'PATCH',
    token,
    body: { enabled: true, allowedOrigins: ['https://*.example.com'] },
  });
  check('embed rejects wildcard origin', embedWild.status === 400, `got ${embedWild.status}`);

  const embedPublic = await api(`/api/webinars/${webinar.slug}/embed-policy`);
  check('public embed-policy', embedPublic.status === 200 && embedPublic.json?.embed?.enabled === true);

  await api(`/api/admin/${wid}/embed`, {
    method: 'PATCH',
    token,
    body: { enabled: false, allowedOrigins: [] },
  });

  /* ── analytics ── */
  const analytics = await api(`/api/admin/${wid}/analytics-config`, { token });
  check('GET analytics-config', analytics.status === 200 && analytics.json?.config !== undefined);

  const analyticsSet = await api(`/api/admin/${wid}/analytics-config`, {
    method: 'PATCH',
    token,
    body: { ga4MeasurementId: 'G-ABC123XYZ', metaPixelId: null, clarityProjectId: null, gtmContainerId: null },
  });
  check('PATCH analytics-config', analyticsSet.status === 200 && analyticsSet.json?.config?.ga4MeasurementId === 'G-ABC123XYZ', JSON.stringify(analyticsSet.json));

  const analyticsBad = await api(`/api/admin/${wid}/analytics-config`, {
    method: 'PATCH',
    token,
    body: { ga4MeasurementId: 'not-a-ga4-id' },
  });
  check('analytics rejects malformed GA4 id', analyticsBad.status === 400, `got ${analyticsBad.status}`);

  const analyticsPublic = await api(`/api/webinars/${webinar.slug}/analytics-config`);
  check('public analytics-config', analyticsPublic.status === 200 && analyticsPublic.json?.config?.ga4MeasurementId === 'G-ABC123XYZ');

  await api(`/api/admin/${wid}/analytics-config`, {
    method: 'PATCH',
    token,
    body: { ga4MeasurementId: null, metaPixelId: null, clarityProjectId: null, gtmContainerId: null },
  });

  /* ── automation ── */
  const bundle = {
    version: 1,
    personas: [
      { id: 'p1', name: 'Asha', email: 'asha@example.com', weights: { chat: 2, qna: 1, poll: 1 } },
      { id: 'p2', name: 'Ravi', email: 'ravi@example.com', weights: { chat: 1, qna: 2, poll: 1 } },
    ],
    attendance: [
      { atMs: 0, count: 0 },
      { atMs: 60_000, count: 12 },
      { atMs: 300_000, count: 40 },
    ],
    chat: [{ atMs: 30_000, personaId: 'p1', text: 'Hello everyone!' }],
    qna: [{ atMs: 120_000, personaId: 'p2', text: 'Will this be recorded?' }],
    cues: [{ atMs: 600_000, kind: 'poll', payload: { question: 'Ready?' } }],
  };

  const autoImport = await api(`/api/admin/${wid}/automation/import`, {
    method: 'POST',
    token,
    body: bundle,
  });
  check('POST automation import', autoImport.status === 201 && autoImport.json?.summary?.personas === 2, JSON.stringify(autoImport.json).slice(0, 300));
  check('automation created cues', autoImport.json?.cues?.length === 1);

  const autoBadRef = await api(`/api/admin/${wid}/automation/import`, {
    method: 'POST',
    token,
    body: { ...bundle, chat: [{ atMs: 0, personaId: 'ghost', text: 'hi' }] },
  });
  check('automation rejects unknown persona', autoBadRef.status === 400, `got ${autoBadRef.status}`);

  const autoUnknownKey = await api(`/api/admin/${wid}/automation/import`, {
    method: 'POST',
    token,
    body: { ...bundle, bogusKey: true },
  });
  check('automation rejects unknown top-level key', autoUnknownKey.status === 400, `got ${autoUnknownKey.status}`);

  const autoCues = await api(`/api/admin/${wid}/automation/cues`, { token });
  check('GET automation cues', autoCues.status === 200 && autoCues.json?.cues?.length === 1);

  const cueId = autoCues.json?.cues?.[0]?.id;
  if (cueId) {
    const cuePatch = await api(`/api/admin/automation/cues/${cueId}`, {
      method: 'PATCH',
      token,
      body: { enabled: false },
    });
    check('PATCH automation cue', cuePatch.status === 200 && cuePatch.json?.cue?.enabled === false);
  }

  const autoReset = await api(`/api/admin/${wid}/automation/reset`, { method: 'POST', token });
  check('POST automation reset', autoReset.status === 200);

  const autoExport = await fetch(`${API}/api/admin/${wid}/automation/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const exportText = await autoExport.text();
  check('GET automation export', autoExport.status === 200 && exportText.includes('"version": 1'));
  check('export is a download', String(autoExport.headers.get('content-disposition') ?? '').includes('attachment'));

  /* ── series ── */
  const seriesPreview = await api(`/api/admin/${wid}/series/preview`, {
    method: 'POST',
    token,
    body: { frequency: 'WEEKLY', interval: 1, byWeekday: [], count: 4 },
  });
  check('POST series preview', seriesPreview.status === 200 && seriesPreview.json?.total === 4, JSON.stringify(seriesPreview.json).slice(0, 200));

  const seriesGet = await api(`/api/admin/${wid}/series`, { token });
  check('GET series', seriesGet.status === 200 && seriesGet.json?.series === null);

  /* ── registrations admin ── */
  const regs = await api(`/api/admin/${wid}/registrations`, { token });
  check('GET admin registrations', regs.status === 200 && Array.isArray(regs.json?.registrations));
  check('registration counts present', typeof regs.json?.counts?.APPROVED === 'number', JSON.stringify(regs.json?.counts));

  const csv = await fetch(`${API}/api/admin/${wid}/registrations/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const csvText = await csv.text();
  check('GET registrations CSV', csv.status === 200 && csvText.split('\n').length > 1);
  check('CSV is a download', String(csv.headers.get('content-disposition') ?? '').includes('attachment'));

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exitCode = 1;
});
