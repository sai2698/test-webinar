/**
 * Verifies the polls feature end to end:
 *   1. admin CRUD (list / create / delete)
 *   2. socket launch → vote → tally → close
 *   3. the shared-join-link gate (join-info needsProfile + claim)
 *
 * Run with the API server up:  node scripts/verify-polls.mjs
 */
import { io } from 'socket.io-client';

const API = 'http://localhost:4000';
const ADMIN = { email: 'admin@webinar.local', password: 'Admin@12345' };

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function json(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function emit(socket, event, payload) {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
  });
}

async function main() {
  console.log('\n── auth ────────────────────────────────────────');
  const login = await json('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(ADMIN),
  });
  check('admin login', login.status === 200 && Boolean(login.body.token), `status ${login.status}`);
  const adminToken = login.body.token;
  const auth = { authorization: `Bearer ${adminToken}` };

  console.log('\n── pick the demo webinar ───────────────────────');
  const list = await json('/api/admin/webinars', { headers: auth });
  const webinars = list.body.webinars ?? [];
  const webinar = webinars.find((w) => w.status === 'LIVE') ?? webinars[0];
  check('found a webinar', Boolean(webinar), 'no webinars in the database');
  if (!webinar) return;
  console.log(`  · ${webinar.title} (${webinar.status})`);

  console.log('\n── poll CRUD ───────────────────────────────────');
  const created = await json(`/api/admin/${webinar.id}/polls`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      question: 'Verify: which transport does the SFU use?',
      options: [
        { id: 'a', text: 'WebRTC' },
        { id: 'b', text: 'RTMP' },
        { id: 'c', text: 'HLS' },
      ],
      timeLimitSecs: 0,
    }),
  });
  check('create poll', created.status === 201 && Boolean(created.body.poll?.id), `status ${created.status}`);
  const pollId = created.body.poll?.id;

  const listed = await json(`/api/admin/${webinar.id}/polls`, { headers: auth });
  const polls = listed.body.polls ?? [];
  check('list polls', polls.some((p) => p.id === pollId));
  check('options round-trip', polls.find((p) => p.id === pollId)?.options?.length === 3);

  const badPoll = await json(`/api/admin/${webinar.id}/polls`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ question: 'x', options: [{ id: 'a', text: 'only one' }] }),
  });
  check('rejects a one-option poll', badPoll.status === 400, `status ${badPoll.status}`);

  console.log('\n── socket: launch → vote → close ───────────────');
  const socket = io(API, { transports: ['websocket'], auth: { token: adminToken } });
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 8000);
  });
  check('socket connected', socket.connected);

  const joinAck = await emit(socket, 'join', { slug: webinar.slug, token: adminToken });
  check('joined the room', joinAck?.ok === true, JSON.stringify(joinAck));

  const started = new Promise((resolve) => socket.once('pollStarted', resolve));
  const launchAck = await emit(socket, 'pollLaunch', { pollId });
  check('pollLaunch acked', launchAck?.ok === true, JSON.stringify(launchAck));
  const startedPoll = await Promise.race([
    started,
    new Promise((r) => setTimeout(() => r(null), 4000)),
  ]);
  check('pollStarted broadcast', startedPoll?.id === pollId);

  const resultsSeen = [];
  socket.on('pollResults', (r) => resultsSeen.push(r));

  const voteAck = await emit(socket, 'pollVote', { pollId, optionId: 'a' });
  check('pollVote acked', voteAck?.ok === true, JSON.stringify(voteAck));
  check('vote counted', voteAck?.data?.totalVotes === 1, JSON.stringify(voteAck?.data));

  // Voting again replaces the previous choice rather than double-counting.
  const revote = await emit(socket, 'pollVote', { pollId, optionId: 'b' });
  check('revote replaces the choice', revote?.data?.totalVotes === 1, JSON.stringify(revote?.data));
  check(
    'revote moved the tally',
    revote?.data?.distribution?.b === 1 && revote?.data?.distribution?.a === 0,
    JSON.stringify(revote?.data?.distribution)
  );

  const badVote = await emit(socket, 'pollVote', { pollId, optionId: 'zzz' });
  check('rejects an unknown option', badVote?.ok === false, JSON.stringify(badVote));

  const closed = new Promise((resolve) => socket.once('pollClosed', resolve));
  const closeAck = await emit(socket, 'pollClose', { pollId });
  check('pollClose acked', closeAck?.ok === true, JSON.stringify(closeAck));
  const closedPayload = await Promise.race([
    closed,
    new Promise((r) => setTimeout(() => r(null), 4000)),
  ]);
  check('pollClosed broadcast', closedPayload?.pollId === pollId);
  check('final tally marked closed', resultsSeen.at(-1)?.closed === true);

  const voteAfterClose = await emit(socket, 'pollVote', { pollId, optionId: 'a' });
  check('rejects a vote after close', voteAfterClose?.ok === false, JSON.stringify(voteAfterClose));

  socket.disconnect();

  console.log('\n── shared join link gate ───────────────────────');
  const reg = await json(`/api/webinars/${webinar.slug}/register`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Gate Tester',
      email: `gate-${Date.now()}@example.com`,
      phone: '+91 98765 43210',
    }),
  });
  check('register with a mobile', reg.status === 200 && Boolean(reg.body.token), `status ${reg.status}`);
  const joinToken = reg.body.registration?.joinToken;

  const noPhone = await json(`/api/webinars/${webinar.slug}/register`, {
    method: 'POST',
    body: JSON.stringify({ name: 'No Phone', email: `nophone-${Date.now()}@example.com` }),
  });
  check('register without a mobile is rejected', noPhone.status === 400, `status ${noPhone.status}`);

  const info = await json(`/api/webinars/${webinar.slug}/join-info?token=${joinToken}`);
  check('join-info resolves the token', info.status === 200 && info.body.ok === true);
  check('join-info reports a complete profile', info.body.needsProfile === false);
  check('join-info exposes the mobile', Boolean(info.body.user?.phone));

  const claim = await json(`/api/webinars/${webinar.slug}/claim`, {
    method: 'POST',
    body: JSON.stringify({ token: joinToken, name: 'Gate Tester Renamed', phone: '+91 90000 11111' }),
  });
  check('claim returns a JWT', claim.status === 200 && Boolean(claim.body.token), `status ${claim.status}`);
  check('claim updated the name', claim.body.user?.name === 'Gate Tester Renamed');
  check('claim updated the mobile', claim.body.user?.phone === '+91 90000 11111');

  const badClaim = await json(`/api/webinars/${webinar.slug}/claim`, {
    method: 'POST',
    body: JSON.stringify({ token: 'not-a-real-token', name: 'Nobody', phone: '+91 90000 11111' }),
  });
  check('claim rejects a bad token', badClaim.status === 404, `status ${badClaim.status}`);

  console.log('\n── cleanup ─────────────────────────────────────');
  const del = await json(`/api/admin/polls/${pollId}`, { method: 'DELETE', headers: auth });  check('delete poll', del.status === 200 && del.body.ok === true, `status ${del.status}`);

  console.log(`\n${pass}/${pass + fail} checks passed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exitCode = 1;
});
