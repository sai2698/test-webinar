// Verifies session recording and replay end to end.
//
//   host        : joins the room, starts recording
//   participant : joins, chats, answers a quiz, receives a CTA
//   host        : closes the quiz, hides the CTA, stops recording
//   admin API   : the recording is READY and its timeline contains every event
//   public API  : the replay payload is fetchable without auth
//   participant : cannot start a recording
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
    // Phone is required since the join link became a lead-capture surface.
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

/** For events whose server handler takes only an ack (recordingStart/Stop). */
const emitBare = (socket, event) =>
  new Promise((resolve) => socket.emit(event, resolve));

/** Waits for a broadcast, or resolves null after `ms` so a missing event fails a check rather than hanging. */
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
  const viewer = await register('Replay Viewer', `replayviewer${stamp}@example.com`);

  const auth = { Authorization: `Bearer ${host.token}` };

  // ── discover the webinar ────────────────────────────────────
  const listRes = await fetch(`${API}/api/admin/webinars`, { headers: auth });
  if (!listRes.ok) throw new Error(`webinar list: ${listRes.status} ${await listRes.text()}`);
  const webinar = (await listRes.json()).webinars.find((w) => w.slug === SLUG);
  if (!webinar) throw new Error(`Webinar ${SLUG} not found`);
  check('admin can list webinars', Boolean(webinar), webinar.id);

  const quizzesRes = await fetch(`${API}/api/admin/${webinar.id}/quizzes`, { headers: auth });
  const quizzes = (await quizzesRes.json()).quizzes;
  const quiz = quizzes[0];
  check('webinar has a quiz to record', Boolean(quiz), quiz?.question);

  const ctasRes = await fetch(`${API}/api/admin/${webinar.id}/ctas`, { headers: auth });
  const ctas = (await ctasRes.json()).ctas;
  const cta = ctas[0];
  check('webinar has an offer to record', Boolean(cta), cta?.title);

  // ── host joins ──────────────────────────────────────────────
  const hostJoinRes = await fetch(`${API}/api/webinars/${SLUG}/host-join`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: '{}',
  });
  check('host-join issues a token', hostJoinRes.ok, String(hostJoinRes.status));
  const hostJoin = await hostJoinRes.json();
  check('host-join returns a join token', Boolean(hostJoin.joinToken));

  // The socket handshake authenticates with the JWT; the join token only
  // proves a registration exists for the payment gate.
  const hostSocket = await connect(host.token);
  const hostJoinAck = await emit(hostSocket, 'join', {
    slug: SLUG,
    token: host.token,
  });
  check('host joins the room', hostJoinAck?.ok === true, hostJoinAck?.error ?? '');
  check('host is recognised as staff', hostJoinAck?.data?.role === 'ADMIN', hostJoinAck?.data?.role);

  // ── start recording ─────────────────────────────────────────
  const recStatePromise = waitFor(hostSocket, 'recordingState');
  const startAck = await emitBare(hostSocket, 'recordingStart');
  check('host can start recording', startAck?.ok === true, startAck?.error ?? '');
  const recordingId = startAck?.data?.recordingId;
  check('recordingStart returns an id', Boolean(recordingId), recordingId);

  const recState = await recStatePromise;
  check('recordingState broadcasts recording=true', recState?.recording === true);

  // ── participant joins and interacts ─────────────────────────
  const viewerSocket = await connect(viewer.token);
  const viewerJoinAck = await emit(viewerSocket, 'join', {
    slug: SLUG,
    token: viewer.token,
  });
  check('participant joins the room', viewerJoinAck?.ok === true, viewerJoinAck?.error ?? '');
  check('participant sees the recording flag', viewerJoinAck?.data?.snapshot?.recording === true);

  const chatText = `replay-check-${stamp}`;
  viewerSocket.emit('chatSend', { text: chatText }, () => {});
  await sleep(300);

  // quiz
  const quizStartedPromise = waitFor(viewerSocket, 'quizStarted');
  const launchAck = await emit(hostSocket, 'quizLaunch', { quizId: quiz.id });
  check('host can launch a quiz', launchAck?.ok === true, launchAck?.error ?? '');

  const quizStarted = await quizStartedPromise;
  check('participant receives the quiz popup payload', Boolean(quizStarted?.id));
  check(
    'quiz payload hides the correct answer',
    quizStarted?.correctOptionId === undefined || quizStarted?.correctOptionId === null
  );

  const correctOptionId = quiz.correctOptionId ?? quiz.options[0].id;
  const answerAck = await emit(viewerSocket, 'quizAnswer', {
    quizId: quiz.id,
    optionId: correctOptionId,
  });
  check(
    'participant answer is graded correct',
    answerAck?.ok === true && answerAck?.data?.correct === true,
    JSON.stringify(answerAck?.data)
  );

  const quizResultsPromise = waitFor(viewerSocket, 'quizResults');
  const closeAck = await emit(hostSocket, 'quizClose', { quizId: quiz.id });
  check('host can close the quiz', closeAck?.ok === true, closeAck?.error ?? '');

  const quizResults = await quizResultsPromise;
  check('quiz results broadcast the correct option', quizResults?.correctOptionId === correctOptionId);
  check('quiz results count the answer', quizResults?.totalAnswers >= 1, String(quizResults?.totalAnswers));

  // cta
  const ctaShownPromise = waitFor(viewerSocket, 'ctaShown');
  const showAck = await emit(hostSocket, 'ctaShow', { ctaId: cta.id });
  check('host can push an offer', showAck?.ok === true, showAck?.error ?? '');

  const ctaShown = await ctaShownPromise;
  check('participant receives the offer overlay', ctaShown?.id === cta.id);
  check('offer carries a price', typeof ctaShown?.priceInPaise === 'number');

  const ctaHiddenPromise = waitFor(viewerSocket, 'ctaHidden');
  hostSocket.emit('ctaHide', () => {});
  const ctaHidden = await ctaHiddenPromise;
  check('offer can be hidden', ctaHidden !== null);

  // ── poll: launch → vote → close ─────────────────────────────
  const pollRes = await fetch(`${API}/api/admin/${webinar.id}/polls`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'Which part of the replay matters most?',
      options: [
        { id: 'a', text: 'The poll tally' },
        { id: 'b', text: 'The chat' },
      ],
      timeLimitSecs: 0,
    }),
  });
  const poll = (await pollRes.json()).poll;
  check('admin can create a poll to record', Boolean(poll?.id), poll?.question);

  const pollStartedPromise = waitFor(viewerSocket, 'pollStarted');
  const pollLaunchAck = await emit(hostSocket, 'pollLaunch', { pollId: poll.id });
  check('host can launch a poll', pollLaunchAck?.ok === true, pollLaunchAck?.error ?? '');
  const pollStarted = await pollStartedPromise;
  check('participant receives the poll popup', pollStarted?.id === poll.id);

  const pollVoteAck = await emit(viewerSocket, 'pollVote', { pollId: poll.id, optionId: 'a' });
  check('participant can vote', pollVoteAck?.ok === true, pollVoteAck?.error ?? '');

  const pollCloseAck = await emit(hostSocket, 'pollClose', { pollId: poll.id });
  check('host can close the poll', pollCloseAck?.ok === true, pollCloseAck?.error ?? '');

  // ── participant cannot record ───────────────────────────────
  const deniedAck = await emitBare(viewerSocket, 'recordingStart');
  check('participant cannot start a recording', deniedAck?.ok === false, deniedAck?.error ?? '');

  // ── stop recording ──────────────────────────────────────────
  await sleep(400);
  const stopStatePromise = waitFor(hostSocket, 'recordingState');
  const stopAck = await emitBare(hostSocket, 'recordingStop');
  check('host can stop recording', stopAck?.ok === true, stopAck?.error ?? '');
  const durationMs = stopAck?.data?.durationMs;
  check('stop returns a duration', typeof durationMs === 'number' && durationMs > 0, `${durationMs}ms`);

  const stopState = await stopStatePromise;
  check('recordingState broadcasts recording=false', stopState?.recording === false);

  // ── the recording is persisted ──────────────────────────────
  await sleep(500);
  const listRecRes = await fetch(
    `${API}/api/admin/recordings?webinarId=${encodeURIComponent(webinar.id)}`,
    { headers: auth }
  );
  check('admin can list recordings', listRecRes.ok, String(listRecRes.status));
  const recordings = (await listRecRes.json()).recordings;
  const saved = recordings.find((r) => r.id === recordingId);
  check('the recording is listed', Boolean(saved), saved?.status);
  check('the recording is READY', saved?.status === 'READY', saved?.status);
  check('the recording has a duration', (saved?.durationMs ?? 0) > 0, `${saved?.durationMs}ms`);
  check('the recording has timeline events', (saved?.eventCount ?? 0) > 0, String(saved?.eventCount));

  // ── the timeline captured everything ────────────────────────
  const detailRes = await fetch(`${API}/api/recordings/${recordingId}`);
  check('replay payload is public', detailRes.ok, String(detailRes.status));
  const detail = (await detailRes.json()).recording;
  const types = new Set(detail.timeline.map((e) => e.type));

  check('timeline captured chat', types.has('chat'));
  check('timeline captured the quiz', types.has('quizStarted'));
  check('timeline captured quiz results', types.has('quizResults'));
  check('timeline captured the offer', types.has('ctaShown'));
  check('timeline captured the offer being hidden', types.has('ctaHidden'));
  check('timeline captured the poll', types.has('pollStarted'));
  check('timeline captured the poll tally', types.has('pollResults'));
  check('timeline captured the poll closing', types.has('pollClosed'));
  check('timeline captured peer joins', types.has('peerJoined'));

  const chatEvent = detail.timeline.find((e) => e.type === 'chat' && e.message.text === chatText);
  check('the chat message is in the timeline', Boolean(chatEvent));
  check('the chat message is timestamped', typeof chatEvent?.t === 'number' && chatEvent.t >= 0, `${chatEvent?.t}ms`);
  check('the chat panel payload is populated', detail.chat.some((m) => m.text === chatText));

  const quizEvent = detail.timeline.find((e) => e.type === 'quizStarted');
  check('the recorded quiz keeps its options', (quizEvent?.quiz?.options?.length ?? 0) > 0);

  const ctaEvent = detail.timeline.find((e) => e.type === 'ctaShown');
  check('the recorded offer keeps its price', typeof ctaEvent?.cta?.priceInPaise === 'number');

  const pollEvent = detail.timeline.find((e) => e.type === 'pollStarted');
  check('the recorded poll keeps its question', pollEvent?.poll?.question === poll.question);
  check('the recorded poll keeps its options', (pollEvent?.poll?.options?.length ?? 0) === 2);

  const pollTallies = detail.timeline.filter((e) => e.type === 'pollResults');
  check('the recorded poll keeps a vote tally', pollTallies.length >= 1, String(pollTallies.length));
  check(
    'the recorded tally counts the vote',
    pollTallies.some((e) => e.results.totalVotes === 1)
  );
  check(
    'the recorded tally ends closed',
    pollTallies.some((e) => e.results.closed === true)
  );

  // ── cleanup ─────────────────────────────────────────────────
  await fetch(`${API}/api/admin/polls/${poll.id}`, { method: 'DELETE', headers: auth });
  const delRes = await fetch(`${API}/api/admin/recordings/${recordingId}`, {
    method: 'DELETE',
    headers: auth,
  });
  check('admin can delete the recording', delRes.ok, String(delRes.status));

  hostSocket.close();
  viewerSocket.close();

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exitCode = 1;
};

run().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
