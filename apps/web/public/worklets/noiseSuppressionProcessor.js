/**
 * Noise suppression as an AudioWorklet.
 *
 * A spectral gate: the signal is cut into overlapping frames, transformed to
 * the frequency domain, and each bin is attenuated according to how far it sits
 * above a running estimate of the noise floor. Steady sounds — fans, hum, air
 * conditioning, keyboard clatter — sit *at* the floor and get pulled down;
 * speech rises well above it and passes through.
 *
 * This is deliberately not RNNoise. RNNoise is a trained neural network and
 * needs a ~90 KB WASM binary fetched at runtime, which is a hard dependency on
 * a CDN that a locked-down deployment may not reach. A gate is weaker on
 * non-stationary noise but it is a few hundred lines, has no download, and
 * never fails to initialise.
 *
 * The worklet runs on the audio thread, so it must not allocate per block.
 * Every buffer below is created once in the constructor.
 *
 * NOTE: this file is served verbatim to the browser as an ES module. It must
 * stay plain JavaScript — no TypeScript annotations, no imports.
 */

const FFT_SIZE = 512;
const HOP_SIZE = FFT_SIZE / 2;
const BINS = FFT_SIZE / 2;

/**
 * How fast the noise floor follows the signal.
 *
 * Too fast and it tracks speech, which then gets gated away. Too slow and it
 * misses a fan that starts mid-call. 0.95 is roughly a 1.5 s window at 48 kHz.
 */
const FLOOR_SMOOTHING = 0.95;

/** Bins this far above the floor are treated as signal and left alone. */
const GATE_THRESHOLD = 2.5;

/** Never attenuate more than this, or the result sounds like a broken radio. */
const MIN_GAIN = 0.12;

/** Smoothing on the gain itself, to avoid "musical noise" from a jittery gate. */
const GAIN_SMOOTHING = 0.6;

class NoiseSuppressionProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /** Hann window, precomputed. */
    this.window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
    }

    /** Twiddle factors for the radix-2 FFT. */
    this.cosTable = new Float32Array(BINS);
    this.sinTable = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) {
      const angle = (-2 * Math.PI * i) / FFT_SIZE;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    this.bitReverse = new Uint16Array(FFT_SIZE);
    const bits = Math.log2(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      let reversed = 0;
      for (let b = 0; b < bits; b++) reversed |= ((i >> b) & 1) << (bits - 1 - b);
      this.bitReverse[i] = reversed;
    }

    /** Overlap-add accumulator. */
    this.overlap = new Float32Array(FFT_SIZE);
    /** Input history, so a frame can span two process() calls. */
    this.history = new Float32Array(FFT_SIZE);

    /** Running noise-floor estimate, per bin. */
    this.noiseFloor = new Float32Array(BINS);
    /** Previous frame's gain, per bin, for smoothing. */
    this.previousGain = new Float32Array(BINS).fill(1);

    /** Scratch buffers — reused, never reallocated. */
    this.real = new Float32Array(FFT_SIZE);
    this.imag = new Float32Array(FFT_SIZE);

    /** How many samples are currently buffered in `history`. */
    this.buffered = 0;

    this.enabled = true;

    // The main thread can toggle the gate without rebuilding the graph.
    this.port.onmessage = (event) => {
      if (typeof event.data?.enabled === 'boolean') this.enabled = event.data.enabled;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    // No output buffer yet (the graph is still warming up) — keep the node alive.
    if (!output) return true;

    if (!input || !this.enabled) {
      if (input) output.set(input);
      else output.fill(0);
      return true;
    }

    // Shift the history left by one block and append the new samples.
    this.history.copyWithin(0, output.length);
    this.history.set(input.subarray(0, FFT_SIZE - output.length), FFT_SIZE - output.length);

    this.buffered += output.length;

    // Only run the transform once a full hop has accumulated.
    if (this.buffered >= HOP_SIZE) {
      this.buffered -= HOP_SIZE;
      this.processFrame();
    }

    // Emit the overlap-add tail for this block.
    output.set(this.overlap.subarray(0, output.length));
    this.overlap.copyWithin(0, output.length);
    this.overlap.fill(0, FFT_SIZE - output.length);

    return true;
  }

  /** One analysis → gate → synthesis pass over the newest frame. */
  processFrame() {
    const { real, imag, window, history } = this;

    // Window the newest FFT_SIZE samples into the transform buffers.
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = history[i] * window[i];
      imag[i] = 0;
    }

    this.fft(real, imag);

    for (let bin = 0; bin < BINS; bin++) {
      const re = real[bin];
      const im = imag[bin];
      const magnitude = Math.sqrt(re * re + im * im);

      // Track the floor: rise quickly, fall slowly. A bin that is quiet now
      // pulls the estimate down; a bin that is loud barely moves it.
      const floor = this.noiseFloor[bin];
      this.noiseFloor[bin] =
        magnitude < floor
          ? magnitude
          : FLOOR_SMOOTHING * floor + (1 - FLOOR_SMOOTHING) * magnitude;

      // Gain is 1 well above the floor, and approaches MIN_GAIN at it.
      const ratio = magnitude / (this.noiseFloor[bin] + 1e-9);
      const target = ratio > GATE_THRESHOLD ? 1 : Math.max(MIN_GAIN, ratio / GATE_THRESHOLD);

      // Smooth across frames so the gate opens and closes gradually.
      const gain = GAIN_SMOOTHING * this.previousGain[bin] + (1 - GAIN_SMOOTHING) * target;
      this.previousGain[bin] = gain;

      real[bin] *= gain;
      imag[bin] *= gain;

      // Mirror into the negative frequencies to keep the spectrum conjugate-
      // symmetric, which is what makes the inverse transform real-valued.
      if (bin > 0) {
        real[FFT_SIZE - bin] *= gain;
        imag[FFT_SIZE - bin] *= gain;
      }
    }

    this.ifft(real, imag);

    // Overlap-add with the window applied a second time (synthesis window).
    for (let i = 0; i < FFT_SIZE; i++) {
      this.overlap[i] += real[i] * window[i];
    }
  }

  /** In-place iterative radix-2 FFT. */
  fft(real, imag) {
    const n = FFT_SIZE;

    for (let i = 0; i < n; i++) {
      const j = this.bitReverse[i];
      if (j > i) {
        let tmp = real[i];
        real[i] = real[j];
        real[j] = tmp;
        tmp = imag[i];
        imag[i] = imag[j];
        imag[j] = tmp;
      }
    }

    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const cos = this.cosTable[k];
          const sin = this.sinTable[k];
          const tre = real[j + half] * cos - imag[j + half] * sin;
          const tim = real[j + half] * sin + imag[j + half] * cos;
          real[j + half] = real[j] - tre;
          imag[j + half] = imag[j] - tim;
          real[j] += tre;
          imag[j] += tim;
        }
      }
    }
  }

  /** Inverse transform, via conjugation and scaling. */
  ifft(real, imag) {
    for (let i = 0; i < FFT_SIZE; i++) imag[i] = -imag[i];
    this.fft(real, imag);
    const scale = 1 / FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] *= scale;
      imag[i] = -imag[i] * scale;
    }
  }
}

registerProcessor('noise-suppression', NoiseSuppressionProcessor);
