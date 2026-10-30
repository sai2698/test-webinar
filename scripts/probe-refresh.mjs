/**
 * Probe: does a *refresh* (same user joining twice) lose producers?
 *
 * A browser refresh does not close the old socket before the new one joins, so
 * the server sees two joins for one userId. This script reproduces that: it
 * connects as a participant, then connects again with the same token while the
 * first socket is still open, and prints the snapshot each one received.
 */
import { io } from 'socket.io-client';

const API = 'http://localhost:4000';
const SLUG = 'live-product-teardown';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

function describe(snap) {
  return snap.peers.map((p) => `${p.name}(${p.role})[${p.producers.map((x) => x.source).join(',')}]`);
}

const email = `refresh${Date.now()}@example.com`;
const reg = await api(`/api/webinars/${SLUG}/register`, {
  method: 'POST',
  body: JSON.stringify({ name: 'Refresh Probe', email, phone: '+91 98765 43210' }),
});
if (!reg.json?.token) {
  console.log('REGISTER FAILED', reg.status, reg.text.slice(0, 300));
  process.exitCode = 1;
} else {
  const token = reg.json.token;

  const connect = () =>
    new Promise((resolve) => {
      const s = io(API, { auth: { token }, transports: ['websocket'] });
      s.on('kicked', (p) => console.log('  [kicked]', JSON.stringify(p)));
      s.on('connect', () => {
        s.emit('join', { slug: SLUG, token }, (res) => resolve({ socket: s, res }));
      });
    });

  console.log('--- first join (the tab that is about to be refreshed) ---');
  const a = await connect();
  console.log('  ok:', a.res?.ok, 'peers:', a.res?.ok ? describe(a.res.data.snapshot) : a.res?.error);

  await sleep(500);

  console.log('--- second join, same user, first socket still open (the refresh) ---');
  const b = await connect();
  console.log('  ok:', b.res?.ok, 'peers:', b.res?.ok ? describe(b.res.data.snapshot) : b.res?.error);

  await sleep(1500);

  console.log('--- third join, after the first socket has been kicked ---');
  const c = await connect();
  console.log('  ok:', c.res?.ok, 'peers:', c.res?.ok ? describe(c.res.data.snapshot) : c.res?.error);

  a.socket.close();
  b.socket.close();
  c.socket.close();
  await sleep(500);
}
