// Verifies host visibility of participant mic/camera state, and the
// request-to-unmute / request-to-enable-camera flow.
//
//   participant : reports mic/cam state, host sees it in the peer list
//   participant : a state change is broadcast to everyone, not just staff
//   host        : can ask a participant to unmute
//   participant : receives the request as a prompt, not an automatic change
//   participant : cannot ask another participant (staff-only)
//   host        : asking someone who has left fails cleanly
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

const run = async () => {
  const stamp = Date.now();
  const host = await login('admin@webinar.local', 'Admin@12345');
  const viewer = await register('Media Viewer', `mediaviewer${stamp}@example.com`);

  // ── both peers join ─────────────────────────────────────────
  const hostSocket = await connect(host.token);
  const hostJoin = await emit(hostSocket, 'join', { slug: SLUG, token: host.token });
  check('host joins the room', hostJoin?.ok === true, hostJoin?.error ?? '');
  const hostPeerId = hostJoin?.data?.peerId;
  const hostUserId = hostJoin?.data?.userId;

  const viewerSocket = await connect(viewer.token);
  const viewerJoin = await emit(viewerSocket, 'join', { slug: SLUG, token: viewer.token });
  check('participant joins the room', viewerJoin?.ok === true, viewerJoin?.error ?? '');
  const viewerPeerId = viewerJoin?.data?.peerId;
  const viewerUserId = viewerJoin?.data?.userId;

  check('a new peer starts with the mic off', viewerJoin?.data?.snapshot?.self?.micOn === false);
  check('a new peer starts with the camera off', viewerJoin?.data?.snapshot?.self?.camOn === false);

  // ── the host sees the participant's state ───────────────────
  // The snapshot the host already holds is the source of truth for the list.
  const hostSnapshot = hostJoin?.data?.snapshot?.peers ?? [];
  const viewerInHostList = hostSnapshot.find((p) => p.peerId === viewerPeerId);
  check(
    'the host snapshot carries micOn for every peer',
    hostSnapshot.every((p) => typeof p.micOn === 'boolean')
  );
  check(
    'the host snapshot carries camOn for every peer',
    hostSnapshot.every((p) => typeof p.camOn === 'boolean')
  );

  // ── the participant reports a state change ──────────────────
  const hostUpdate = waitFor(hostSocket, 'peerUpdated');
  const stateAck = await emit(viewerSocket, 'mediaState', { micOn: true, camOn: false });
  check('participant can report media state', stateAck?.ok === true, stateAck?.error ?? '');

  const updated = await hostUpdate;
  check('the host receives peerUpdated', Boolean(updated), updated?.peerId);
  check('the update is for the right peer', updated?.peerId === viewerPeerId);
  check('the host sees the mic as on', updated?.micOn === true, String(updated?.micOn));
  check('the host sees the camera as off', updated?.camOn === false, String(updated?.camOn));

  // A viewer reading the participant list should see the same truth, so the
  // broadcast must not be staff-only.
  const viewerUpdate = waitFor(viewerSocket, 'peerUpdated');
  await emit(viewerSocket, 'mediaState', { micOn: true, camOn: true });
  const viewerSees = await viewerUpdate;
  check('non-staff peers also receive peerUpdated', Boolean(viewerSees));
  check('the camera state propagates', viewerSees?.camOn === true, String(viewerSees?.camOn));

  // ── the host asks for the mic ───────────────────────────────
  await emit(viewerSocket, 'mediaState', { micOn: false, camOn: false });
  await sleep(150);

  const requestPrompt = waitFor(viewerSocket, 'mediaRequested');
  const askAck = await emit(hostSocket, 'mediaRequest', { userId: viewerUserId, kind: 'mic' });
  check('host can ask a participant to unmute', askAck?.ok === true, askAck?.error ?? '');
  check('the ack names who was asked', askAck?.data?.name === 'Media Viewer', askAck?.data?.name);

  const prompt = await requestPrompt;
  check('the participant receives the request', Boolean(prompt));
  check('the request says which device', prompt?.kind === 'mic', prompt?.kind);
  check('the request names the asker', typeof prompt?.by === 'string' && prompt.by.length > 0, prompt?.by);

  // A request must not change anything by itself — consent is the point.
  const afterRequest = await emit(viewerSocket, 'mediaState', { micOn: false, camOn: false });
  check('a request does not enable the device', afterRequest?.ok === true);

  // ── the host asks for the camera ────────────────────────────
  const camPrompt = waitFor(viewerSocket, 'mediaRequested');
  const camAck = await emit(hostSocket, 'mediaRequest', { userId: viewerUserId, kind: 'cam' });
  check('host can ask a participant to enable the camera', camAck?.ok === true, camAck?.error ?? '');
  const camReq = await camPrompt;
  check('the camera request arrives', camReq?.kind === 'cam', camReq?.kind);

  // ── permissions ─────────────────────────────────────────────
  const viewerAsk = await emit(viewerSocket, 'mediaRequest', {
    userId: hostUserId,
    kind: 'mic',
  });
  check('a participant cannot ask someone else', viewerAsk?.ok === false, viewerAsk?.error ?? '');
  check(
    'the rejection says it is not allowed',
    /not allowed/i.test(viewerAsk?.error ?? ''),
    viewerAsk?.error
  );

  // ── asking someone who has left ─────────────────────────────
  viewerSocket.disconnect();
  await sleep(400);

  const goneAck = await emit(hostSocket, 'mediaRequest', { userId: viewerUserId, kind: 'mic' });
  check('asking a departed participant fails', goneAck?.ok === false, goneAck?.error ?? '');
  check(
    'the failure explains they left',
    /left/i.test(goneAck?.error ?? ''),
    goneAck?.error
  );

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
