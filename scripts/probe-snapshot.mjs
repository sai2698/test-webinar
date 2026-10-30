/**
 * Probe: what does a fresh participant's `join` snapshot actually contain?
 *
 * Connects as a brand-new participant to the demo webinar and prints every
 * peer's producers, then consumes each one and reports the ack.
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

const email = `probe${Date.now()}@example.com`;
const reg = await api(`/api/webinars/${SLUG}/register`, {
  method: 'POST',
  body: JSON.stringify({ name: 'Snapshot Probe', email, phone: '+91 98765 43210' }),
});
if (!reg.json?.token) {
  console.log('REGISTER FAILED', reg.status, reg.text.slice(0, 300));
  process.exitCode = 1;
} else {
  const socket = io(API, { auth: { token: reg.json.token }, transports: ['websocket'] });

  const announced = [];
  socket.on('newProducer', (p) => announced.push(p));

  const joinRes = await new Promise((resolve) => {
    socket.emit('join', { slug: SLUG, token: reg.json.token }, resolve);
  });

  if (!joinRes?.ok) {
    console.log('JOIN FAILED', JSON.stringify(joinRes));
    process.exitCode = 1;
  } else {
    const snap = joinRes.data.snapshot;
    console.log('SELF:', joinRes.data.name, joinRes.data.role);
    console.log('PEERS:');
    for (const p of snap.peers) {
      console.log(
        `  ${p.name} (${p.role}) camOn=${p.camOn} micOn=${p.micOn} producers=${JSON.stringify(
          p.producers.map((x) => `${x.source}:${x.producerId.slice(0, 8)}`)
        )}`
      );
    }

    // Consume everything the snapshot advertised.
    const results = [];
    for (const p of snap.peers) {
      for (const prod of p.producers) {
        const ack = await new Promise((resolve) => {
          socket.emit(
            'consume',
            { producerId: prod.producerId, rtpCapabilities: joinRes.data.rtpCapabilities },
            resolve
          );
        });
        results.push({
          peer: p.name,
          source: prod.source,
          ok: ack?.ok,
          err: ack?.error,
          ackSource: ack?.data?.source,
        });
      }
    }
    console.log('CONSUME RESULTS:');
    for (const r of results) console.log(' ', JSON.stringify(r));

    await sleep(1500);
    console.log('NEWPRODUCER EVENTS AFTER JOIN:', JSON.stringify(announced));

    socket.close();
  }
}
