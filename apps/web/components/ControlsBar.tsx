'use client';

import { useEffect, useRef, useState } from 'react';
import { useRoomStore } from '@/store/roomStore';
import { useFullscreen, useMediaDevices } from '@/lib/useRoomUi';
import type { AppSocket } from '@/lib/socket';
import type { BackgroundImage, BackgroundMode } from '@/lib/backgroundEffects';
import type { VideoFit } from '@/lib/mediaPrefs';
import { MediaSettingsPanel } from './MediaSettingsPanel';

interface ControlsBarProps {
  socket: React.MutableRefObject<AppSocket | null>;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onShareScreen: () => void;
  onLeave: () => void;
  canPublish: boolean;
  handRaised: boolean;
  /** Swaps the live camera/mic track without renegotiating. */
  onSwitchDevice?: (kind: 'audio' | 'video', deviceId: string) => void;
  /** Element that should go fullscreen — the stage, not the whole page. */
  stageRef?: React.RefObject<HTMLElement | null>;
  /* media effects */
  onSetBackground?: (mode: BackgroundMode, image?: BackgroundImage | null) => void;
  onUploadBackground?: (file: File) => Promise<string | null>;
  onSetNoiseSuppression?: (enabled: boolean) => void;
  onSetEchoCancellation?: (enabled: boolean) => void;
  onSetAutoGainControl?: (enabled: boolean) => void;
  onSetFrameRate?: (fps: number) => void;
  onSetVideoFit?: (fit: VideoFit) => void;
  onSetMirror?: (mirror: boolean) => void;
}

function IconButton({
  active,
  danger,
  label,
  onClick,
  disabled,
  children,
}: {
  active?: boolean;
  danger?: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`group relative grid h-11 w-11 place-items-center rounded-full border transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? 'border-red-500/40 bg-red-500/90 text-white hover:bg-red-500'
          : active
            ? 'border-white/20 bg-white/15 text-white hover:bg-white/25'
            : 'border-white/10 bg-white/[0.06] text-slate-400 hover:bg-white/[0.12] hover:text-white'
      }`}
    >
      {children}
      <span className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink-800 px-2 py-1 text-[10px] font-medium text-slate-200 opacity-0 shadow-lg ring-1 ring-white/10 transition group-hover:opacity-100">
        {label}
      </span>
    </button>
  );
}

