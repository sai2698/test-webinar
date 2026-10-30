# Media effects

> For installation, configuration, and running the platform, see
> [`running-the-platform.md`](running-the-platform.md).

Virtual backgrounds, noise cancellation, and the video presentation options that
MiroTalk and webinar.gg expose. Everything here runs **in the browser** — no
media is uploaded, and the SFU never sees the unprocessed camera.

## Why this is client-side

The camera track is produced by `getUserMedia`, so the only place a background
can be replaced is between the camera and `sendTransport.produce()`. Doing it
server-side would mean decoding every participant's video on the SFU, which
costs more CPU than the whole room is worth.

The pipeline is therefore:

```
getUserMedia ──► BackgroundEffects (canvas) ──► producer.replaceTrack()
                        ▲
                        └── MediaPipe selfie segmentation (WASM, local)
```

Audio takes the same shape:

```
getUserMedia ──► AudioWorklet (spectral gate) ──► producer.replaceTrack()
```

## Feature set

| Feature | Where | Notes |
|---|---|---|
| Background: Off / Blur / Image | Settings panel | Blur is a 12 px canvas filter with a 24 px overscan so the edges do not smear |
| Background presets | Settings panel | Six bundled gradients, no network |
| Custom background upload | Settings panel | PNG/JPEG/WebP, downscaled to 1280 px and stored in IndexedDB |
| Drag-and-drop upload | Settings panel | Same validation path as the file picker |
| Noise cancellation | Settings panel | Spectral-gate AudioWorklet; falls back to native constraints |
| Echo cancellation | Settings panel | Native constraint only |
| Auto gain control | Settings panel | Native constraint only |
| Video fit | Settings panel | `fill` / `contain` / `cover` / `scale-down` / `none` |
| Mirror my video | Settings panel | Local preview only — never sent to peers |
| Camera frame rate | Settings panel | 15 / 24 / 30 fps, applied as a track constraint |

## Constraints and degradation

The environment this was built in has **no camera or microphone**, and the
corporate proxy blocks arbitrary CDNs. Both shaped the design:

1. **Nothing is fetched from a CDN.** `@mediapipe/tasks-vision` is a real
   dependency, and its bundle, WASM binaries and the selfie-segmentation model
   are copied into `apps/web/public/mediapipe/` and
   `apps/web/public/models/`. A deployment behind a firewall works unchanged.
2. **Every effect degrades to the raw camera.** If WebGL2 is missing, the model
   fails to load, or segmentation throws mid-stream, the processor reports the
   error, switches itself to `off`, and the caller re-publishes the original
   track. A participant never loses video because an effect failed.
3. **Noise cancellation does not need a WASM binary.** The worklet is a plain
   spectral gate written in-repo, so it works offline. The native
   `noiseSuppression` constraint remains the fallback when `AudioWorklet` is
   unavailable.

### `replaceTrack()` stops the outgoing track

This is the one non-obvious constraint in the whole feature, and it caused a
real bug.

`mediasoup-client`'s `Producer.replaceTrack()` calls `destroyTrack()` on the
track it is replacing, which calls `track.stop()`. That is reasonable for a
one-way swap, but a media effect swaps **back and forth**: the raw camera is
replaced by the processed canvas track, and later the processed track is
replaced by the raw camera again. With the default behaviour the raw camera is
already dead by the time it is needed, so turning the background off restored a
stopped track — the participant's own preview went black while every other
participant still saw them normally. Only the person affected could see it,
which is the worst possible failure mode.

Producers are therefore created with `stopTracks: false`, and every place that
is genuinely finished with a track stops it explicitly:

- the unmount cleanup stops `rawCameraTrackRef` and `rawMicTrackRef`;
- `switchDevice` stops the mic/camera it is replacing;
- `setAudioConstraint` and `setFrameRate` stop the track they re-acquired from;
- `BackgroundEffects.stop()` stops the canvas output track.

The same reasoning applies to the **preview** stream. `localStream` holds
whichever video track is currently on air, so both the `off` branch and the
error fallback have to put the raw camera back into it — swapping the producer
alone leaves the participant looking at a frozen tile.

### A tile must not wait forever to be told it is visible

