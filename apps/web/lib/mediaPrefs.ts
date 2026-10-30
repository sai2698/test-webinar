'use client';

/**
 * Media preferences: what the participant chose, remembered across sessions.
 *
 * Two stores, because the two kinds of value are different sizes:
 *
 * - **`localStorage`** holds the small JSON blob — mode, toggles, fit, mirror.
 * - **IndexedDB** holds an uploaded background image. A 4 MB photo becomes a
 *   ~5.5 MB base64 string, which on its own exceeds the whole `localStorage`
 *   quota, so blobs cannot go there.
 *
 * Every read is defensive. A preference is a convenience, and a corrupt or
 * half-written entry must never stop someone joining a webinar.
 */

import type { BackgroundImage, BackgroundMode } from './backgroundEffects';

const STORAGE_KEY = 'media_prefs';
const DB_NAME = 'nexalive-media';
const DB_VERSION = 1;
const STORE = 'backgrounds';
const CUSTOM_KEY = 'custom';

export type VideoFit = 'fill' | 'contain' | 'cover' | 'scale-down' | 'none';

export interface MediaPrefs {
  background: { mode: BackgroundMode; image: BackgroundImage | null };
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  videoFit: VideoFit;
  mirror: boolean;
  frameRate: number;
}

export const DEFAULT_PREFS: MediaPrefs = {
  background: { mode: 'off', image: null },
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  videoFit: 'cover',
  mirror: true,
  frameRate: 30,
};

/**
 * Bundled backgrounds.
 *
 * These are CSS gradients rendered to a canvas on demand rather than image
 * files, so they cost nothing to ship and cannot 404. A participant who wants
 * a photo can upload one.
 */
export const BACKGROUND_PRESETS: { id: string; label: string; gradient: string[] }[] = [
  { id: 'aurora', label: 'Aurora', gradient: ['#0f172a', '#1e3a8a', '#0ea5e9'] },
  { id: 'ember', label: 'Ember', gradient: ['#1c1917', '#7c2d12', '#f59e0b'] },
  { id: 'forest', label: 'Forest', gradient: ['#052e16', '#166534', '#4ade80'] },
  { id: 'dusk', label: 'Dusk', gradient: ['#1e1b4b', '#6d28d9', '#f472b6'] },
  { id: 'slate', label: 'Slate', gradient: ['#0f172a', '#334155', '#94a3b8'] },
  { id: 'ocean', label: 'Ocean', gradient: ['#082f49', '#0369a1', '#22d3ee'] },
];

/** The CSS for a preset, for both the swatch and the canvas fill. */
export function presetGradient(id: string): string | null {
  const preset = BACKGROUND_PRESETS.find((p) => p.id === id);
  if (!preset) return null;
  return `linear-gradient(135deg, ${preset.gradient.join(', ')})`;
}

/**
 * Renders a preset to a data URL.
 *
 * The effect pipeline needs an `<img>` it can `drawImage`, and a CSS gradient
 * is not one. Painting it to a canvas once and caching the result keeps the
 * render loop free of gradient work.
 */
const presetCache = new Map<string, string>();

export function presetDataUrl(id: string): string | null {
  const cached = presetCache.get(id);
  if (cached) return cached;

  const preset = BACKGROUND_PRESETS.find((p) => p.id === id);
  if (!preset || typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  preset.gradient.forEach((color, i) => {
    gradient.addColorStop(i / (preset.gradient.length - 1), color);
  });
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const url = canvas.toDataURL('image/jpeg', 0.9);
  presetCache.set(id, url);
  return url;
}

/* ── localStorage ─────────────────────────────────────────── */

export function loadPrefs(): MediaPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;

    const parsed = JSON.parse(raw) as Partial<MediaPrefs>;

    // Merge field by field rather than trusting the shape: a preference saved
    // by an older build will be missing keys, and a hand-edited one may hold
    // values this build does not understand.
    return {
      background: {
        mode: isMode(parsed.background?.mode) ? parsed.background.mode : 'off',
        image: isImage(parsed.background?.image) ? parsed.background.image : null,
      },
      noiseSuppression: bool(parsed.noiseSuppression, DEFAULT_PREFS.noiseSuppression),
      echoCancellation: bool(parsed.echoCancellation, DEFAULT_PREFS.echoCancellation),
      autoGainControl: bool(parsed.autoGainControl, DEFAULT_PREFS.autoGainControl),
      videoFit: isFit(parsed.videoFit) ? parsed.videoFit : DEFAULT_PREFS.videoFit,
      mirror: bool(parsed.mirror, DEFAULT_PREFS.mirror),
      frameRate: isFrameRate(parsed.frameRate) ? parsed.frameRate : DEFAULT_PREFS.frameRate,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: MediaPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota exceeded or storage disabled — the choice still applies this
    // session, it just will not be remembered.
  }
}

/* ── IndexedDB ────────────────────────────────────────────── */

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);

  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Stores an uploaded background. Returns false if storage is unavailable. */
export async function saveCustomBackground(blob: Blob): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, CUSTOM_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve(true);
    };
    tx.onerror = () => {
      db.close();
      resolve(false);
    };
  });
}

/** Reads the uploaded background back, as an object URL. */
export async function loadCustomBackground(): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(CUSTOM_KEY);
    request.onsuccess = () => {
      db.close();
      const blob = request.result as Blob | undefined;
      resolve(blob ? URL.createObjectURL(blob) : null);
    };
    request.onerror = () => {
      db.close();
      resolve(null);
    };
  });
}

export async function clearCustomBackground(): Promise<void> {
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(CUSTOM_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

/* ── upload validation ────────────────────────────────────── */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** Uploads are downscaled to this before storage, to keep IndexedDB small. */
const MAX_UPLOAD_SIDE = 1280;

export interface UploadResult {
  ok: boolean;
  blob?: Blob;
  error?: string;
}

/**
 * Validates and downscales an uploaded background.
 *
 * The type check is on the declared MIME type *and* on whether the browser can
 * actually decode it — a `.png` that is really a text file passes the first
 * test and fails the second, and the participant should be told which.
 */
export async function prepareUpload(file: File): Promise<UploadResult> {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return { ok: false, error: 'Choose a PNG, JPEG, or WebP image.' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: 'That image is larger than 10 MB.' };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, error: 'That file could not be read as an image.' };
  }

  const scale = Math.min(1, MAX_UPLOAD_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return { ok: false, error: 'This browser cannot process images.' };
  }

  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/webp', 0.85)
  );

  if (!blob) return { ok: false, error: 'That image could not be encoded.' };
  return { ok: true, blob };
}

/* ── guards ───────────────────────────────────────────────── */

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isMode(value: unknown): value is BackgroundMode {
  return value === 'off' || value === 'blur' || value === 'image';
}

function isFit(value: unknown): value is VideoFit {
  return (
    value === 'fill' ||
    value === 'contain' ||
    value === 'cover' ||
    value === 'scale-down' ||
    value === 'none'
  );
}

function isFrameRate(value: unknown): value is number {
  return value === 15 || value === 24 || value === 30;
}

function isImage(value: unknown): value is BackgroundImage {
  if (!value || typeof value !== 'object') return false;
  const image = value as Partial<BackgroundImage>;
  return (image.type === 'preset' || image.type === 'custom') && typeof image.src === 'string';
}
