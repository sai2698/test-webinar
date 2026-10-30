/**
 * Automation — the rehearsal bundle.
 *
 * The bundle is a single artefact that is imported as a full replace. The
 * properties that matter: it is validated strictly (a typo'd key must not
 * import "successfully" and then do nothing), every chat line must reference a
 * persona that exists, and `reset` must clear `firedAt` so a second rehearsal
 * is not a silent no-op.
 */
import { api, createChecker, dropWebinar, login, makeWebinar, runSuite } from './lib/parity-harness.mjs';

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
  chat: [
    { atMs: 30_000, personaId: 'p1', text: 'Good morning everyone' },
    { atMs: 90_000, personaId: 'p2', text: 'Audio is clear here' },
  ],
  qna: [{ atMs: 120_000, personaId: 'p2', text: 'Will this be recorded?' }],
  cues: [
    { atMs: 600_000, kind: 'poll', payload: { question: 'Ready to continue?' } },
    { atMs: 1_200_000, kind: 'offer', payload: { title: 'Early bird' } },
  ],
};

runSuite('automation', async () => {
  const { check, finish } = createChecker();
  const { token } = await login();

  let wid = null;

  try {
    const webinar = await makeWebinar(token);
    wid = webinar.id;
    check('a fixture webinar is created', Boolean(wid), webinar.slug);

    /* ── empty state ── */
    const empty = await api(`/api/admin/${wid}/automation/cues`, { token });
    check('the cue list is reachable', empty.status === 200, empty.text?.slice(0, 120));
    check('a fresh webinar has no cues', Array.isArray(empty.json?.cues) && empty.json.cues.length === 0);
    check('a fresh webinar has an empty bundle', empty.json?.bundle?.version === 1);

    /* ── strict validation ── */
    const unknownKey = await api(`/api/admin/${wid}/automation/import`, {
      method: 'POST',
      token,
      body: { ...bundle, surprise: true },
    });
    check('an unknown top-level key is rejected', unknownKey.status === 400, `got ${unknownKey.status}`);

    const badVersion = await api(`/api/admin/${wid}/automation/import`, {
      method: 'POST',
      token,
      body: { ...bundle, version: 2 },
    });
    check('an unknown bundle version is rejected', badVersion.status === 400, `got ${badVersion.status}`);

    const badPersona = await api(`/api/admin/${wid}/automation/import`, {
      method: 'POST',
      token,
      body: {
        ...bundle,
        chat: [{ atMs: 1000, personaId: 'ghost', text: 'Who am I?' }],
      },
    });
    check('a chat line from an unknown persona is rejected', badPersona.status === 400, `got ${badPersona.status}`);
    check(
      'the rejection names the bad reference',
      JSON.stringify(badPersona.json?.details ?? {}).includes('ghost'),
      JSON.stringify(badPersona.json?.details ?? {}).slice(0, 120)
    );

    const badQna = await api(`/api/admin/${wid}/automation/import`, {
      method: 'POST',
      token,
      body: { ...bundle, qna: [{ atMs: 1000, personaId: 'nobody', text: 'Hello?' }] },
    });
    check('a question from an unknown persona is rejected', badQna.status === 400, `got ${badQna.status}`);

    const backwards = await api(`/api/admin/${wid}/automation/import`, {
      method: 'POST',
      token,
      body: {
        ...bundle,
        attendance: [
          { atMs: 60_000, count: 10 },
          { atMs: 30_000, count: 20 },
        ],
      },
    });
    check('a backwards attendance curve is rejected', backwards.status === 400, `got ${backwards.status}`);

    const duplicatePersona = await api(`/api/admin/${wid}/automation/import`, {
      method: 'POST',
      token,
      body: {
        ...bundle,
        personas: [
          { id: 'p1', name: 'A', email: 'a@example.com' },
          { id: 'p1', name: 'B', email: 'b@example.com' },
        ],
        chat: [],
        qna: [],
      },
    });
    check('duplicate persona ids are rejected', duplicatePersona.status === 400, `got ${duplicatePersona.status}`);

    /* ── a rejected import must not have written anything ── */
    const stillEmpty = await api(`/api/admin/${wid}/automation/cues`, { token });
    check('a rejected import writes nothing', stillEmpty.json?.cues?.length === 0);

    /* ── a good import ── */
    const imported = await api(`/api/admin/${wid}/automation/import`, {
      method: 'POST',
      token,
      body: bundle,
    });
    check('a valid bundle imports', imported.status === 201, imported.text?.slice(0, 160));
    check('the bundle is echoed back', imported.json?.bundle?.personas?.length === 2);
    check('the cues are created', imported.json?.cues?.length === 2);
    check('the summary counts personas', imported.json?.summary?.personas === 2);
    check('the summary counts chat lines', imported.json?.summary?.chatLines === 2);
    check('the summary counts questions', imported.json?.summary?.questions === 1);
    check('the summary counts cues', imported.json?.summary?.cues === 2);

    const cue = imported.json?.cues?.[0];
    check('a cue carries its kind', cue?.kind === 'poll', cue?.kind);
    check('a cue carries its offset', cue?.atMs === 600_000, String(cue?.atMs));
    check('a cue carries its payload', cue?.payload?.question === 'Ready to continue?');
    check('a cue starts enabled', cue?.enabled === true);
    check('a cue has not fired yet', cue?.firedAt === null);

    /* ── read back ── */
    const read = await api(`/api/admin/${wid}/automation/cues`, { token });
    check('the cues are readable', read.json?.cues?.length === 2);
    check('the cues are ordered by time', read.json?.cues?.[0]?.atMs <= read.json?.cues?.[1]?.atMs);
    check('the bundle survives the round trip', read.json?.bundle?.attendance?.length === 3);

    /* ── patch a cue ── */
    const cueId = read.json?.cues?.[0]?.id;
    const patched = await api(`/api/admin/automation/cues/${cueId}`, {
      method: 'PATCH',
      token,
      body: { enabled: false, atMs: 900_000 },
    });
    check('a cue can be disabled', patched.status === 200 && patched.json?.cue?.enabled === false);
    check('a cue can be retimed', patched.json?.cue?.atMs === 900_000);

    const badPatch = await api(`/api/admin/automation/cues/${cueId}`, {
      method: 'PATCH',
      token,
      body: { atMs: -5 },
    });
    check('a negative offset is ignored', badPatch.status === 200 && badPatch.json?.cue?.atMs === 900_000);

    const ghostCue = await api('/api/admin/automation/cues/does-not-exist', {
      method: 'PATCH',
      token,
      body: { enabled: true },
    });
    check('an unknown cue is a 404', ghostCue.status === 404, `got ${ghostCue.status}`);

    /* ── reset ── */
    const reset = await api(`/api/admin/${wid}/automation/reset`, { method: 'POST', token });
    check('the bundle can be reset', reset.status === 200 && reset.json?.ok === true);
    check('reset reports how many cues it cleared', typeof reset.json?.reset === 'number', String(reset.json?.reset));

    /* ── export ── */
    const exported = await api(`/api/admin/${wid}/automation/export`, { token });
    check('the bundle can be exported', exported.status === 200);
    check('the export is a download', exported.text?.includes('"version": 1'));
    check('the export carries the personas', exported.text?.includes('Asha'));
    check('the export carries the cues', exported.text?.includes('Ready to continue?'));

    /* ── re-import replaces rather than merges ── */
    const smaller = { ...bundle, chat: [], qna: [], cues: [{ atMs: 1000, kind: 'poll', payload: {} }] };
    const replaced = await api(`/api/admin/${wid}/automation/import`, {
      method: 'POST',
      token,
      body: smaller,
    });
    check('a second import replaces the bundle', replaced.status === 201);
    check('the old cues are gone', replaced.json?.cues?.length === 1, `${replaced.json?.cues?.length} cues`);
    check('the summary reflects the replacement', replaced.json?.summary?.chatLines === 0);

    /* ── a missing webinar ── */
    const missing = await api('/api/admin/does-not-exist/automation/cues', { token });
    check('an unknown webinar is a 404', missing.status === 404, `got ${missing.status}`);
  } finally {
    await dropWebinar(token, wid);
    finish();
  }
});
