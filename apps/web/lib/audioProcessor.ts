'use client';

/**
 * Noise suppression for the outgoing microphone.
 *
 * Two paths, in order of preference:
 *
 * 1. **An AudioWorklet spectral gate** (`public/worklets/noiseSuppressionProcessor.js`).
 *    Works everywhere `AudioWorklet` does, needs no download, and is stronger
 *    than the browser's built-in suppressor on steady noise.
 * 2. **The native `noiseSuppression` constraint.** Used when the worklet cannot
 *    be loaded — an insecure context, an old browser, or a CSP that blocks
 *    `blob:` workers.
 *
 * The worklet path is asynchronous and the camera/mic may be toggled while it
 * is still loading, so every await is followed by a check that the processor
 * has not been superseded. Without that, a fast toggle leaves an orphaned
 * `AudioContext` running and the microphone silently dead.
 */

export interface AudioProcessingOptions {
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

/** The native constraints to ask `getUserMedia` for. */
export function audioConstraints(options: AudioProcessingOptions): MediaTrackConstraints {
  return {
    echoCancellation: options.echoCancellation,
    autoGainControl: options.autoGainControl,
    // The native suppressor is only requested when the worklet is unavailable;
    // running both would double-process and make speech sound thin.
    noiseSuppression: options.noiseSuppression && !workletSupported(),
  };
}

/** Whether the spectral-gate worklet can be used in this browser. */
export function workletSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    window.isSecureContext
  );
}

export class AudioProcessor {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private outputTrack: MediaStreamTrack | null = null;
  private stopped = false;

  /**
   * Routes a microphone track through the gate.
   *
   * Returns the processed track, or `null` when the worklet is unavailable —
   * the caller then keeps the original track and relies on the native
   * constraint it already asked for.
   */
  async start(track: MediaStreamTrack, enabled: boolean): Promise<MediaStreamTrack | null> {
    if (!workletSupported()) return null;

    const context = new AudioContext();
    this.context = context;

    try {
      await context.audioWorklet.addModule('/worklets/noiseSuppressionProcessor.js');

      // `stop()` or a second `start()` may have run while the module loaded.
      if (this.stopped || this.context !== context) {
        await context.close();
        return null;
      }

      const source = context.createMediaStreamSource(new MediaStream([track]));
      const node = new AudioWorkletNode(context, 'noise-suppression', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const destination = context.createMediaStreamDestination();

      source.connect(node);
      node.connect(destination);

      node.port.postMessage({ enabled });

      this.source = source;
      this.node = node;
      this.destination = destination;
      this.outputTrack = destination.stream.getAudioTracks()[0] ?? null;

      // A suspended context produces silence. Autoplay policy can leave it
      // suspended even though the user has already granted microphone access.
      if (context.state === 'suspended') await context.resume();

      return this.outputTrack;
    } catch (error) {
      console.warn('[audio] noise suppression unavailable, using native constraints', error);
      await context.close().catch(() => {});
      if (this.context === context) this.context = null;
      return null;
    }
  }

  /** Turns the gate on or off without rebuilding the audio graph. */
  setEnabled(enabled: boolean): void {
    this.node?.port.postMessage({ enabled });
  }

  /** Releases the graph. The source track is left alone — the caller owns it. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    try {
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {
      /* already disconnected */
    }

    this.outputTrack?.stop();
    void this.context?.close().catch(() => {});

    this.context = null;
    this.source = null;
    this.node = null;
    this.destination = null;
    this.outputTrack = null;
  }
}
