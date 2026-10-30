'use client';

/**
 * What this browser can actually do with media.
 *
 * These checks exist because the failures they prevent are silent. A missing
 * `getDisplayMedia` throws a `TypeError` that a bare `catch` reads as "the user
 * cancelled the picker", so the button appears to do nothing at all — no error,
 * no console message, no network request. That is exactly what a participant on
 * a phone sees.
 */

/** True when the page is served over HTTPS or from localhost. */
export function isSecureContext(): boolean {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext === true;
}

/**
 * Whether this browser can capture a screen.
 *
 * `getDisplayMedia` is a desktop-only API. It is absent on Android Chrome and
 * on every iOS browser (all of which are WebKit under the hood), so a phone can
 * *watch* a screen share but cannot start one. There is no polyfill — the
 * platform genuinely does not expose the capability.
 *
 * It also requires a secure context: over plain `http://` the whole
 * `navigator.mediaDevices` object is undefined, which breaks camera and
 * microphone too, not just screen sharing.
 */
export function canShareScreen(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!isSecureContext()) return false;
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/** Whether this browser can capture camera and microphone. */
export function canUseCamera(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!isSecureContext()) return false;
  return typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * A human-readable reason screen sharing is unavailable, or `null` if it works.
 *
 * Returned as a sentence the UI can show verbatim — the point is that the user
 * learns *why*, rather than pressing a button that does nothing.
 */
export function screenShareUnavailableReason(): string | null {
  if (typeof navigator === 'undefined') return 'Screen sharing is not available.';
  if (!isSecureContext()) {
    return 'Screen sharing needs a secure connection (https). Open the webinar over https and try again.';
  }
  if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    return 'Screen sharing is not supported on mobile browsers. Join from a desktop to present.';
  }
  return null;
}
