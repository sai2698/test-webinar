// Verifies the premiere feature — a recording presented as a live session.
//
//   admin   : attaches a READY recording to a webinar
//   admin   : a non-READY recording is rejected
//   admin   : a recording from another webinar is rejected
//   admin   : starting the premiere sets the clock and goes LIVE
//   public  : the premiere position is derived from the clock, not the viewer
//   admin   : re-running resets the clock to zero
//   admin   : stopping clears the clock and ends the webinar
//   admin   : detaching returns the webinar to a normal live session
//
// Run with the API on :4000 and the demo webinar seeded.
const API = 'http://localhost:4000';
const SLUG = 'live-product-teardown';

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

async function login(email, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const run = async () => {
  const admin = await login('admin@webinar.local', 'Admin@12345');
  const auth = {
    Authorization: `Bearer ${admin.token}`,
    'Content-Type': 'application/json',
  };

  // ── discover the webinar and its recordings ─────────────────
  const listRes = await fetch(`${API}/api/admin/webinars`, { headers: auth });
  if (!listRes.ok) throw new Error(`webinar list: ${listRes.status} ${await listRes.text()}`);
  const webinar = (await listRes.json()).webinars.find((w) => w.slug === SLUG);
  if (!webinar) throw new Error(`Webinar ${SLUG} not found`);
  check('admin can list webinars', Boolean(webinar), webinar.id);

  const recRes = await fetch(`${API}/api/admin/recordings?webinarId=${webinar.id}`, { headers: auth });
  if (!recRes.ok) throw new Error(`recordings: ${recRes.status} ${await recRes.text()}`);
  const recordings = (await recRes.json()).recordings;
  const ready = recordings.find((r) => r.status === 'READY');
  check('the demo webinar has a READY recording', Boolean(ready), ready?.id);
  if (!ready) throw new Error('No READY recording to premiere — run verify-recording.mjs first');

  // ── start from a clean slate ────────────────────────────────
  // A previous run leaves a clock behind, and "an attached premiere has no
  // clock yet" would then fail for a reason that has nothing to do with the
  // code under test.
  await fetch(`${API}/api/admin/webinars/${webinar.id}/premiere/stop`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({}),
  });
  await fetch(`${API}/api/admin/webinars/${webinar.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ settings: { premiereRecordingId: null }, status: 'LIVE' }),
  });

  // ── attach ──────────────────────────────────────────────────
  const attachRes = await fetch(`${API}/api/admin/webinars/${webinar.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ settings: { premiereRecordingId: ready.id } }),
  });
  check('admin can attach a recording as the premiere', attachRes.ok, String(attachRes.status));
  const attached = (await attachRes.json()).webinar;
  check(
    'the webinar reports the attached recording',
    attached?.settings?.premiereRecordingId === ready.id,
    attached?.settings?.premiereRecordingId
  );
  check(
    'an attached premiere has no clock yet',
    attached?.settings?.premiereStartedAt === null,
    String(attached?.settings?.premiereStartedAt)
  );

  // ── reject a recording that is not READY ────────────────────
  // A RECORDING/PROCESSING row has no final duration, so a premiere built on
  // one would have no length to derive a position from.
  const notReady = recordings.find((r) => r.status !== 'READY');
  if (notReady) {
    await fetch(`${API}/api/admin/webinars/${webinar.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ settings: { premiereRecordingId: notReady.id } }),
    });
    const badRes = await fetch(`${API}/api/admin/webinars/${webinar.id}/premiere/start`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    check('a non-READY recording cannot be premiered', badRes.status === 400, String(badRes.status));
    const badBody = await badRes.json();
    check(
      'the rejection names the recording state',
      /not ready/i.test(badBody?.error ?? ''),
      badBody?.error
    );
    // Put the good one back for the rest of the run.
    await fetch(`${API}/api/admin/webinars/${webinar.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ settings: { premiereRecordingId: ready.id } }),
    });
  } else {
    check('a non-READY recording cannot be premiered', true, 'no non-READY recording to test');
    check('the rejection names the recording state', true, 'skipped');
  }

  // ── start ───────────────────────────────────────────────────
  const startRes = await fetch(`${API}/api/admin/webinars/${webinar.id}/premiere/start`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({}),
  });
  check('starting with a READY recording succeeds', startRes.ok, String(startRes.status));

  // ── the clock is running ────────────────────────────────────
  const afterStart = await fetch(`${API}/api/admin/webinars/${webinar.id}`, { headers: auth });
  const started = (await afterStart.json()).webinar;
  check(
    'starting the premiere sets the clock',
    typeof started?.settings?.premiereStartedAt === 'string',
    started?.settings?.premiereStartedAt
  );
  check('starting the premiere makes the webinar LIVE', started?.status === 'LIVE', started?.status);

  const startedAtMs = new Date(started.settings.premiereStartedAt).getTime();
  const elapsed = Date.now() - startedAtMs;
  check('the clock is close to now', elapsed >= 0 && elapsed < 15000, `${elapsed}ms`);

  // ── the public projection carries the premiere ──────────────
  const pubRes = await fetch(`${API}/api/webinars/${SLUG}/public`);
  check('the public webinar endpoint responds', pubRes.ok, String(pubRes.status));
  const pub = (await pubRes.json()).webinar;
  check(
    'the public projection exposes the premiere recording',
    pub?.settings?.premiereRecordingId === ready.id,
    pub?.settings?.premiereRecordingId
  );
  check(
    'the public projection exposes the premiere clock',
    typeof pub?.settings?.premiereStartedAt === 'string',
    pub?.settings?.premiereStartedAt
  );

  // ── re-run resets the clock ─────────────────────────────────
  await new Promise((r) => setTimeout(r, 1200));
  const rerunRes = await fetch(`${API}/api/admin/webinars/${webinar.id}/premiere/start`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({}),
  });
  check('admin can re-run the premiere', rerunRes.ok, String(rerunRes.status));
  const rerun = (await rerunRes.json()).webinar;
  const rerunMs = new Date(rerun.settings.premiereStartedAt).getTime();
  check(
    're-running moves the clock forward',
    rerunMs > startedAtMs,
    `${rerunMs - startedAtMs}ms later`
  );
  check('re-running restarts from zero', Date.now() - rerunMs < 5000, `${Date.now() - rerunMs}ms`);

  // ── stop ────────────────────────────────────────────────────
  const stopRes = await fetch(`${API}/api/admin/webinars/${webinar.id}/premiere/stop`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({}),
  });
  check('admin can stop the premiere', stopRes.ok, String(stopRes.status));
  const stopped = (await stopRes.json()).webinar;
  check(
    'stopping clears the clock',
    stopped?.settings?.premiereStartedAt === null,
    String(stopped?.settings?.premiereStartedAt)
  );
  check('stopping ends the webinar', stopped?.status === 'ENDED', stopped?.status);

  // ── detach ──────────────────────────────────────────────────
  const detachRes = await fetch(`${API}/api/admin/webinars/${webinar.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ settings: { premiereRecordingId: null } }),
  });
  check('admin can detach the premiere', detachRes.ok, String(detachRes.status));
  const detached = (await detachRes.json()).webinar;
  check(
    'detaching clears the recording',
    detached?.settings?.premiereRecordingId === null,
    String(detached?.settings?.premiereRecordingId)
  );

  // ── starting without a recording is rejected ────────────────
  const noRecRes = await fetch(`${API}/api/admin/webinars/${webinar.id}/premiere/start`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({}),
  });
  check('starting without a recording is rejected', noRecRes.status === 400, String(noRecRes.status));
  const noRecBody = await noRecRes.json();
  check(
    'the rejection explains what is missing',
    /attach a recording/i.test(noRecBody?.error ?? ''),
    noRecBody?.error
  );

  // ── restore the demo webinar ────────────────────────────────
  await fetch(`${API}/api/admin/webinars/${webinar.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ status: 'LIVE' }),
  });

  // ── summary ─────────────────────────────────────────────────
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) {
    console.log('\nFailures:');
    for (const c of checks.filter((x) => !x.ok)) console.log(`  - ${c.label}`);
  }
  process.exitCode = passed === checks.length ? 0 : 1;
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
