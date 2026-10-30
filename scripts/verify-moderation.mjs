/**
 * Verifies the moderation, enrolment and end-webinar features added in this
 * pass. Run with the server on :4000 and the web app on :3000.
 *
 *   node scripts/verify-moderation.mjs
 */
import { io } from 'socket.io-client';

const API = 'http://localhost:4000';
const SLUG = 'live-product-teardown';

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`);
  }
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function emit(socket, event, payload) {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
  });
}

function waitFor(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function main() {
  /* ── pick a webinar ─────────────────────────────────────── */
  const admin = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@webinar.local', password: 'Admin@12345' }),
  });
  const adminToken = admin.body?.token;
  check('admin can log in', Boolean(adminToken), admin.body?.error ?? '');
  if (!adminToken) return;

  const list = await api('/api/admin/webinars', {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const webinar = (list.body?.webinars ?? []).find((w) => w.slug === SLUG);
  check('admin can list webinars', Boolean(webinar?.id), webinar?.slug ?? '');
  if (!webinar) return;

  /* ── join as host and as a participant ──────────────────── */
  // The admin's own login token is the host token — there is no separate
  // /join endpoint; the role comes from the user record.
  const hostToken = adminToken;

  const stamp = Date.now();
  const viewerJoin = await api(`/api/webinars/${webinar.slug}/register`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Mod Viewer',
      email: `modviewer${stamp}@example.com`,
      phone: '+91 98765 43210',
    }),
  });
  const viewerToken = viewerJoin.body?.token;
  check('participant can join', Boolean(viewerToken), viewerJoin.body?.role ?? '');
  if (!hostToken || !viewerToken) return;

  const host = io(API, { auth: { token: hostToken }, transports: ['websocket'] });
  const viewer = io(API, { auth: { token: viewerToken }, transports: ['websocket'] });

  await Promise.all([waitFor(host, 'connect'), waitFor(viewer, 'connect')]);

  const hostJoinRes = await emit(host, 'join', { slug: webinar.slug, token: hostToken });
  check('host joins the room', hostJoinRes?.ok === true, hostJoinRes?.error ?? '');

  const viewerJoinRes = await emit(viewer, 'join', { slug: webinar.slug, token: viewerToken });
  check('participant joins the room', viewerJoinRes?.ok === true, viewerJoinRes?.error ?? '');

  /* ── profanity masking ──────────────────────────────────── */
  const received = waitFor(viewer, 'chatMessage');
  const sendRes = await emit(viewer, 'chatSend', { text: 'this is shit and fuck' });
  check('participant can send chat', sendRes?.ok === true, sendRes?.error ?? '');

  const msg = await received;
  check('profanity is masked', !/shit|fuck/i.test(msg.text), JSON.stringify(msg.text));
  check('masked text keeps the first letter', /^this is s\*+ and f\*+$/.test(msg.text), msg.text);

  /* ── chat delete ────────────────────────────────────────── */
  const deleted = waitFor(viewer, 'chatDeleted');
  const delRes = await emit(host, 'chatDelete', { id: msg.id });
  check('host can delete a message', delRes?.ok === true, delRes?.error ?? '');
  const delPayload = await deleted;
  check('participant receives chatDeleted', delPayload?.id === msg.id);

  const delAgain = await emit(host, 'chatDelete', { id: msg.id });
  check('deleting twice is rejected', delAgain?.ok === false, delAgain?.error ?? '');

  const viewerDel = await emit(viewer, 'chatDelete', { id: 'anything' });
  check('participant cannot delete messages', viewerDel?.ok === false, viewerDel?.error ?? '');

  /* ── system messages are protected ──────────────────────── */
  // Approving a hand emits a system chat line, which must not be deletable.
  const viewerUserId = viewerJoinRes?.data?.userId;
  const sysMsg = waitFor(viewer, 'chatMessage');
  await emit(host, 'handApprove', { userId: viewerUserId });
  const sys = await sysMsg;
  if (sys?.system) {
    const sysDel = await emit(host, 'chatDelete', { id: sys.id });
    check('system messages cannot be deleted', sysDel?.ok === false, sysDel?.error ?? '');
  } else {
    check('system messages cannot be deleted', false, 'no system message emitted');
  }

  /* ── participant cannot end the webinar ─────────────────── */
  const viewerEnd = await emit(viewer, 'webinarEnd');
  check('participant cannot end the webinar', viewerEnd?.ok === false, viewerEnd?.error ?? '');

  /* ── host ends the webinar ──────────────────────────────── */
  const ended = waitFor(viewer, 'webinarEnded', 5000).catch(() => null);
  const endRes = await emit(host, 'webinarEnd');
  check('host can end the webinar', endRes?.ok === true, endRes?.error ?? '');
  const endedPayload = await ended;
  check('participant is told the webinar ended', endedPayload !== null);

  const after = await api(`/api/admin/webinars`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const updated = (after.body?.webinars ?? after.body ?? []).find((w) => w.id === webinar.id);
  check('webinar status is ENDED', updated?.status === 'ENDED', updated?.status ?? 'missing');

  host.close();
  viewer.close();

  console.log(`\n${pass}/${pass + fail} checks passed`);
  console.log(`RESULT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
  // process.exit() trips a libuv assertion on Windows and reports the wrong
  // code, so the exit status is set and the process is allowed to drain.
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('ERROR', err);
  process.exitCode = 1;
});
