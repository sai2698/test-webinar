/**
 * Series — recurring webinars.
 *
 * The recurrence generator is a pure function so it can be previewed before it
 * creates anything. The properties that matter: a preview creates nothing, each
 * occurrence is a full Webinar row (so every other feature works on it with no
 * special cases), and cancelling a series cancels its future occurrences rather
 * than deleting them.
 */
import { api, createChecker, dropWebinar, login, makeWebinar, runSuite } from './lib/parity-harness.mjs';

runSuite('series', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  const created = [];

  try {
    const webinar = await makeWebinar(token);
    created.push(webinar.id);
    check('a fixture webinar is created', Boolean(webinar.id), webinar.slug);

    /* ── empty state ── */
    const none = await api(`/api/admin/${webinar.id}/series`, { token });
    check('the series endpoint is reachable', none.status === 200, none.text?.slice(0, 120));
    check('a plain webinar has no series', none.json?.series === null);
    check('a plain webinar has no occurrences', Array.isArray(none.json?.occurrences) && none.json.occurrences.length === 0);

    /* ── preview ── */
    const preview = await api(`/api/admin/${webinar.id}/series/preview`, {
      method: 'POST',
      token,
      body: { frequency: 'WEEKLY', interval: 1, count: 4, timezone: 'Asia/Kolkata' },
    });
    check('a rule can be previewed', preview.status === 200, preview.text?.slice(0, 160));
    check('the preview returns dates', Array.isArray(preview.json?.occurrences));
    check('the preview returns four dates', preview.json?.occurrences?.length === 4, `${preview.json?.occurrences?.length}`);
    check('the preview reports a total', preview.json?.total === 4);
    check('the dates are ISO strings', typeof preview.json?.occurrences?.[0] === 'string');
    check(
      'the dates are a week apart',
      new Date(preview.json?.occurrences?.[1]) - new Date(preview.json?.occurrences?.[0]) === 7 * 86_400_000
    );

    /* ── a preview must create nothing ── */
    const afterPreview = await api(`/api/admin/${webinar.id}/series`, { token });
    check('a preview creates no series', afterPreview.json?.series === null);

    const badFrequency = await api(`/api/admin/${webinar.id}/series/preview`, {
      method: 'POST',
      token,
      body: { frequency: 'FORTNIGHTLY', interval: 1, count: 4, timezone: 'Asia/Kolkata' },
    });
    check('an unknown frequency is rejected', badFrequency.status === 400, `got ${badFrequency.status}`);

    const zeroCount = await api(`/api/admin/${webinar.id}/series/preview`, {
      method: 'POST',
      token,
      body: { frequency: 'WEEKLY', interval: 1, count: 0, timezone: 'Asia/Kolkata' },
    });
    check('a zero count is rejected', zeroCount.status === 400, `got ${zeroCount.status}`);

    /* ── create ── */
    const made = await api(`/api/admin/${webinar.id}/series`, {
      method: 'POST',
      token,
      body: { frequency: 'WEEKLY', interval: 1, count: 3, timezone: 'Asia/Kolkata' },
    });
    check('a series can be created', made.status === 201, made.text?.slice(0, 160));
    check('the series is returned', Boolean(made.json?.series?.id));
    check('the occurrence count is reported', made.json?.occurrenceCount === 3, String(made.json?.occurrenceCount));
    check('the series records its frequency', made.json?.series?.frequency === 'WEEKLY');
    check('the series records its interval', made.json?.series?.interval === 1);
    check('the series records its count', made.json?.series?.count === 3);
    check('the series is not cancelled', made.json?.series?.cancelledAt === null);

    const seriesId = made.json?.series?.id;

    /* ── the occurrences exist as real webinars ── */
    const read = await api(`/api/admin/${webinar.id}/series`, { token });
    check('the series is readable', read.json?.series?.id === seriesId);
    check('every occurrence exists', read.json?.occurrences?.length === 3, `${read.json?.occurrences?.length}`);
    check('the base webinar is occurrence zero', read.json?.occurrences?.[0]?.id === webinar.id);
    check('the base is indexed at zero', read.json?.occurrences?.[0]?.occurrenceIndex === 0);
    check('the occurrences are ordered', read.json?.occurrences?.[1]?.occurrenceIndex === 1);
    check('each occurrence has its own slug', read.json?.occurrences?.[1]?.slug !== webinar.slug);
    check('each occurrence has a start time', typeof read.json?.occurrences?.[1]?.startsAt === 'string');
    check('the copies are scheduled, not draft', read.json?.occurrences?.[1]?.status === 'SCHEDULED');

    for (const o of read.json?.occurrences ?? []) {
      if (o.id !== webinar.id) created.push(o.id);
    }

    /* ── a webinar cannot join two series ── */
    const twice = await api(`/api/admin/${webinar.id}/series`, {
      method: 'POST',
      token,
      body: { frequency: 'DAILY', interval: 1, count: 2, timezone: 'Asia/Kolkata' },
    });
    check('a webinar cannot join a second series', twice.status === 400, `got ${twice.status}`);

    /* ── an occurrence is a normal webinar ── */
    const occurrence = read.json?.occurrences?.[1];
    const detail = await api(`/api/admin/webinars`, { token });
    const found = detail.json?.webinars?.find((w) => w.id === occurrence?.id);
    check('an occurrence appears in the webinar list', Boolean(found));
    check('an occurrence carries the base title', found?.title === webinar.title);

    /* ── cancel ── */
    const cancelled = await api(`/api/admin/series/${seriesId}`, { method: 'DELETE', token });
    check('a series can be cancelled', cancelled.status === 200, cancelled.text?.slice(0, 120));
    check('cancelling reports the affected occurrences', typeof cancelled.json?.cancelledOccurrences === 'number', String(cancelled.json?.cancelledOccurrences));

    const afterCancel = await api(`/api/admin/${webinar.id}/series`, { token });
    check('the series records its cancellation', typeof afterCancel.json?.series?.cancelledAt === 'string');
    check('the occurrences survive the cancellation', afterCancel.json?.occurrences?.length === 3);

    /* ── a missing webinar ── */
    const missing = await api('/api/admin/does-not-exist/series', { token });
    check('an unknown webinar is a 404', missing.status === 404, `got ${missing.status}`);
  } finally {
    for (const id of created) await dropWebinar(token, id);
    finish();
  }
});
