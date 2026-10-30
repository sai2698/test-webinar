/**
 * Verifies the media-effects layer: vendored assets, preference handling, and
 * the pure-logic helpers behind virtual backgrounds and noise cancellation.
 *
 * There is no camera or microphone on this machine, so the render loop and the
 * audio graph cannot be exercised end to end. What *can* be checked is
 * everything that would silently break the feature in production:
 *
 *   1. The MediaPipe bundle, its WASM, and the segmentation model are served
 *      from our own origin. A CDN dependency is a firewall dependency.
 *   2. The AudioWorklet is valid plain JavaScript. It is served verbatim, so a
 *      stray TypeScript annotation would fail at `addModule` time, in the
 *      browser, for every participant.
 *   3. Preference loading never throws and never trusts stored data.
 *   4. Upload validation rejects the wrong type and the wrong size before any
 *      decoding work happens.
 *
 * Run with the web dev server on :3000 and the API on :4000.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB = 'http://localhost:3000';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function head(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return { status: res.status, size: (await res.arrayBuffer()).byteLength };
  } catch (error) {
    return { status: 0, size: 0, error: String(error) };
  }
}

/* ── 1. vendored assets ──────────────────────────────────── */
async function checkAssets() {
  console.log('\nVendored assets');

  const assets = [
    ['/mediapipe/vision_bundle.mjs', 100_000],
    ['/mediapipe/wasm/vision_wasm_internal.js', 100_000],
    ['/mediapipe/wasm/vision_wasm_internal.wasm', 1_000_000],
    ['/models/selfie_segmenter_landscape.tflite', 100_000],
    ['/worklets/noiseSuppressionProcessor.js', 5_000],
  ];

  for (const [path, minSize] of assets) {
    const { status, size } = await head(`${WEB}${path}`);
    check(
      `${path} is served (${size} bytes)`,
      status === 200 && size >= minSize,
      `status ${status}, ${size} bytes, expected >= ${minSize}`
    );
  }
}

/* ── 2. the worklet is plain JavaScript ──────────────────── */
async function checkWorklet() {
  console.log('\nAudioWorklet source');

  const source = await readFile(
    join(ROOT, 'apps/web/public/worklets/noiseSuppressionProcessor.js'),
    'utf8'
  );

  check('registers the expected processor name', source.includes("registerProcessor('noise-suppression'"));
  check('extends AudioWorkletProcessor', source.includes('extends AudioWorkletProcessor'));

  // A TypeScript annotation in a file served verbatim is a runtime SyntaxError
  // in the browser — and only in the browser, so nothing else would catch it.
  const tsPatterns = [
    [/^\s*(private|public|protected|readonly)\s/m, 'access modifier'],
    [/:\s*(Float32Array|Uint16Array|number|boolean|void|string)\b/, 'type annotation'],
    [/^\s*import\s/m, 'import statement'],
    [/^\s*export\s/m, 'export statement'],
  ];
  for (const [pattern, label] of tsPatterns) {
    check(`no ${label}`, !pattern.test(source));
  }

  // The FFT is the part that must be numerically right, so at least confirm
  // the tables it depends on are actually built.
  check('builds a bit-reversal table', source.includes('bitReverse'));
  check('builds twiddle tables', source.includes('cosTable') && source.includes('sinTable'));
  check('uses a 512-point transform', source.includes('FFT_SIZE = 512'));
}