`useInView` keeps off-screen tiles from mounting a `<video>`, which is what
stops a 200-person grid from downloading 200 streams. But `IntersectionObserver`
reports asynchronously, and in a page that is never actually painted — a
background tab, a headless harness, a prerender — the first callback may never
arrive. The tile then renders a permanent placeholder and the viewer concludes
the call is broken.

The hook therefore fails open after 1.5 s **if the observer has stayed silent**.
A real "off screen" verdict is still honoured, so the bandwidth saving is
preserved; only the pathological case changes behaviour.

## Files

| File | Role |
|---|---|
| `apps/web/lib/backgroundEffects.ts` | The canvas render loop and MediaPipe segmentation |
| `apps/web/lib/audioProcessor.ts` | The AudioWorklet wrapper and native-constraint fallback |
| `apps/web/public/worklets/noiseSuppressionProcessor.js` | The spectral gate itself |
| `apps/web/lib/mediaPrefs.ts` | localStorage + IndexedDB persistence |
| `apps/web/components/MediaSettingsPanel.tsx` | The UI |
| `apps/web/lib/useMediasoup.ts` | Applies the effects to the published tracks |

## Persistence

Preferences live in `localStorage` under `media_prefs`:

```json
{
  "background": { "mode": "blur", "image": { "type": "preset", "src": "aurora" } },
  "noiseSuppression": true,
  "echoCancellation": true,
  "autoGainControl": true,
  "videoFit": "cover",
  "mirror": true,
  "frameRate": 30
}
```

For a preset, `src` holds the preset id; `presetDataUrl()` renders the gradient to
a 1280×720 canvas and caches the JPEG data URL, because the effect pipeline needs
an `<img>` it can `drawImage` and a CSS gradient is not one.

An uploaded image is a `Blob` in IndexedDB (`nexalive-media` / `backgrounds`),
referenced as `{ "type": "custom", "src": "<object URL>" }`. Blobs do not belong
in `localStorage` — a 4 MB base64 string would blow the 5 MB quota on its own.
The object URL is recreated on every page load.

`loadPrefs()` merges field by field with per-field guards rather than trusting
the stored shape, and returns `DEFAULT_PREFS` on any throw. A corrupt entry must
not be able to break the room.

## Verification

There is no camera or microphone in this environment, so the suite is structural.
`scripts/verify-media-effects.mjs` (45 assertions) checks the things that would
silently break the feature in production:

1. **The vendored assets are served.** The MediaPipe bundle, its WASM, the
   segmentation model, and the worklet all return 200 from our own origin at a
   plausible size. A CDN dependency is a firewall dependency.
2. **The worklet is plain JavaScript.** It is served verbatim, so a stray
   TypeScript annotation is a `SyntaxError` at `addModule` time — in the browser,
   for every participant, and nowhere else. The suite strips nothing and asserts
   no access modifiers, no type annotations, no imports, no exports.
3. **The fallback paths exist.** The processor preserves audio tracks, the render
   loop is `setTimeout`-driven rather than `requestAnimationFrame` (which is
   throttled to a standstill in a background tab), the hidden `<video>` is not
   `display: none` (which yields black frames from `drawImage` in some browsers),
   and the hook keeps the raw camera and microphone tracks so an effect can be
   removed again.
4. **Preferences are validated, not trusted.** Uploads are capped at 10 MB and
   restricted to PNG/JPEG/WebP before any decoding work happens.
5. **The UI is wired.** The panel offers all three modes, renders the preset grid,
   accepts drag-and-drop, surfaces errors inline, and the tile applies fit and
   mirror to the local preview only.

The panel itself is browser-verified: it opens from the control bar, Escape
closes it, the background controls are disabled with an explanation when the
camera is off, and the fit/mirror controls persist to `localStorage`.

What cannot be verified here is the render loop against a real camera. It is
exercised with a synthetic `canvas.captureStream()` track standing in for one.

## CSP

If a deployment adds a Content-Security-Policy it must allow:

- `script-src 'self' 'wasm-unsafe-eval'` — the MediaPipe WASM instantiation
- `worker-src 'self' blob:` — the AudioWorklet module
- `img-src 'self' blob: data:` — uploaded backgrounds and preset gradients

No third-party origin is required.
