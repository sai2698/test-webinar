'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Fullscreen for the room stage.
 *
 * Uses the standard Fullscreen API with the `webkit` fallback that Safari
 * still needs. The element is passed in rather than looked up by id so the
 * caller controls exactly what goes fullscreen (the stage, not the chat).
 */
export function useFullscreen(target: React.RefObject<HTMLElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    function onChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(async () => {
    const el = target.current;
    if (!el) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      // Some browsers refuse fullscreen without a direct user gesture, and
      // iOS Safari does not support it on arbitrary elements at all.
    }
  }, [target]);

  return { isFullscreen, toggle };
}

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

/**
 * Enumerates cameras and microphones.
 *
 * Labels are empty until the user has granted permission at least once, so
 * callers should re-run this after `getUserMedia` succeeds.
 */
export function useMediaDevices() {
  const [cameras, setCameras] = useState<MediaDeviceOption[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceOption[]>([]);

  const refresh = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(
        devices
          .filter((d) => d.kind === 'videoinput')
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }))
      );
      setMicrophones(
        devices
          .filter((d) => d.kind === 'audioinput')
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
      );
    } catch {
      /* enumerateDevices can throw in insecure contexts */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refresh);
    return () => md?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);

  return { cameras, microphones, refresh };
}

/**
 * Reports whether the referenced element is on screen.
 *
 * Used to keep off-screen tiles from mounting a `<video>` at all. A tile that
 * never mounts never asks the SFU for a layer, so a 200-person grid only
 * downloads the handful of streams the viewer can actually see.
 *
 * `rootMargin` pre-loads a little ahead of the scroll so tiles are already
 * playing by the time they slide into view.
 */
export function useInView(
  target: React.RefObject<HTMLElement | null>,
  rootMargin = '200px'
) {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = target.current;
    if (!el) return;

    // Without IntersectionObserver (very old browsers, some test harnesses)
    // fall back to rendering everything rather than rendering nothing.
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }

    let reported = false;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          reported = true;
          setInView(entry.isIntersecting);
        }
      },
      { rootMargin }
    );

    observer.observe(el);

    /**
     * Fail open.
     *
     * The observer's first callback is asynchronous and, in a page that is
     * never actually painted (a background tab, a headless harness, a
     * prerender), it may never arrive at all. A tile that waits forever for a
     * verdict renders a permanent placeholder — the viewer sees an empty box
     * and concludes the call is broken. Showing a video that turns out to be
     * off-screen costs a little bandwidth; showing nothing costs the meeting.
     *
     * Only applies if the observer has stayed silent: a real "off screen"
     * verdict must still be honoured, or the whole point of the hook is lost.
     */
    const failOpen = setTimeout(() => {
      if (!reported) setInView(true);
    }, 1500);

    return () => {
      clearTimeout(failOpen);
      observer.disconnect();
    };
  }, [target, rootMargin]);

  return inView;
}
