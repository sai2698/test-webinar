'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomStore } from '@/store/roomStore';
import { BACKGROUND_PRESETS, presetGradient, type VideoFit } from '@/lib/mediaPrefs';
import type { BackgroundImage, BackgroundMode } from '@/lib/backgroundEffects';

interface MediaSettingsPanelProps {
  onClose: () => void;
  /** `image` selects a specific preset or upload; omit it to keep the current one. */
  onSetBackground: (mode: BackgroundMode, image?: BackgroundImage | null) => void;
  onUploadBackground: (file: File) => Promise<string | null>;
  onSetNoiseSuppression: (enabled: boolean) => void;
  onSetEchoCancellation: (enabled: boolean) => void;
  onSetAutoGainControl: (enabled: boolean) => void;
  onSetFrameRate: (fps: number) => void;
  onSetVideoFit: (fit: VideoFit) => void;
  onSetMirror: (mirror: boolean) => void;
}

const FIT_OPTIONS: { value: VideoFit; label: string }[] = [
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
  { value: 'fill', label: 'Fill' },
  { value: 'scale-down', label: 'Scale down' },
  { value: 'none', label: 'None' },
];

/** 15 fps is the honest floor for a talking head; 60 is rarely worth the CPU. */
const FRAME_RATES = [15, 24, 30, 60];

/**
 * The media settings sheet.
 *
 * Rendered as a portal-free fixed panel anchored to the control bar. It is
 * deliberately a single scrollable column rather than tabs: there are only
 * three groups, and a participant looking for "blur my background" should not
 * have to guess which tab it lives under.
 */
