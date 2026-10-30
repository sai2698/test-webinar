/**
 * Runs every verification suite in order and prints a single summary.
 *
 * Each suite talks to a live API on :4000 and mutates the demo webinar, so they
 * must run one at a time — `verify-moderation` ends the webinar as its final
 * check, which is why the demo is reset between suites.
 *
 *   node scripts/verify-all.mjs
 *
 * Exits non-zero if any suite fails, so it can gate CI.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Order matters: moderation ends the webinar, so it runs last. */
const SUITES = [
  'verify-polls.mjs',
  'verify-qa.mjs',
  'verify-quiz-cta.mjs',
  'verify-engagement.mjs',
  'verify-guest-join.mjs',
  'verify-security.mjs',
  'verify-media-requests.mjs',
  'verify-waiting-room.mjs',
  'verify-recording.mjs',
  'verify-premiere.mjs',
  'verify-screen-share.mjs',
  'verify-media-effects.mjs',
  // webinar.gg parity. Each of these creates its own fixture webinar and
  // deletes it in a `finally`, so they neither need nor want a demo reset.
  'verify-custom-fields.mjs',
  'verify-approval.mjs',
  'verify-invites.mjs',
  'verify-cohosts.mjs',
  'verify-webhooks.mjs',
  'verify-public-api.mjs',
  'verify-embed.mjs',
  'verify-automation.mjs',
  'verify-series.mjs',
  'verify-stream-destinations.mjs',
  'verify-metrics.mjs',
  'verify-watermark.mjs',
  'verify-chat-announcements.mjs',
  'verify-participant-tabs.mjs',
  'verify-participant-visibility.mjs',
  // Session/auth is orthogonal to the room, so it sits with the parity suites
  // rather than the media ones — it only needs HTTP.
  'verify-admin-session.mjs',
  'verify-moderation.mjs',
];

/** Suites that leave the demo webinar in a state the next suite cannot use. */
const NEEDS_RESET = new Set([
  'verify-moderation.mjs',
  'verify-premiere.mjs',
  // Leaves the webinar LIVE with a startedAt, which the next suite's
  // "has it started" assertions would then read as already-open.
  'verify-waiting-room.mjs',
]);

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const results = [];
for (const suite of SUITES) {
  console.log(`\n${'═'.repeat(60)}\n  ${suite}\n${'═'.repeat(60)}`);
  const code = await run(suite);
  results.push({ suite, ok: code === 0 });

  if (NEEDS_RESET.has(suite)) {
    await run('reset-demo-webinar.mjs');
  }
}

console.log(`\n${'═'.repeat(60)}\n  SUMMARY\n${'═'.repeat(60)}`);
for (const { suite, ok } of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${suite}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} suites passed`);
process.exitCode = failed ? 1 : 0;
