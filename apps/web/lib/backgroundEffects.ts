'use client';

/**
 * Virtual backgrounds for the outgoing camera.
 *
 * The camera track is drawn into a canvas every frame, the person is cut out
 * with MediaPipe's selfie segmentation, and the result is captured back into a
 * new video track. That track replaces the camera on the producer, so peers see
 * the effect and the SFU never has to decode anything.
 *
 * Three things here are deliberate and easy to get wrong:
 *
 * 1. **Audio is preserved.** `start()` returns a stream built from the new
 *    video track *plus the original audio tracks*. Returning only the video
 *    track silently mutes the participant.
 * 2. **Every failure falls back to the raw camera.** A model that will not load
 *    or a GPU that throws mid-call must not cost someone their video, so the
 *    render loop catches, switches itself off, and reports through `onError`.
 * 3. **The model is loaded lazily and only once.** Blur and image both need it,
 *    `off` does not, and a participant who never touches the setting should
 *    never download 9 MB of WASM.
 */

export type BackgroundMode = 'off' | 'blur' | 'image';

export interface BackgroundImage {
  /** A bundled preset, or an image the participant uploaded. */
  type: 'preset' | 'custom';
  /** Preset id, or an object URL for a custom upload. */
  src: string;
}

/** Effect output is capped so a 4K camera cannot melt a laptop. */
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;

/** Segmentation is expensive; 15 fps is the point where it stops looking broken. */
const EFFECT_FPS = 15;

/** Blur radius, and the overscan that keeps the blurred edge out of frame. */
const BLUR_PX = 12;
const BLUR_OVERSCAN = 24;

/**
 * Where the vendored MediaPipe assets live.
 *
 * These are copied into `public/` at build time rather than pulled from
 * jsDelivr, because a deployment behind a firewall must still work. See
 * `docs/media-effects.md`.
 */
const MEDIAPIPE_BASE = '/mediapipe';
const MODEL_PATH = '/models/selfie_segmenter_landscape.tflite';

/** The subset of the MediaPipe API this file touches. */
interface Segmenter {
  segmentForVideo(
    video: HTMLVideoElement,
    timestamp: number,
    callback: (result: { confidenceMasks: unknown[] }) => void
  ): void;
  close(): void;
}

interface DrawingUtilsLike {
  drawConfidenceMask(mask: unknown, canvas: HTMLCanvasElement, video: HTMLVideoElement): void;
  close?(): void;
}

export class BackgroundEffects {
  /**
   * Whether this browser can run the effect at all.
   *
   * Both halves matter: `captureStream` is how the canvas becomes a track, and
   * WebGL2 is what MediaPipe's GPU delegate needs. Safari before 16.4 has the
   * first but not the second.
   */
  static supported(): boolean {
    if (typeof document === 'undefined') return false;
    const canvas = document.createElement('canvas');
    return (
      typeof canvas.captureStream === 'function' &&
      typeof canvas.getContext === 'function' &&
      Boolean(canvas.getContext('webgl2'))
    );
  }

  private readonly onError: (error: Error) => void;

  private mode: BackgroundMode = 'off';
  private image: BackgroundImage | null = null;
  private stopped = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly background: HTMLCanvasElement;
  private readonly backgroundContext: CanvasRenderingContext2D;
  private readonly maskCanvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;

  private cameraTrack: MediaStreamTrack | null = null;
  private output: MediaStream | null = null;
  private outputTrack: MediaStreamTrack | null = null;

  private segmenter: Segmenter | null = null;
  private drawing: DrawingUtilsLike | null = null;
  private modelPromise: Promise<void> | null = null;

  /** The decoded background image, once it has loaded. */
  private imageElement: HTMLImageElement | null = null;

  private frame: ReturnType<typeof setTimeout> | null = null;
  private lastFrame = 0;
  private cameraEnded: (() => void) | null = null;