export function MediaSettingsPanel({
  onClose,
  onSetBackground,
  onUploadBackground,
  onSetNoiseSuppression,
  onSetEchoCancellation,
  onSetAutoGainControl,
  onSetFrameRate,
  onSetVideoFit,
  onSetMirror,
}: MediaSettingsPanelProps) {
  const backgroundMode = useRoomStore((s) => s.backgroundMode);
  const backgroundBusy = useRoomStore((s) => s.backgroundBusy);
  const backgroundError = useRoomStore((s) => s.backgroundError);
  const noiseSuppression = useRoomStore((s) => s.noiseSuppression);
  const echoCancellation = useRoomStore((s) => s.echoCancellation);
  const autoGainControl = useRoomStore((s) => s.autoGainControl);
  const frameRate = useRoomStore((s) => s.frameRate);
  const videoFit = useRoomStore((s) => s.videoFit);
  const mirror = useRoomStore((s) => s.mirror);
  const camOn = useRoomStore((s) => s.camOn);

  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  /**
   * The image the user last chose, kept locally so re-selecting "Image" after
   * switching to Blur does not force them through the picker again.
   */
  const [selectedImage, setSelectedImage] = useState<BackgroundImage | null>(null);
  /** True while the user is choosing an image but none is applied yet. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape, matching the device popover.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setUploadError(null);
      setUploading(true);
      try {
        const error = await onUploadBackground(file);
        if (error) {
          setUploadError(error);
        } else {
          // The hook applied it, so the picker has done its job.
          setPickerOpen(false);
        }
      } finally {
        setUploading(false);
        // Reset so choosing the same file twice still fires a change event.
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [onUploadBackground]
  );

  const error = uploadError ?? backgroundError;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Media settings"
      className="absolute bottom-16 left-1/2 z-40 w-[min(92vw,26rem)] -translate-x-1/2 rounded-2xl border border-white/10 bg-ink-850/95 p-4 shadow-2xl backdrop-blur-xl"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">
          Media settings
        </h2>
        <button
          onClick={onClose}
          aria-label="Close media settings"
          className="grid h-6 w-6 place-items-center rounded-md text-slate-500 transition hover:bg-white/10 hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {/* ── background ─────────────────────────────── */}
        <section>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Virtual background
          </p>

          {!camOn && (
            <p className="mb-2 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[10px] text-slate-400">
              Turn your camera on to use a background.
            </p>
          )}

          <div className="grid grid-cols-3 gap-1.5">
            {(['off', 'blur', 'image'] as BackgroundMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  // Choosing "Image" cannot apply anything on its own — there
                  // is no image yet. Open the picker instead of calling
                  // through, or the user hits "Choose a background image
                  // first" with no way to choose one.
                  if (mode === 'image' && !selectedImage) {
                    setPickerOpen(true);
                    return;
                  }
                  setPickerOpen(false);
                  onSetBackground(mode, mode === 'image' ? selectedImage : undefined);
                }}
                disabled={backgroundBusy || (!camOn && mode !== 'off')}
                aria-pressed={backgroundMode === mode}
                className={`rounded-lg border px-2 py-2 text-[11px] font-medium capitalize transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  backgroundMode === mode
                    ? 'border-brand-400/60 bg-brand-500/20 text-white'
                    : 'border-white/10 bg-white/[0.04] text-slate-400 hover:bg-white/[0.09] hover:text-white'
                }`}
              >
                {mode === 'off' ? 'Off' : mode === 'blur' ? 'Blur' : 'Image'}
              </button>
            ))}
          </div>

          {backgroundBusy && (
            <p className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-400">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border border-white/20 border-t-brand-400" />
              Applying…
            </p>
          )}

          {/* The picker shows while Image is active, and also as soon as the
              user asks for Image but has not picked one yet. */}
          {(backgroundMode === 'image' || pickerOpen) && (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void handleFile(e.dataTransfer.files[0]);
                }}
                className={`mt-2 grid grid-cols-4 gap-1.5 rounded-lg p-1 transition ${
                  dragging ? 'bg-brand-500/10 ring-2 ring-brand-400/50' : ''
                }`}
              >
                {BACKGROUND_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => {
                      const image: BackgroundImage = { type: 'preset', src: preset.id };
                      setSelectedImage(image);
                      setPickerOpen(false);
                      onSetBackground('image', image);
                    }}
                    title={preset.label}
                    aria-label={preset.label}
                    className="aspect-video rounded-md border border-white/10 transition hover:border-white/30"
                    style={{ background: presetGradient(preset.id) ?? undefined }}
                  />
                ))}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-slate-300 transition hover:bg-white/[0.09] hover:text-white disabled:opacity-50"
                >
                  {uploading ? 'Uploading…' : 'Upload image'}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => void handleFile(e.target.files?.[0])}
                />
              </div>
              <p className="mt-1 text-[10px] text-slate-500">
                PNG, JPEG, or WebP up to 10 MB. Processed in your browser — never uploaded.
              </p>
            </>
          )}

          {error && (
            <p
              role="alert"
              className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300"
            >
              {error}
            </p>
          )}
        </section>

        <div className="h-px bg-white/10" />

        {/* ── audio ──────────────────────────────────── */}
        <section>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Audio
          </p>
          <Toggle
            label="Noise cancellation"
            hint="Filters fans, hum, and keyboard noise"
            checked={noiseSuppression}
            onChange={onSetNoiseSuppression}
          />
          <Toggle
            label="Echo cancellation"
            hint="Stops your speakers feeding back into your mic"
            checked={echoCancellation}
            onChange={onSetEchoCancellation}
          />
          <Toggle
            label="Auto gain control"
            hint="Keeps your level steady as you move"
            checked={autoGainControl}
            onChange={onSetAutoGainControl}
          />
        </section>

        <div className="h-px bg-white/10" />

        {/* ── video ──────────────────────────────────── */}
        <section>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Video
          </p>

          <label className="mb-1 block text-[11px] text-slate-400" htmlFor="video-fit">
            Fit
          </label>
          <select
            id="video-fit"
            value={videoFit}
            onChange={(e) => onSetVideoFit(e.target.value as VideoFit)}
            className="mb-2 w-full rounded-lg border border-white/10 bg-ink-900 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-brand-400/60"
          >
            {FIT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <Toggle
            label="Mirror my video"
            hint="Only affects your own preview"
            checked={mirror}
            onChange={onSetMirror}
          />

          <label className="mb-1 mt-2 block text-[11px] text-slate-400" htmlFor="video-fps">
            Frame rate
          </label>
          <select
            id="video-fps"
            value={frameRate}
            onChange={(e) => onSetFrameRate(Number(e.target.value))}
            className="w-full rounded-lg border border-white/10 bg-ink-900 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-brand-400/60"
          >
            {FRAME_RATES.map((fps) => (
              <option key={fps} value={fps}>
                {fps} fps
              </option>
            ))}
          </select>
        </section>
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1.5 text-left transition hover:bg-white/[0.04]"
    >
      <span className="min-w-0">
        <span className="block text-[11px] text-slate-200">{label}</span>
        {hint && <span className="block text-[10px] text-slate-500">{hint}</span>}
      </span>
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full transition ${
          checked ? 'bg-brand-500' : 'bg-white/15'
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            checked ? 'left-3.5' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  );
}