export function ControlsBar({
  socket,
  onToggleMic,
  onToggleCam,
  onShareScreen,
  onLeave,
  canPublish,
  handRaised,
  onSwitchDevice,
  stageRef,
  onSetBackground,
  onUploadBackground,
  onSetNoiseSuppression,
  onSetEchoCancellation,
  onSetAutoGainControl,
  onSetFrameRate,
  onSetVideoFit,
  onSetMirror,
}: ControlsBarProps) {
  const micOn = useRoomStore((s) => s.micOn);
  const camOn = useRoomStore((s) => s.camOn);
  const screenSharing = useRoomStore((s) => s.screenSharing);
  const isApprovedSpeaker = useRoomStore((s) => s.isApprovedSpeaker);
  const role = useRoomStore((s) => s.role);
  const hands = useRoomStore((s) => s.hands);
  const backgroundMode = useRoomStore((s) => s.backgroundMode);

  const isStaff = role === 'HOST' || role === 'ADMIN' || role === 'MODERATOR';
  const canUseMedia = isStaff || isApprovedSpeaker;
  const canConfigureMedia =
    canUseMedia &&
    Boolean(
      onSetBackground &&
        onUploadBackground &&
        onSetNoiseSuppression &&
        onSetEchoCancellation &&
        onSetAutoGainControl &&
        onSetFrameRate &&
        onSetVideoFit &&
        onSetMirror
    );

  const fallbackRef = useRef<HTMLElement | null>(null);
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(
    stageRef ?? fallbackRef
  );
  const { cameras, microphones, refresh } = useMediaDevices();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Close the device popover on outside click or Escape.
  useEffect(() => {
    if (!settingsOpen) return;
    function onDown(e: MouseEvent) {
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSettingsOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

  function openSettings() {
    // Labels are blank until permission has been granted once, so re-read the
    // device list every time the popover opens.
    void refresh();
    setSettingsOpen((v) => !v);
  }

  function toggleHand() {
    if (!socket.current) return;
    if (handRaised) socket.current.emit('handLower', () => {});
    else socket.current.emit('handRaise', () => {});
  }

  return (
    <div className="relative flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-ink-850/80 px-3 py-2.5 backdrop-blur-xl">
      <IconButton
        label={micOn ? 'Mute' : 'Unmute'}
        active={micOn}
        onClick={onToggleMic}
        disabled={!canUseMedia}
      >
        {micOn ? (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 4l16 16" strokeLinecap="round" />
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 10.2 5.3M12 17.5V21" strokeLinecap="round" />
          </svg>
        )}
      </IconButton>

      <IconButton
        label={camOn ? 'Stop video' : 'Start video'}
        active={camOn}
        onClick={onToggleCam}
        disabled={!canUseMedia}
      >
        {camOn ? (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="6" width="12" height="12" rx="2.5" />
            <path d="m15 10.5 4.5-2.5v8L15 13.5" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 4l16 16" strokeLinecap="round" />
            <rect x="3" y="6" width="12" height="12" rx="2.5" />
            <path d="m15 10.5 4.5-2.5v8L15 13.5" strokeLinejoin="round" />
          </svg>
        )}
      </IconButton>

      {canUseMedia && (
        <IconButton
          label={screenSharing ? 'Stop sharing' : 'Share screen'}
          active={screenSharing}
          onClick={onShareScreen}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="4.5" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16.5V20" strokeLinecap="round" />
          </svg>
        </IconButton>
      )}

      {!isStaff && (
        <IconButton
          label={handRaised ? 'Lower hand' : 'Raise hand'}
          active={handRaised}
          onClick={toggleHand}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path
              d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11m0 0V4.5a1.5 1.5 0 0 1 3 0V11m0 0V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2.5a1.5 1.5 0 0 1 3 0V13"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </IconButton>
      )}

      {isStaff && hands.length > 0 && (
        <span className="ml-1 rounded-full bg-accent-500/20 px-2.5 py-1 text-[11px] font-semibold text-accent-400">
          {hands.length} hand{hands.length > 1 ? 's' : ''} up
        </span>
      )}

      <div className="mx-1 h-6 w-px bg-white/10" />

      <IconButton
        label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        active={isFullscreen}
        onClick={() => void toggleFullscreen()}
      >
        {isFullscreen ? (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </IconButton>

      {canUseMedia && onSwitchDevice && (
        <div className="relative" ref={settingsRef}>
          <IconButton
            label="Devices"
            active={settingsOpen}
            onClick={openSettings}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.5l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconButton>

          {settingsOpen && (
            <div className="absolute bottom-14 right-0 z-30 w-64 rounded-xl border border-white/10 bg-ink-850/95 p-3 shadow-2xl backdrop-blur-xl">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Microphone
              </p>
              <div className="mb-3 space-y-1">
                {microphones.length === 0 && (
                  <p className="text-[11px] text-slate-500">No microphone found</p>
                )}
                {microphones.map((d) => (
                  <button
                    key={d.deviceId}
                    onClick={() => {
                      onSwitchDevice('audio', d.deviceId);
                      setSettingsOpen(false);
                    }}
                    className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-[11px] text-slate-300 transition hover:bg-white/10 hover:text-white"
                  >
                    {d.label}
                  </button>
                ))}
              </div>

              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Camera
              </p>
              <div className="space-y-1">
                {cameras.length === 0 && (
                  <p className="text-[11px] text-slate-500">No camera found</p>
                )}
                {cameras.map((d) => (
                  <button
                    key={d.deviceId}
                    onClick={() => {
                      onSwitchDevice('video', d.deviceId);
                      setSettingsOpen(false);
                    }}
                    className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-[11px] text-slate-300 transition hover:bg-white/10 hover:text-white"
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {canConfigureMedia && (
        <IconButton
          label="Media settings"
          active={mediaOpen || backgroundMode !== 'off'}
          onClick={() => setMediaOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconButton>
      )}

      <IconButton label="Leave" danger onClick={onLeave}>
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.9">
          <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" strokeLinecap="round" />
          <path d="M10 8l-4 4 4 4M6 12h9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </IconButton>

      {mediaOpen && canConfigureMedia && (
        <MediaSettingsPanel
          onClose={() => setMediaOpen(false)}
          onSetBackground={onSetBackground!}
          onUploadBackground={onUploadBackground!}
          onSetNoiseSuppression={onSetNoiseSuppression!}
          onSetEchoCancellation={onSetEchoCancellation!}
          onSetAutoGainControl={onSetAutoGainControl!}
          onSetFrameRate={onSetFrameRate!}
          onSetVideoFit={onSetVideoFit!}
          onSetMirror={onSetMirror!}
        />
      )}
    </div>
  );
}
