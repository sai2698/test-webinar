/**
 * Ensures the mediasoup native worker binary exists.
 *
 * mediasoup ships a prebuilt `mediasoup-worker` binary per platform, but its
 * own postinstall download can fail behind corporate proxies. This script
 * checks for the binary and, if missing, downloads the official prebuilt
 * tarball directly from GitHub releases.
 *
 * Safe to run repeatedly — it exits immediately when the binary is present.
 */
import { existsSync, mkdirSync, createWriteStream, unlinkSync, chmodSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, '..');

function findMediasoupRoot() {
  const candidates = [
    join(serverRoot, 'node_modules', 'mediasoup'),
    join(serverRoot, '..', '..', 'node_modules', 'mediasoup'),
  ];
  return candidates.find((p) => existsSync(join(p, 'package.json'))) ?? null;
}

const msRoot = findMediasoupRoot();
if (!msRoot) {
  console.log('[mediasoup] package not installed yet — skipping worker check');
  process.exit(0);
}

const isWin = os.platform() === 'win32';
const binPath = join(
  msRoot,
  'worker',
  'out',
  'Release',
  isWin ? 'mediasoup-worker.exe' : 'mediasoup-worker'
);

if (existsSync(binPath)) {
  console.log('[mediasoup] worker binary present');
  process.exit(0);
}

const pkg = JSON.parse(
  execSync(`node -p "JSON.stringify(require('${join(msRoot, 'package.json').replace(/\\/g, '/')}'))"`, {
    encoding: 'utf8',
  })
);

let tarName = `mediasoup-worker-${pkg.version}-${os.platform()}-${os.arch()}`;
if (os.platform() === 'linux') {
  tarName += `-kernel${Number(os.release().split('.')[0])}`;
}
tarName += '.tgz';

const url = `https://github.com/versatica/mediasoup/releases/download/${pkg.version}/${tarName}`;
console.log(`[mediasoup] downloading worker: ${url}`);

const releaseDir = join(msRoot, 'worker', 'out', 'Release');
mkdirSync(releaseDir, { recursive: true });
const tarPath = join(releaseDir, 'worker.tgz');

try {
  let downloaded = false;

  // Node's global fetch does not honour HTTP(S)_PROXY, which breaks behind
  // corporate proxies. Try curl first (it does), then fall back to fetch.
  try {
    execSync(`curl -sSL --retry 3 -o "${tarPath}" "${url}"`, { stdio: 'inherit' });
    downloaded = existsSync(tarPath) && statSync(tarPath).size > 100_000;
  } catch {
    downloaded = false;
  }

  if (!downloaded) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath));
  }

  execSync(`tar -xzf "${tarPath}" -C "${releaseDir}"`, { stdio: 'inherit' });
  unlinkSync(tarPath);
  if (!isWin) chmodSync(binPath, 0o775);
  console.log('[mediasoup] worker binary installed');
} catch (err) {
  console.warn(
    `[mediasoup] could not fetch prebuilt worker (${err.message}).\n` +
      '  The server will still start, but media routing needs the binary.\n' +
      '  Fix: run `npm run worker:build -w @webinar/server` (needs Python 3 + C++ toolchain).'
  );
}