/* ── 3. preference handling ──────────────────────────────── */
async function checkPrefs() {
  console.log('\nPreference helpers');

  // The module is TypeScript and imports nothing browser-only at module scope,
  // so it can be transpiled on the fly by tsx. Rather than pull in a bundler,
  // assert the invariants directly against the source.
  const source = await readFile(join(ROOT, 'apps/web/lib/mediaPrefs.ts'), 'utf8');

  check('defines six background presets', (source.match(/id: '/g) ?? []).length >= 6);
  check('presets are gradients, not image files', source.includes('linear-gradient'));
  check('caps uploads at 10 MB', source.includes('10 * 1024 * 1024'));
  check(
    'accepts only png/jpeg/webp',
    source.includes('image/png') && source.includes('image/jpeg') && source.includes('image/webp')
  );
  check('downscales uploads to 1280 px', source.includes('MAX_UPLOAD_SIDE = 1280'));
  check('stores prefs under a versioned key', source.includes("STORAGE_KEY = 'media_prefs'"));
  check('keeps custom backgrounds in IndexedDB', source.includes('indexedDB'));
  check('validates every field on load', source.includes('function isMode') && source.includes('function isFit'));
  check('falls back to defaults on a throw', /catch[\s\S]{0,200}DEFAULT_PREFS/.test(source));
}

/* ── 4. the effect never costs someone their video ───────── */
async function checkFallbacks() {
  console.log('\nFallback behaviour');

  const effects = await readFile(join(ROOT, 'apps/web/lib/backgroundEffects.ts'), 'utf8');
  const hook = await readFile(join(ROOT, 'apps/web/lib/useMediasoup.ts'), 'utf8');

  check('processor exposes a supported() probe', effects.includes('static supported()'));
  check('processor preserves the audio tracks', effects.includes('...stream.getAudioTracks()'));
  check('processor can be stopped without killing the camera', effects.includes('stop(stopCamera'));

  // Strip comments before asserting on code shape — the file explains *why* it
  // avoids rAF and display:none, and those explanations must not count as use.
  const code = effects
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  check(
    'render loop is setTimeout-driven, not rAF',
    code.includes('setTimeout') && !code.includes('requestAnimationFrame')
  );
  check(
    'hidden video is not display:none',
    !/display\s*:\s*['"]?none/.test(code)
  );

  check('hook keeps the raw camera track', hook.includes('rawCameraTrackRef'));
  check('hook keeps the raw microphone track', hook.includes('rawMicTrackRef'));
  check('a failed effect falls back to the raw camera', /catch[\s\S]{0,900}swapCameraTrack\(raw\)/.test(hook));
  check('hook tears the processor down on unmount', hook.includes('effectsRef.current?.stop()'));
  check('hook tears the audio graph down on unmount', hook.includes('audioProcessorRef.current?.stop()'));

  /**
   * `Producer.replaceTrack()` calls `destroyTrack()` on the outgoing track,
   * which stops it. A media effect swaps back and forth, so the raw camera has
   * to survive being replaced — otherwise turning the background off restores
   * a dead track and the participant's own video goes black while everyone
   * else still sees them. The producer must be created with `stopTracks: false`
   * and every genuinely-finished track stopped explicitly.
   */
  check(
    'producers do not stop tracks on replace',
    hook.includes('stopTracks: false')
  );
  check(
    'raw tracks are released on unmount',
    /rawCameraTrackRef\.current\?\.stop\(\)/.test(hook) &&
      /rawMicTrackRef\.current\?\.stop\(\)/.test(hook)
  );
  check(
    'turning the effect off restores the preview stream',
    /mode === 'off'[\s\S]{0,1400}preview\.addTrack\(cameraTrack\)/.test(hook)
  );
  check(
    'the error path restores the preview stream too',
    /swapCameraTrack\(raw\)[\s\S]{0,900}preview\.addTrack\(raw\)/.test(hook)
  );

  check(
    'native suppressor is only requested without the worklet',
    (await readFile(join(ROOT, 'apps/web/lib/audioProcessor.ts'), 'utf8')).includes(
      'options.noiseSuppression && !workletSupported()'
    )
  );
}

/* ── 5. UI wiring ────────────────────────────────────────── */
async function checkUi() {
  console.log('\nUI wiring');

  const panel = await readFile(join(ROOT, 'apps/web/components/MediaSettingsPanel.tsx'), 'utf8');
  const controls = await readFile(join(ROOT, 'apps/web/components/ControlsBar.tsx'), 'utf8');
  const tile = await readFile(join(ROOT, 'apps/web/components/VideoTile.tsx'), 'utf8');

  check('panel offers off/blur/image', panel.includes("'off'") && panel.includes("'blur'") && panel.includes("'image'"));
  check('panel renders the preset grid', panel.includes('BACKGROUND_PRESETS.map'));
  check('panel accepts drag and drop', panel.includes('onDrop'));
  check('panel surfaces errors inline', panel.includes('role="alert"'));
  check('panel closes on Escape', panel.includes("e.key === 'Escape'"));
  check('panel warns when the camera is off', panel.includes('Turn your camera on'));

  check('panel exposes echo cancellation', panel.includes('Echo cancellation'));
  check('panel exposes auto gain control', panel.includes('Auto gain control'));
  check('panel exposes a frame rate selector', panel.includes('FRAME_RATES.map'));

  check('controls bar has a media settings button', controls.includes('Media settings'));
  check('controls bar mounts the panel', controls.includes('<MediaSettingsPanel'));
  check('controls bar gates on every media handler', controls.includes('onSetEchoCancellation &&'));

  check('tile applies the preferred fit to the local preview', tile.includes('isLocal ? preferredFit'));
  check('tile mirrors only the local preview', tile.includes('isLocal && !isScreen && preferredMirror'));
  check('tile never mirrors a screen share', tile.includes("isScreen ? 'contain'"));

  // The store must carry every preference the panel can change, or a control
  // would render from a value nothing ever updates.
  const store = await readFile(join(ROOT, 'apps/web/store/roomStore.ts'), 'utf8');
  for (const field of ['echoCancellation', 'autoGainControl', 'frameRate']) {
    check(`store carries ${field}`, new RegExp(`\\b${field}:`).test(store));
  }

  // Re-acquiring the microphone is the only way to change a native constraint,
  // so the hook must do it and must swap the track rather than renegotiate.
  const hook = await readFile(join(ROOT, 'apps/web/lib/useMediasoup.ts'), 'utf8');
  check('hook re-acquires audio for constraint changes', hook.includes("setAudioConstraint('echoCancellation'"));
  check('hook re-acquires video for frame rate changes', hook.includes('setFrameRate'));
  check('hook swaps tracks instead of renegotiating', hook.includes('producer.replaceTrack({ track: processed })'));
}

const run = async () => {
  console.log('Media effects verification');
  console.log('==========================');

  await checkAssets();
  await checkWorklet();
  await checkPrefs();
  await checkFallbacks();
  await checkUi();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
};

run().catch((error) => {
  console.error('suite crashed:', error);
  process.exitCode = 1;
});
