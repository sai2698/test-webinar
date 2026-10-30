/**
 * Shared plumbing for the webinar.gg parity verification suites.
 *
 * Every suite needs the same four things: an admin token, a throwaway webinar
 * to mutate, a check counter, and a cleanup that runs even when a check throws.
 * Duplicating that in twelve files is how suites drift apart, so it lives here.
 *
 * A suite creates its own fixture webinar rather than borrowing the demo one.
 * The smoke test proved why: a suite that depends on seeded state breaks the
 * moment a previous run, a demo reset, or a colleague's browser changes it.
 */
import { io } from 'socket.io-client';

export const API = 'http://localhost:4000';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tiny assertion recorder. Prints as it goes so a hang is visible. */
export function createChecker() {
  const checks = [];
  return {
    check(label, ok, detail) {
      checks.push({ label, ok: Boolean(ok) });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
    },
    finish() {
      const failed = checks.filter((c) => !c.ok).length;
      console.log(`\n${checks.length - failed}/${checks.length} checks passed\n`);
      process.exitCode = failed === 0 ? 0 : 1;
      return failed === 0;
    },
    get failed() {
      return checks.filter((c) => !c.ok).length;
    },
  };
}

/** A fetch wrapper that never throws on a non-2xx and always returns JSON. */
export async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

export async function login(email = 'admin@webinar.local', password = 'Admin@12345') {
  const res = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (res.status !== 200 || !res.json?.token) {
    throw new Error(`login failed: ${res.status} ${res.text}`);
  }
  return res.json;
}

/**
 * Creates a DRAFT webinar owned by the admin, with the given settings merged
 * over a sane default. Returns the created row.
 *
 * DRAFT rather than SCHEDULED because several features (stream keys, series)
 * are locked once a session is live, and a suite must not have to care.
 */
export async function makeWebinar(token, overrides = {}) {
  const stamp = Date.now();
  const res = await api('/api/admin/webinars', {
    method: 'POST',
    token,
    body: {
      title: `Parity Fixture ${stamp}`,
      description: 'Created by a verification suite.',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      durationMins: 60,
      timezone: 'Asia/Kolkata',
      settings: {
        requireRegistration: true,
        chatEnabled: true,
        handRaiseEnabled: true,
        ...(overrides.settings ?? {}),
      },
      ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'settings')),
    },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`create webinar failed: ${res.status} ${res.text}`);
  }
  return res.json.webinar ?? res.json;
}

/** Deletes a fixture webinar. Never throws — cleanup must not mask a failure. */
export async function dropWebinar(token, id) {
  if (!id) return;
  try {
    await api(`/api/admin/webinars/${id}`, { method: 'DELETE', token });
  } catch {
    /* a leaked fixture is better than a crashed suite */
  }
}

/** Registers a participant against a slug and returns the JWT + join token. */
export async function register(slug, name, email) {
  const res = await api(`/api/webinars/${slug}/register`, {
    method: 'POST',
    body: { name, email, phone: '+91 98765 43210' },
  });
  if (res.status !== 200) throw new Error(`register failed: ${res.status} ${res.text}`);
  return res.json;
}

export function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    socket.on('connect_error', reject);
    socket.on('connect', () => resolve(socket));
  });
}

export const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

/** For events whose server handler takes only an ack. */
export const emitBare = (socket, event) => new Promise((resolve) => socket.emit(event, resolve));

/** Waits for a broadcast, or resolves null after `ms` so a missing event fails a check. */
export function waitFor(socket, event, ms = 4000) {
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

/** Wraps a suite body so a thrown error still reports a non-zero exit code. */
export function runSuite(name, body) {
  console.log(`\n=== ${name} ===\n`);
  body().catch((err) => {
    console.error('\nFATAL:', err);
    process.exitCode = 1;
  });
}
