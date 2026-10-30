// Verifies the waiting room: participants may join before the host opens the
// session, and are told plainly that it has not started yet.
//
//   participant : joins a SCHEDULED webinar and gets startedAt === null
//   participant : receives webinarStarted the moment the host goes live
//   host        : can start the session, and the ack carries the start time
//   host        : starting twice does not reset the clock
//   participant : cannot start the session (host/admin only)
//   late joiner : sees startedAt already set, so no waiting screen
//   persistence : the webinar row is LIVE with a startedAt after the start
//
// Run with the API on :4000 and the demo webinar seeded.
import { io } from 'socket.io-client';

const API = 'http://localhost:4000';
const SLUG = 'live-product-teardown';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function register(name, email) {
  const res = await fetch(`${API}/api/webinars/${SLUG}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, phone: '+91 98765 43210' }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    socket.on('connect_error', reject);
    socket.on('connect', () => resolve(socket));
  });
}

const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

function waitFor(socket, event, ms = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, ms);
    const handler = (payload) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

/**
 * Puts the demo webinar back into its pre-start state.
 *
 * The suite has to be re-runnable: a previous interrupted run leaves the row
 * LIVE with a startedAt, and every assertion below would then be testing the
 * wrong branch.
 */
async function resetToScheduled(adminToken) {
  const list = await fetch(`${API}/api/admin/webinars`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  }).then((r) => r.json());
  const webinar = (list.webinars ?? []).find((w) => w.slug === SLUG);
  if (!webinar) throw new Error('demo webinar not found');

  const res = await fetch(`${API}/api/admin/webinars/${webinar.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ status: 'SCHEDULED', startedAt: null }),
  });
  if (!res.ok) throw new Error(`reset failed: ${res.status} ${await res.text()}`);
  return webinar.id;
}

const run = async () => {
  const stamp = Date.now();
  const host = await login('admin@webinar.local', 'Admin@12345');
  const webinarId = await resetToScheduled(host.token);

  const early = await register('Early Bird', `early${stamp}@example.com`);
  const late = await register('Late Arrival', `late${stamp}@example.com`);

  // ── a participant joins before the host starts ──────────────
  const earlySocket = await connect(early.token);
  const earlyJoin = await emit(earlySocket, 'join', { slug: SLUG, token: early.token });
  check('a participant can join before the session starts', earlyJoin?.ok === true, earlyJoin?.error ?? '');
  check(
    'the snapshot says the session has not started',
    earlyJoin?.data?.snapshot?.startedAt === null,
    String(earlyJoin?.data?.snapshot?.startedAt)
  );
  check(
    'the snapshot still carries the webinar title',
    typeof earlyJoin?.data?.snapshot?.title === 'string' &&
      earlyJoin.data.snapshot.title.length > 0,
    earlyJoin?.data?.snapshot?.title
  );

  // ── a participant cannot start the session ──────────────────
  const earlyStart = await emit(earlySocket, 'webinarStart', {});
  check('a participant cannot start the webinar', earlyStart?.ok === false, earlyStart?.error ?? '');
  check(
    'the rejection says it is not allowed',
    /not allowed/i.test(earlyStart?.error ?? ''),
    earlyStart?.error
  );

  // ── the host starts it ──────────────────────────────────────
  const hostSocket = await connect(host.token);
  const hostJoin = await emit(hostSocket, 'join', { slug: SLUG, token: host.token });
  check('the host joins the room', hostJoin?.ok === true, hostJoin?.error ?? '');

  const startedEvent = waitFor(earlySocket, 'webinarStarted');
  const startAck = await emit(hostSocket, 'webinarStart', {});
  check('the host can start the webinar', startAck?.ok === true, startAck?.error ?? '');
  check(
    'the ack carries a start timestamp',
    typeof startAck?.data?.startedAt === 'number' && startAck.data.startedAt > 0,
    String(startAck?.data?.startedAt)
  );

  const started = await startedEvent;
  check('the waiting participant is told the session started', Boolean(started));
  check(
    'the broadcast carries the same timestamp',
    started?.startedAt === startAck?.data?.startedAt,
    `${started?.startedAt} vs ${startAck?.data?.startedAt}`
  );

  // ── starting twice must not reset the clock ─────────────────
  await sleep(120);
  const secondAck = await emit(hostSocket, 'webinarStart', {});
  check('starting again is accepted', secondAck?.ok === true, secondAck?.error ?? '');
  check(
    'starting again does not move the clock',
    secondAck?.data?.startedAt === startAck?.data?.startedAt,
    `${secondAck?.data?.startedAt} vs ${startAck?.data?.startedAt}`
  );

  // ── a late joiner skips the waiting room ────────────────────
  const lateSocket = await connect(late.token);
  const lateJoin = await emit(lateSocket, 'join', { slug: SLUG, token: late.token });
  check('a late participant can join', lateJoin?.ok === true, lateJoin?.error ?? '');
  check(
    'a late joiner sees the session as already started',
    typeof lateJoin?.data?.snapshot?.startedAt === 'number',
    String(lateJoin?.data?.snapshot?.startedAt)
  );

  // ── the start is persisted ──────────────────────────────────
  const detail = await fetch(`${API}/api/admin/webinars/${webinarId}`, {
    headers: { Authorization: `Bearer ${host.token}` },
  }).then((r) => r.json());
  check('the webinar is persisted as LIVE', detail?.webinar?.status === 'LIVE', detail?.webinar?.status);
  check(
    'the start time is persisted',
    Boolean(detail?.webinar?.startedAt),
    String(detail?.webinar?.startedAt)
  );

  earlySocket.disconnect();
  lateSocket.disconnect();
  hostSocket.disconnect();

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
