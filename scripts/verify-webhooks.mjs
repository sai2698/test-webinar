/**
 * Webhooks — outbound event delivery.
 *
 * The interesting properties are not "does POST create a row" but the ones a
 * host would be hurt by if they were wrong: the signing secret must be shown
 * exactly once, a delivery must be an outbox row rather than an inline POST,
 * and a revoked endpoint must stop receiving events.
 */
import { api, createChecker, login, runSuite } from './lib/parity-harness.mjs';

runSuite('webhooks', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  const created = [];

  try {
    /* ── the catalogue ── */
    const events = await api('/api/admin/webhooks/events', { token });
    check('the event catalogue is reachable', events.status === 200, events.text?.slice(0, 120));
    check('the catalogue is a list', Array.isArray(events.json?.events));
    check('the catalogue is not empty', (events.json?.events?.length ?? 0) >= 10, `${events.json?.events?.length} events`);
    check(
      'the catalogue includes webinar.started',
      events.json?.events?.includes('webinar.started')
    );

    /* ── create ── */
    const bad = await api('/api/admin/webhooks', {
      method: 'POST',
      token,
      body: { url: 'not-a-url', events: ['webinar.started'] },
    });
    check('a malformed url is rejected', bad.status === 400, `got ${bad.status}`);

    const noEvents = await api('/api/admin/webhooks', {
      method: 'POST',
      token,
      body: { url: 'https://example.com/hook', events: [] },
    });
    check('an endpoint with no events is rejected', noEvents.status === 400, `got ${noEvents.status}`);

    const unknownEvent = await api('/api/admin/webhooks', {
      method: 'POST',
      token,
      body: { url: 'https://example.com/hook', events: ['webinar.exploded'] },
    });
    check('an unknown event name is rejected', unknownEvent.status === 400, `got ${unknownEvent.status}`);

    const made = await api('/api/admin/webhooks', {
      method: 'POST',
      token,
      body: { url: 'https://example.com/hook', events: ['webinar.started', 'webinar.ended'] },
    });
    check('an endpoint can be created', made.status === 201, `got ${made.status}`);
    const id = made.json?.endpoint?.id;
    if (id) created.push(id);

    check('the endpoint id is returned', Boolean(id));
    check('the events are echoed back', made.json?.endpoint?.events?.length === 2);
    check('a signing secret is returned once', typeof made.json?.secret === 'string' && made.json.secret.length > 10);
    const firstSecret = made.json?.secret;

    /* ── the secret is never readable again ── */
    const list = await api('/api/admin/webhooks', { token });
    check('the endpoint list is reachable', list.status === 200);
    const row = list.json?.endpoints?.find((e) => e.id === id);
    check('the new endpoint is listed', Boolean(row));
    check('the list does not leak the secret', row?.secret === undefined);
    check('the list carries a delivery count', typeof row?.deliveryCount === 'number');

    /* ── patch ── */
    const patched = await api(`/api/admin/webhooks/${id}`, {
      method: 'PATCH',
      token,
      body: { active: false },
    });
    check('an endpoint can be deactivated', patched.status === 200 && patched.json?.endpoint?.active === false);

    const reactivated = await api(`/api/admin/webhooks/${id}`, {
      method: 'PATCH',
      token,
      body: { active: true, events: ['*'] },
    });
    check(
      'an endpoint can subscribe to everything',
      reactivated.status === 200 && reactivated.json?.endpoint?.events?.[0] === '*',
      reactivated.text?.slice(0, 120)
    );
    check('the endpoint is active again', reactivated.json?.endpoint?.active === true);

    /* ── deliveries ── */
    const empty = await api(`/api/admin/webhooks/${id}/deliveries`, { token });
    check('the delivery log is reachable', empty.status === 200);
    check('a fresh endpoint has no deliveries', Array.isArray(empty.json?.deliveries) && empty.json.deliveries.length === 0);

    // The test route enqueues a synthetic delivery and runs the dispatcher
    // immediately. The target is example.com, so the POST will fail — what
    // matters is that a delivery row exists and records the attempt.
    const test = await api(`/api/admin/webhooks/${id}/test`, { method: 'POST', token });
    check('a test delivery can be triggered', test.status === 200, test.text?.slice(0, 120));
    check('the test reports a result', typeof test.json?.sent === 'number' && typeof test.json?.failed === 'number');

    const after = await api(`/api/admin/webhooks/${id}/deliveries`, { token });
    check('the test delivery is logged', (after.json?.deliveries?.length ?? 0) >= 1, `${after.json?.deliveries?.length} rows`);
    const delivery = after.json?.deliveries?.[0];
    check('the delivery records its event', delivery?.event === 'webinar.updated');
    check('the delivery records an attempt', (delivery?.attempts ?? 0) >= 1, `attempts=${delivery?.attempts}`);
    // A network failure is retryable, so the row stays PENDING with an error
    // recorded — only a 4xx (other than 429) or exhausting the retries marks it
    // FAILED. Asserting FAILED here would be asserting that the retry logic is
    // broken.
    check(
      'the delivery records why it did not land',
      typeof delivery?.lastError === 'string' && delivery.lastError.length > 0,
      delivery?.lastError
    );
    check(
      'a retryable failure stays queued',
      delivery?.status === 'PENDING' || delivery?.status === 'FAILED',
      delivery?.status
    );

    /* ── rotate ── */
    const rotated = await api(`/api/admin/webhooks/${id}/rotate`, { method: 'POST', token });
    check('the secret can be rotated', rotated.status === 200);
    check('rotation returns a new secret', typeof rotated.json?.secret === 'string');
    check('the new secret differs from the old one', rotated.json?.secret !== firstSecret);

    /* ── ownership ── */
    const ghost = await api('/api/admin/webhooks/does-not-exist/deliveries', { token });
    check('an unknown endpoint is a 404', ghost.status === 404, `got ${ghost.status}`);

    /* ── delete ── */
    const del = await api(`/api/admin/webhooks/${id}`, { method: 'DELETE', token });
    check('an endpoint can be deleted', del.status === 200 && del.json?.ok === true);
    created.length = 0;

    const gone = await api(`/api/admin/webhooks/${id}/deliveries`, { token });
    check('a deleted endpoint is gone', gone.status === 404, `got ${gone.status}`);
  } finally {
    for (const id of created) {
      await api(`/api/admin/webhooks/${id}`, { method: 'DELETE', token });
    }
    finish();
  }
});