  constructor(onError: (error: Error) => void = () => {}) {
    this.onError = onError;

    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d')!;

    this.background = document.createElement('canvas');
    this.backgroundContext = this.background.getContext('2d')!;

    this.maskCanvas = document.createElement('canvas');

    // The camera has to be attached to a real <video> element to be drawn from.
    // It is kept off-screen rather than `display: none`, because a display-none
    // video is not decoded in some browsers and `drawImage` then yields black.
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.style.cssText =
      'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:0;left:0';
    this.video.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.video);
  }

  /**
   * Attaches the camera and starts the render loop.
   *
   * Returns a stream that is safe to publish directly: the processed video
   * track followed by the original audio tracks.
   */
  async start(stream: MediaStream): Promise<MediaStream> {
    const cameraTrack = stream.getVideoTracks()[0];
    if (!cameraTrack) throw new Error('No camera track to process');

    this.cameraTrack = cameraTrack;
    this.video.srcObject = new MediaStream([cameraTrack]);
    await this.video.play();

    // `stop()` may have run while `play()` was awaiting.
    if (this.stopped) throw new Error('Camera processing stopped');

    this.resize();
    this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    this.output = this.canvas.captureStream(60);
    this.outputTrack = this.output.getVideoTracks()[0];

    // If the camera is unplugged or revoked, the effect has nothing to draw.
    this.cameraEnded = () => this.stop();
    cameraTrack.addEventListener('ended', this.cameraEnded, { once: true });

    this.render(performance.now());

    return new MediaStream([this.outputTrack, ...stream.getAudioTracks()]);
  }

  /**
   * Switches the effect.
   *
   * `image` is required for `'image'` mode and ignored otherwise. The model is
   * loaded before the mode changes, so a failed load leaves the previous mode
   * intact rather than showing a half-applied state.
   */
  async setMode(mode: BackgroundMode, image: BackgroundImage | null = this.image): Promise<void> {
    if (!['off', 'blur', 'image'].includes(mode)) {
      throw new Error('Invalid background mode');
    }
    if (mode === 'blur' && !('filter' in this.backgroundContext)) {
      throw new Error('Background blur is not supported by this browser');
    }

    if (mode !== 'off') {
      if (mode === 'image') {
        if (!image) throw new Error('Choose a background image first');
        await this.loadImage(image);
      }
      await this.loadModel();
    }

    if (this.stopped) return;
    this.image = image;
    this.mode = mode;
  }

  /** The mode currently in effect — `off` after a fallback. */
  get currentMode(): BackgroundMode {
    return this.mode;
  }

  /**
   * The processed video track, for `producer.replaceTrack()`.
   *
   * Exposed separately from `start()`'s return value because a mode change
   * reuses the same track — the canvas keeps capturing, only its contents
   * change — so the caller must be able to reach it without restarting.
   */
  get videoTrack(): MediaStreamTrack | null {
    return this.outputTrack;
  }

  /**
   * Loads the segmentation model, once.
   *
   * The promise is cached so two rapid mode changes share one download, and
   * cleared on failure so a retry after a transient network error can succeed.
   */
  private loadModel(): Promise<void> {
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        const { FilesetResolver, ImageSegmenter, DrawingUtils } = await import(
          /* webpackIgnore: true */ `${MEDIAPIPE_BASE}/vision_bundle.mjs`
        );

        const files = await FilesetResolver.forVisionTasks(`${MEDIAPIPE_BASE}/wasm`);
        const segmenter = await ImageSegmenter.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
          canvas: this.maskCanvas,
          runningMode: 'VIDEO',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        });

        if (this.stopped) {
          segmenter.close();
          return;
        }

        this.segmenter = segmenter as Segmenter;
        this.drawing = new DrawingUtils(
          this.maskCanvas.getContext('webgl2')
        ) as unknown as DrawingUtilsLike;
      })().catch((error) => {
        this.modelPromise = null;
        throw error;
      });
    }
    return this.modelPromise;
  }

  /** Decodes the background image, reusing it if it is already loaded. */
  private async loadImage(image: BackgroundImage): Promise<void> {
    if (this.imageElement && this.image?.src === image.src) return;

    const element = new Image();
    element.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      element.onload = () => resolve();
      element.onerror = () => reject(new Error('Unable to load background image'));
      element.src = image.src;
    });
    this.imageElement = element;
  }

  /**
   * Matches the canvases to the camera.
   *
   * `off` keeps the camera's native resolution — there is no reason to
   * downscale a stream that is not being processed. Effects are capped at
   * 720p because segmentation cost scales with pixels.
   */
  private resize(): void {
    const scale =
      this.mode === 'off'
        ? 1
        : Math.min(1, MAX_WIDTH / this.video.videoWidth, MAX_HEIGHT / this.video.videoHeight);

    const width = Math.max(1, Math.round(this.video.videoWidth * scale));
    const height = Math.max(1, Math.round(this.video.videoHeight * scale));

    if (this.canvas.width === width && this.canvas.height === height) return;

    for (const canvas of [this.canvas, this.background, this.maskCanvas]) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  /**
   * The render loop.
   *
   * Driven by `setTimeout` rather than `requestAnimationFrame` because rAF is
   * throttled to a standstill in a background tab, and a participant who tabs
   * away should still be sending video.
   */
  private render(timestamp: number): void {
    if (this.stopped) return;

    const cameraFps = this.cameraTrack?.getSettings().frameRate || 30;
    const fps = this.mode === 'off' ? Math.min(60, cameraFps) : Math.min(cameraFps, EFFECT_FPS);
    const interval = 1000 / fps;

    if (this.video.readyState >= 2 && timestamp - this.lastFrame >= interval) {
      this.lastFrame = timestamp;
      this.resize();

      const { width, height } = this.canvas;

      try {
        if (this.mode === 'off') {
          this.context.drawImage(this.video, 0, 0, width, height);
        } else {
          this.drawBackground(width, height);

          this.segmenter!.segmentForVideo(this.video, timestamp, (result) => {
            // The mask is drawn onto the background canvas, then the whole
            // thing is composited over the frame. Drawing the mask straight
            // into the output would erase the person instead of the room.
            this.drawing!.drawConfidenceMask(result.confidenceMasks[0], this.background, this.video);
            this.context.drawImage(this.maskCanvas, 0, 0, width, height);
          });
        }
      } catch (error) {
        // A GPU that dies mid-call must not take the video with it.
        this.mode = 'off';
        this.context.drawImage(this.video, 0, 0, width, height);
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }

      // Without this the captured track only updates when the canvas is
      // otherwise touched, which makes the video stutter.
      if (!this.stopped) {
        (this.outputTrack as CanvasCaptureMediaStreamTrack | null)?.requestFrame?.();
      }
    }

    if (!this.stopped) {
      this.frame = setTimeout(() => this.render(performance.now()), 1000 / 60);
    }
  }

  /** Paints the replacement background behind the person. */
  private drawBackground(width: number, height: number): void {
    const background = this.backgroundContext;
    background.clearRect(0, 0, width, height);

    if (this.mode === 'blur') {
      // The overscan hides the transparent fringe a blur leaves at the edges.
      background.filter = `blur(${BLUR_PX}px)`;
      background.drawImage(
        this.video,
        -BLUR_OVERSCAN,
        -BLUR_OVERSCAN,
        width + BLUR_OVERSCAN * 2,
        height + BLUR_OVERSCAN * 2
      );
      background.filter = 'none';
      return;
    }

    const image = this.imageElement;
    if (!image) return;

    // Cover-fit: fill the frame without distorting the image.
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const imageWidth = image.naturalWidth * scale;
    const imageHeight = image.naturalHeight * scale;
    background.drawImage(
      image,
      (width - imageWidth) / 2,
      (height - imageHeight) / 2,
      imageWidth,
      imageHeight
    );
  }

  /**
   * Tears everything down.
   *
   * `stopCamera` is false when the caller is only swapping the effect and still
   * needs the camera — stopping it there would turn the participant's video off
   * every time they changed a setting.
   */
  stop(stopCamera = true): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.frame) clearTimeout(this.frame);
    this.frame = null;

    if (this.cameraEnded) {
      this.cameraTrack?.removeEventListener('ended', this.cameraEnded);
      this.cameraEnded = null;
    }

    this.outputTrack?.stop();
    if (stopCamera) this.cameraTrack?.stop();

    this.video.pause();
    this.video.srcObject = null;
    this.video.remove();

    this.drawing?.close?.();
    this.segmenter?.close();
    this.segmenter = null;
    this.drawing = null;
  }
}
