// Verifies that a screen-share producer is announced with source: 'screen'.
import { io } from 'socket.io-client';

const API = 'http://localhost:4000';
const SLUG = 'live-product-teardown';

async function register(name, email) {
  const res = await fetch(`${API}/api/webinars/${SLUG}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Phone is required since the join link became a lead-capture surface.
    body: JSON.stringify({ name, email, phone: '+91 98765 43210' }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return res.json();
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

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    socket.on('connect_error', reject);
    socket.on('connect', () => resolve(socket));
  });
}

const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  const stamp = Date.now();
  const host = await login('admin@webinar.local', 'Admin@12345');
  const viewer = await register('Screen Viewer', `screenviewer${stamp}@example.com`);

  const hostSocket = await connect(host.token);
  const viewerSocket = await connect(viewer.token);

  const hostJoin = await emit(hostSocket, 'join', { slug: SLUG, token: host.token });
  const viewerJoin = await emit(viewerSocket, 'join', { slug: SLUG, token: viewer.token });
  if (!hostJoin.ok) throw new Error(`host join: ${hostJoin.error}`);
  if (!viewerJoin.ok) throw new Error(`viewer join: ${viewerJoin.error}`);

  console.log('host role   :', hostJoin.data.role);
  console.log('viewer role :', viewerJoin.data.role);

  // Collect what the viewer is told about new producers.
  const announced = [];
  viewerSocket.on('newProducer', (p) => announced.push(p));

  // Host creates a send transport and publishes a fake "screen" video producer.
  const t = await emit(hostSocket, 'createTransport', { direction: 'send' });
  if (!t.ok) throw new Error(`createTransport: ${t.error}`);

  // Viewer needs a receive transport before it can consume anything.
  const rt = await emit(viewerSocket, 'createTransport', { direction: 'recv' });
  if (!rt.ok) throw new Error(`viewer createTransport: ${rt.error}`);

  const produced = await emit(hostSocket, 'produce', {
    transportId: t.data.id,
    kind: 'video',
    source: 'screen',
    rtpParameters: {
      mid: '0',
      codecs: [{ mimeType: 'video/VP8', clockRate: 90000, payloadType: 96, parameters: {} }],
      headerExtensions: [],
      encodings: [{ ssrc: 111111 }],
      rtcp: {},
    },
    appData: { kind: 'video', source: 'screen' },
  });

  if (!produced.ok) throw new Error(`produce: ${produced.error}`);
  console.log('producerId  :', produced.data.producerId);

  /**
   * A host who shares their screen still has a camera running, and
   * participants must see both. That is two video producers on one send
   * transport, which only works if they carry distinct `mid` values — reusing
   * `mid: '0'` fails with "MID already exists in RTP listener".
   */
  const camera = await emit(hostSocket, 'produce', {
    transportId: t.data.id,
    kind: 'video',
    source: 'camera',
    rtpParameters: {
      mid: '1',
      codecs: [{ mimeType: 'video/VP8', clockRate: 90000, payloadType: 96, parameters: {} }],
      headerExtensions: [],
      encodings: [{ ssrc: 222222 }],
      rtcp: {},
    },
    appData: { kind: 'video', source: 'camera' },
  });

  if (!camera.ok) throw new Error(`camera produce: ${camera.error}`);
  console.log('cameraId    :', camera.data.producerId);

  await sleep(1200);

  console.log('\nviewer received newProducer events:');
  console.log(JSON.stringify(announced, null, 2));

  const screenEvent = announced.find((p) => p.producerId === produced.data.producerId);
  const announcedOk = screenEvent?.source === 'screen';

  const cameraEvent = announced.find((p) => p.producerId === camera.data.producerId);
  const cameraAnnouncedOk = cameraEvent?.source === 'camera';

  // Also confirm the consume ack carries the source.
  const consumed = await emit(viewerSocket, 'consume', {
    producerId: produced.data.producerId,
    rtpCapabilities: viewerJoin.data.rtpCapabilities,
  });
  const consumeSource = consumed.ok ? consumed.data.source : null;
  console.log('\nconsume ack source:', consumed.ok ? consumeSource : consumed.error);

  // The camera must be consumable *while* the screen share is live.
  const consumedCam = await emit(viewerSocket, 'consume', {
    producerId: camera.data.producerId,
    rtpCapabilities: viewerJoin.data.rtpCapabilities,
  });
  const consumeCamSource = consumedCam.ok ? consumedCam.data.source : null;
  console.log('camera consume ack source:', consumedCam.ok ? consumeCamSource : consumedCam.error);

  const pass =
    announcedOk &&
    consumeSource === 'screen' &&
    cameraAnnouncedOk &&
    consumeCamSource === 'camera';
  console.log(
    `\nRESULT: ${pass ? 'PASS' : 'FAIL'} — screen and camera producers tagged end to end`
  );

  hostSocket.disconnect();
  viewerSocket.disconnect();
  process.exitCode = pass ? 0 : 1;
};

run().catch((err) => {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
});
