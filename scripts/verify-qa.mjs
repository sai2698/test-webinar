// Verifies the Q&A feature end to end.
//
//   participant : asks a question, sees it in the broadcast queue
//   participant : upvotes, then un-upvotes (the toggle must not double-count)
//   participant : cannot answer, pin or delete (staff-only)
//   host        : answers, pins, deletes
//   recording   : qaAsked / qaAnswered / qaPinned land in the timeline
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

/** For events whose server handler takes only an ack. */
const emitBare = (socket, event) => new Promise((resolve) => socket.emit(event, resolve));

/** Waits for a broadcast, or resolves null after `ms` so a missing event fails a check. */
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
  const viewer = await register('QA Viewer', `qaviewer${stamp}@example.com`);
  const auth = { Authorization: `Bearer ${host.token}` };

  // ── discover the webinar ────────────────────────────────────
  const listRes = await fetch(`${API}/api/admin/webinars`, { headers: auth });
  if (!listRes.ok) throw new Error(`webinar list: ${listRes.status} ${await listRes.text()}`);
  const webinar = (await listRes.json()).webinars.find((w) => w.slug === SLUG);
  if (!webinar) throw new Error(`Webinar ${SLUG} not found`);
  check('admin can list webinars', Boolean(webinar), webinar.id);

  // ── both peers join ─────────────────────────────────────────
  const hostSocket = await connect(host.token);
  const hostJoin = await emit(hostSocket, 'join', { slug: SLUG, token: host.token });
  check('host joins the room', hostJoin?.ok === true, hostJoin?.error ?? '');
  check('host is staff', hostJoin?.data?.role === 'ADMIN', hostJoin?.data?.role);

  const viewerSocket = await connect(viewer.token);
  const viewerJoin = await emit(viewerSocket, 'join', { slug: SLUG, token: viewer.token });
  check('participant joins the room', viewerJoin?.ok === true, viewerJoin?.error ?? '');
  check('participant is not staff', viewerJoin?.data?.role === 'PARTICIPANT', viewerJoin?.data?.role);

  // The queue is re-broadcast after every change, so keep the latest copy
  // rather than racing a one-shot listener against the ack.
  let latest = null;
  viewerSocket.on('qaList', (list) => {
    latest = list;
  });
  const settle = () => sleep(300);

  // ── start recording so the timeline can be inspected ────────
  // A previous run that was interrupted can leave a recording open, and
  // `recordingStart` then refuses with "Already recording". Close it first so
  // the suite is re-runnable rather than depending on a clean server.
  let startAck = await emitBare(hostSocket, 'recordingStart');
  if (startAck?.ok !== true && /already recording/i.test(startAck?.error ?? '')) {
    await emitBare(hostSocket, 'recordingStop');
    await sleep(500);
    startAck = await emitBare(hostSocket, 'recordingStart');
  }
  check('host can start recording', startAck?.ok === true, startAck?.error ?? '');
  const recordingId = startAck?.data?.recordingId;
  check('recordingStart returns an id', Boolean(recordingId), recordingId);

  // ── ask ─────────────────────────────────────────────────────
  const questionText = `Verify: does Q&A survive a reconnect? ${stamp}`;
  const askAck = await emit(viewerSocket, 'qaAsk', { text: questionText });
  check('participant can ask a question', askAck?.ok === true, askAck?.error ?? '');
  const questionId = askAck?.data?.question?.id;
  check('qaAsk returns the question', Boolean(questionId), questionId);
  check('the question carries the asker name', askAck?.data?.question?.name === 'QA Viewer');
  check('a new question starts un-answered', askAck?.data?.question?.answered === false);

  await settle();
  check('qaList broadcasts to the room', Array.isArray(latest), typeof latest);
  check(
    'the new question is in the broadcast',
    Array.isArray(latest) && latest.some((q) => q.id === questionId)
  );

  const emptyAsk = await emit(viewerSocket, 'qaAsk', { text: '   ' });
  check('rejects an empty question', emptyAsk?.ok === false, JSON.stringify(emptyAsk));

  const longAsk = await emit(viewerSocket, 'qaAsk', { text: 'x'.repeat(501) });
  check('rejects a question over 500 chars', longAsk?.ok === false, JSON.stringify(longAsk));

  // ── upvote toggle ───────────────────────────────────────────
  const upAck = await emit(viewerSocket, 'qaUpvote', { questionId });
  check('participant can upvote', upAck?.ok === true, upAck?.error ?? '');
  check('upvote counted once', upAck?.data?.upvotes === 1, JSON.stringify(upAck?.data));
  check('upvote reports the viewer state', upAck?.data?.upvoted === true);

  const downAck = await emit(viewerSocket, 'qaUpvote', { questionId });
  check('a second upvote removes it', downAck?.data?.upvotes === 0, JSON.stringify(downAck?.data));
  check('the toggle reports the viewer state', downAck?.data?.upvoted === false);

  // Leave it upvoted so the ordering check below has something to sort on.
  await emit(viewerSocket, 'qaUpvote', { questionId });

  // ── staff-only actions ──────────────────────────────────────
  const viewerAnswer = await emit(viewerSocket, 'qaAnswer', { questionId, answered: true });
  check('participant cannot mark answered', viewerAnswer?.ok === false, JSON.stringify(viewerAnswer));

  const viewerPin = await emit(viewerSocket, 'qaPin', { questionId, pinned: true });
  check('participant cannot pin', viewerPin?.ok === false, JSON.stringify(viewerPin));

  const viewerDelete = await emit(viewerSocket, 'qaDelete', { questionId });
  check('participant cannot delete', viewerDelete?.ok === false, JSON.stringify(viewerDelete));

  // ── host answers and pins ───────────────────────────────────
  const answerAck = await emit(hostSocket, 'qaAnswer', { questionId, answered: true });
  check('host can mark answered', answerAck?.ok === true, answerAck?.error ?? '');

  const pinAck = await emit(hostSocket, 'qaPin', { questionId, pinned: true });
  check('host can pin', pinAck?.ok === true, pinAck?.error ?? '');

  // The queue is re-broadcast after every change, so read the latest copy.
  await settle();
  const pinned = Array.isArray(latest) ? latest.find((q) => q.id === questionId) : null;
  check('the question is marked answered', pinned?.answered === true);
  check('the question is marked pinned', pinned?.pinned === true);
  check('the upvote total survived', pinned?.upvotes === 1, String(pinned?.upvotes));

  // ── a second question, then delete both ─────────────────────
  // The ask limiter is 3/second and the two rejection checks above already
  // spent two of them, so wait out the window rather than racing it.
  await sleep(1100);
  const secondAck = await emit(viewerSocket, 'qaAsk', { text: `Verify: second question ${stamp}` });
  const secondId = secondAck?.data?.question?.id;
  check('a second question can be asked', Boolean(secondId), secondId);

  const delAck = await emit(hostSocket, 'qaDelete', { questionId: secondId });
  check('host can delete a question', delAck?.ok === true, delAck?.error ?? '');

  await settle();
  check(
    'the deleted question is gone from the queue',
    Array.isArray(latest) && !latest.some((q) => q.id === secondId)
  );

  // ── stop recording and inspect the timeline ─────────────────
  const stopAck = await emitBare(hostSocket, 'recordingStop');
  check('host can stop recording', stopAck?.ok === true, stopAck?.error ?? '');

  // The recorder finalises asynchronously; poll until it is READY.
  let detail = null;
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`${API}/api/recordings/${recordingId}`);
    if (res.ok) {
      const body = await res.json();
      if (body.recording?.status === 'READY') {
        detail = body.recording;
        break;
      }
    }
    await sleep(250);
  }
  check('the recording reached READY', Boolean(detail), detail?.status);

  const types = new Set((detail?.timeline ?? []).map((e) => e.type));
  check('timeline captured the question', types.has('qaAsked'));
  check('timeline captured the answer', types.has('qaAnswered'));
  check('timeline captured the pin', types.has('qaPinned'));

  const askedEvent = (detail?.timeline ?? []).find(
    (e) => e.type === 'qaAsked' && e.question?.text === questionText
  );
  check('the question text is in the timeline', Boolean(askedEvent));

  // ── cleanup ─────────────────────────────────────────────────
  await emit(hostSocket, 'qaDelete', { questionId });
  await fetch(`${API}/api/recordings/${recordingId}`, { method: 'DELETE', headers: auth });

  hostSocket.disconnect();
  viewerSocket.disconnect();

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
};

run().catch((err) => {
  console.error('\nFATAL:', err);
  process.exitCode = 1;
});
