'use client';

import { useCallback, useEffect, useRef } from 'react';
import * as mediasoupClient from 'mediasoup-client';
import type { types as MediasoupTypes } from 'mediasoup-client';
import type { RoomSnapshot, MediaSource } from '@webinar/shared';
import { useRoomStore } from '@/store/roomStore';
import { getSocket, type AppSocket } from './socket';
import { API_URL } from './api';
import {
  registerConsumer,
  unregisterConsumer,
  clearConsumers,
  setLayerSocket,
} from './consumerRegistry';
import { BackgroundEffects, type BackgroundImage, type BackgroundMode } from './backgroundEffects';
import { AudioProcessor, audioConstraints, type AudioProcessingOptions } from './audioProcessor';
import {
  loadPrefs,
  savePrefs,
  presetDataUrl,
  loadCustomBackground,
  saveCustomBackground,
  prepareUpload,
  type MediaPrefs,
  type VideoFit,
} from './mediaPrefs';

type Device = MediasoupTypes.Device;
type Transport = MediasoupTypes.Transport;
type Producer = MediasoupTypes.Producer;
type Consumer = MediasoupTypes.Consumer;

interface UseMediasoupOptions {
  slug: string;
  token: string;
  onJoined?: (snapshot: RoomSnapshot) => void;
  onError?: (message: string) => void;
}

export function useMediasoup({ slug, token, onJoined, onError }: UseMediasoupOptions) {
  const socketRef = useRef<AppSocket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const producersRef = useRef<Map<string, Producer>>(new Map());
  const consumersRef = useRef<Map<string, Consumer>>(new Map());
  const joinedRef = useRef(false);
  /**
   * The screen-share producer and the stream it came from.
   *
   * Declared up here rather than beside `startScreenShare` because `rejoin`
   * has to be able to put the same screen back on air after a reconnect.
   */
  const screenProducerRef = useRef<Producer | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  /** Guards against two reconnects racing each other into `performJoin`. */
  const rejoiningRef = useRef(false);
  /** Set once `rejoin` exists, so the socket listener can call it without a TDZ error. */
  const rejoinRef = useRef<(() => Promise<void>) | null>(null);
  /** Set after `toggleMic` is defined so the forceMute listener can reach it. */
  const toggleMicRef = useRef<((force?: boolean) => Promise<void>) | null>(null);

  /* ── media effects ─────────────────────────────────────── */
  /**
   * The virtual-background processor, once the participant has asked for one.
   *
   * Created lazily: a participant who never touches the setting should never
   * pay for a hidden `<video>`, three canvases, or 9 MB of WASM.
   */
  const effectsRef = useRef<BackgroundEffects | null>(null);
  /** The noise-suppression graph, once the microphone has been routed through it. */
  const audioProcessorRef = useRef<AudioProcessor | null>(null);
  /** The raw camera track, kept so the effect can be removed again. */
  const rawCameraTrackRef = useRef<MediaStreamTrack | null>(null);
  /** The raw microphone track, kept so the gate can be removed again. */
  const rawMicTrackRef = useRef<MediaStreamTrack | null>(null);
  /** The participant's saved choices, loaded once on mount. */
  const prefsRef = useRef<MediaPrefs | null>(null);
  /** Guards against two mode changes racing each other. */
  const applyingRef = useRef(false);

  const store = useRoomStore;

  /* ── consume a remote producer ─────────────────────────── */
  const consumeProducer = useCallback(
    async (producerId: string) => {
      const socket = socketRef.current;
      const device = deviceRef.current;
      const recvTransport = recvTransportRef.current;
      if (!socket || !device || !recvTransport) return;
      if (consumersRef.current.has(producerId)) return;

      socket.emit(
        'consume',
        { producerId, rtpCapabilities: device.rtpCapabilities },
        async (res) => {
          if (!res.ok) {
            console.warn('[consume] failed', res.error);
            return;
          }
          const params = res.data;
          try {
            const consumer = await recvTransport.consume({
              id: params.id,
              producerId: params.producerId,
              kind: params.kind,
              rtpParameters: params.rtpParameters as MediasoupTypes.RtpParameters,
            });
            consumersRef.current.set(producerId, consumer);
            registerConsumer(producerId, consumer);

            const stream = new MediaStream([consumer.track]);
            store.getState().setRemoteStream({
              peerId: params.peerId,
              userId: params.userId,
              producerId,
              kind: params.kind,
              source: params.source ?? (params.kind === 'audio' ? 'microphone' : 'camera'),
              stream,
              paused: params.producerPaused,
            });

            consumer.on('trackended', () => {
              unregisterConsumer(producerId);
              store.getState().removeRemoteStream(producerId);
            });

            socket.emit('resumeConsumer', { consumerId: consumer.id }, () => {});
          } catch (err) {
            console.error('[consume] error', err);
          }
        }
      );
    },
    [store]
  );

  /* ── publish a local track ─────────────────────────────── */
  const publishTrack = useCallback(
    async (
      track: MediaStreamTrack,
      kind: 'audio' | 'video',
      source: MediaSource = kind === 'audio' ? 'microphone' : 'camera'
    ) => {
      const sendTransport = sendTransportRef.current;
      if (!sendTransport) return null;

      const producer = await sendTransport.produce({
        track,
        appData: { kind, source },
        /**
         * We own the track's lifetime, not mediasoup.
         *
         * `Producer.replaceTrack()` calls `destroyTrack()` on the outgoing
         * track, which stops it. That is fine for a one-way swap, but a media
         * effect swaps back and forth: the raw camera has to survive being
         * replaced by the processed canvas track, or turning the background
         * off restores a dead track and the participant's video goes black
         * with no error anywhere. Every place that really is finished with a
         * track stops it explicitly.
         */
        stopTracks: false,
        /**
         * Every video producer is single-layer.
         *
         * Camera video used to be simulcast in three layers (r0/r1/r2) so a
         * viewer on a poor connection could be served 180p while the stage got
         * 720p. That optimisation cost us the camera entirely: mediasoup only
         * encodes a simulcast layer when a consumer asks for it, and the
         * consumer's requested layer follows its bandwidth estimate. In a room
         * where a screen share is also running, the camera consumer stayed
         * pinned to a layer the producer never emitted — the tile was in the
         * DOM, the consumer reported `paused: false`, and the `<video>` had
         * `videoWidth: 0` with a muted track. Participants saw a black box
         * where the host's face should be.
         *
         * A single layer removes the whole class of bug: there is exactly one
         * encoding, so there is nothing to mis-select. The SFU still adapts
         * bitrate and resolution to each viewer's bandwidth — it just does it
         * by scaling one stream instead of switching between three.
         */
        ...(kind === 'video'
          ? { codecOptions: { videoGoogleStartBitrate: 1000 } }
          : {}),
      });
      producersRef.current.set(producer.id, producer);

      producer.on('transportclose', () => {
        producersRef.current.delete(producer.id);
      });

      return producer;
    },
    []
  );

  /* ── join handshake ────────────────────────────────────── */
  // Extracted from `join` so a reconnect can rebuild the peer, transports and
  // consumers without re-registering every socket listener.
  //
  // Resolves only once the ack has been handled and both transports exist. A
  // reconnect has to re-publish immediately afterwards, and it cannot do that
  // against a send transport that has not been created yet.
  const performJoin = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;

    await new Promise<void>((resolve) => {
      socket.emit('join', { slug, token }, async (res) => {
        try {
          if (!res.ok || !res.data) {
            store.getState().set({ joining: false, error: res.error ?? 'Could not join' });
            onError?.(res.error ?? 'Could not join');
            return;
          }

          const { peerId, role, userId, name, rtpCapabilities, snapshot } = res.data;

          store.getState().set({
            peerId,
            userId,
            name,
            role,
            webinarId: snapshot.webinarId,
            title: snapshot.title,
            joining: false,
            connected: true,
            peers: Object.fromEntries(snapshot.peers.map((p) => [p.peerId, p])),
            self: snapshot.self,
            hands: snapshot.hands,
            viewerCount: snapshot.viewerCount,
            watermark: snapshot.watermark ?? null,
            showLiveUsersCount: snapshot.settings?.showLiveUsersCount ?? true,
            showPeopleTab: snapshot.settings?.showPeopleTab ?? false,
            showQaTab: snapshot.settings?.showQaTab ?? false,
            showPollsTab: snapshot.settings?.showPollsTab ?? false,
            showParticipantsToEachOther:
              snapshot.settings?.showParticipantsToEachOther ?? false,
            activeQuiz: snapshot.activeQuiz,
            activePoll: snapshot.activePoll,
            activeCta: snapshot.activeCta,
            isApprovedSpeaker: snapshot.self.isApprovedSpeaker,
            startedAt: snapshot.startedAt,
          });

          onJoined?.(snapshot);

          /* ── build the mediasoup device ────────────────────── */
          try {
            const device = new mediasoupClient.Device();
            await device.load({
              routerRtpCapabilities: rtpCapabilities as MediasoupTypes.RtpCapabilities,
            });
            deviceRef.current = device;

            /* receive transport */
            await new Promise<void>((resolve, reject) => {
              socket.emit('createTransport', { direction: 'recv' }, async (tres) => {
                if (!tres.ok) return reject(new Error(tres.error));
                try {
                  const transport = device.createRecvTransport({
                    id: tres.data.id,
                    iceParameters: tres.data.iceParameters as MediasoupTypes.IceParameters,
                    iceCandidates: tres.data.iceCandidates as MediasoupTypes.IceCandidate[],
                    dtlsParameters: tres.data.dtlsParameters as MediasoupTypes.DtlsParameters,
                  });

                  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
                    socket.emit(
                      'connectTransport',
                      { transportId: transport.id, dtlsParameters },
                      (cres) => (cres.ok ? callback() : errback(new Error(cres.error)))
                    );
                  });

                  recvTransportRef.current = transport;
                  resolve();
                } catch (err) {
                  reject(err);
                }
              });
            });

            /* send transport */
            await new Promise<void>((resolve, reject) => {
              socket.emit('createTransport', { direction: 'send' }, async (tres) => {
                if (!tres.ok) return reject(new Error(tres.error));
                try {
                  const transport = device.createSendTransport({
                    id: tres.data.id,
                    iceParameters: tres.data.iceParameters as MediasoupTypes.IceParameters,
                    iceCandidates: tres.data.iceCandidates as MediasoupTypes.IceCandidate[],
                    dtlsParameters: tres.data.dtlsParameters as MediasoupTypes.DtlsParameters,
                  });

                  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
                    socket.emit(
                      'connectTransport',
                      { transportId: transport.id, dtlsParameters },
                      (cres) => (cres.ok ? callback() : errback(new Error(cres.error)))
                    );
                  });

                  transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
                    socket.emit(
                      'produce',
                      {
                        transportId: transport.id,
                        kind,
                        rtpParameters,
                        source: (appData as { source?: MediaSource } | undefined)?.source,
                        appData,
                      },
                      (pres) => (pres.ok ? callback({ id: pres.data.producerId }) : errback(new Error(pres.error)))
                    );
                  });

                  sendTransportRef.current = transport;
                  resolve();
                } catch (err) {
                  reject(err);
                }
              });
            });

            /* consume everything already on air */
            for (const peer of snapshot.peers) {
              for (const producer of peer.producers) {
                if (peer.peerId === peerId) continue;
                void consumeProducer(producer.producerId);
              }
            }
          } catch (err) {
            console.error('[mediasoup] device setup failed', err);
            onError?.('Media engine failed to initialise');
          }
        } finally {
          resolve();
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, token, consumeProducer, onJoined, onError, store]);

  /* ── reconnect ─────────────────────────────────────────── */
  /**
   * Puts whatever this peer had on air back on the new send transport.
   *
   * The tracks themselves survive a socket drop — they belong to the camera and
   * the screen, not to the transport — so the right recovery is to re-publish
   * the same tracks rather than asking the user to turn their camera back on.
   *
   * This is the half of the reconnect that was missing. Without it the server
   * ended up with a peer that had no producers at all while the control bar
   * still read "Stop video", so the host never re-published and every viewer
   * saw an empty tile.
   */
  const republishLocal = useCallback(async () => {
    const state = store.getState();
    const local = state.localStream;

    if (local) {
      for (const track of local.getTracks()) {
        if (track.readyState !== 'live') continue;
        if (track.kind === 'audio' && !state.micOn) continue;
        if (track.kind === 'video' && !state.camOn) continue;
        await publishTrack(track, track.kind === 'audio' ? 'audio' : 'video');
      }
    }

    const screen = screenStreamRef.current;
    if (state.screenSharing && screen) {
      const track = screen.getVideoTracks()[0];
      if (track && track.readyState === 'live') {
        const producer = await publishTrack(track, 'video', 'screen');
        if (producer) screenProducerRef.current = producer;
      } else {
        // The screen track died while we were disconnected. Claiming to still
        // be sharing would leave the host with a "Stop sharing" button that
        // does nothing, so drop the state instead.
        screenStreamRef.current = null;
        store.getState().set({ screenSharing: false, screenStream: null });
      }
    }

    // The server built a brand-new Peer for us, and a fresh Peer starts with
    // `micOn`/`camOn` false. The store subscription that normally reports this
    // only fires on a *change*, so without this the room would show the host as
    // camera-off while their video was plainly on air.
    const now = store.getState();
    socketRef.current?.emit(
      'mediaState',
      { micOn: now.micOn, camOn: now.camOn },
      () => {}
    );
  }, [publishTrack, store]);

  const rejoin = useCallback(async () => {
    // A flapping connection can fire `reconnect` several times in a row. Each
    // run rebuilds two transports, so overlapping runs leak peer connections
    // and race each other's snapshots.
    if (rejoiningRef.current) return;
    rejoiningRef.current = true;

    try {
      // The server dropped our Peer when the socket died, so every transport,
      // producer and consumer we still hold is dead. Clear them first.
      for (const consumer of consumersRef.current.values()) consumer.close();
      consumersRef.current.clear();
      clearConsumers();

      // Closing the send transport closes every producer on it, but the refs
      // that point at those producers do not clear themselves. A stale
      // `screenProducerRef` is worse than useless: `startScreenShare` returns
      // early when it is set, so the host could not re-share either.
      for (const producer of producersRef.current.values()) {
        if (!producer.closed) producer.close();
      }
      producersRef.current.clear();
      screenProducerRef.current = null;

      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
      sendTransportRef.current = null;
      recvTransportRef.current = null;
      deviceRef.current = null;

      store.getState().set({ remoteStreams: {}, peers: {} });
      await performJoin();
      await republishLocal();
    } finally {
      rejoiningRef.current = false;
    }
  }, [performJoin, republishLocal, store]);

  useEffect(() => {
    rejoinRef.current = rejoin;
  }, [rejoin]);

  /* ── join the room ─────────────────────────────────────── */
  const join = useCallback(async () => {
    if (joinedRef.current) return;
    joinedRef.current = true;

    store.getState().set({ joining: true, error: null });

    const socket = getSocket(token);
    socketRef.current = socket;
    // Tiles request simulcast layers through this socket, so the registry
    // needs a handle on it before any consumer is created.
    setLayerSocket(socket);

    /* ── wire server → client events ─────────────────────── */
    socket.on('peerJoined', (peer) => store.getState().upsertPeer(peer));
    socket.on('peerLeft', ({ peerId }) => store.getState().removePeer(peerId));
    socket.on('peerUpdated', (peer) => store.getState().upsertPeer(peer));

    socket.on('newProducer', ({ producerId }) => {
      void consumeProducer(producerId);
    });

    socket.on('producerClosed', ({ producerId }) => {
      consumersRef.current.get(producerId)?.close();
      consumersRef.current.delete(producerId);
      unregisterConsumer(producerId);
      store.getState().removeRemoteStream(producerId);
    });

    socket.on('producerPaused', ({ producerId, paused }) => {
      const rs = store.getState().remoteStreams[producerId];
      if (rs) store.getState().setRemoteStream({ ...rs, paused });
    });

    socket.on('chatMessage', (msg) => store.getState().addMessage(msg));
    socket.on('chatDeleted', ({ id }) => store.getState().removeMessage(id));
    socket.on('handList', (hands) => store.getState().set({ hands }));
    socket.on('viewerCount', (count) => store.getState().set({ viewerCount: count }));

    // The host opened the session. Everyone waiting drops straight in — the
    // socket is already connected, so there is nothing to re-join.
    socket.on('webinarStarted', ({ startedAt }) => store.getState().set({ startedAt }));

    // A purchase completed (possibly by this user in another tab) — flip the
    // badge on every message they have already sent.
    socket.on('enrolledUpdated', ({ userId, enrolled }) =>
      store.getState().setEnrolled(userId, enrolled)
    );

    socket.on('handApproved', ({ canPublishAudio, canPublishVideo }) => {
      store.getState().set({ isApprovedSpeaker: true });
      void startPublishing(canPublishAudio, canPublishVideo);
    });

    socket.on('handRevoked', () => {
      store.getState().set({ isApprovedSpeaker: false, micOn: false, camOn: false });
      void stopScreenShare();
      for (const producer of producersRef.current.values()) producer.close();
      producersRef.current.clear();
      const local = store.getState().localStream;
      local?.getTracks().forEach((t) => t.stop());
      store.getState().set({ localStream: null });
    });

    socket.on('quizStarted', (quiz) =>
      store.getState().set({ activeQuiz: quiz, quizResults: null })
    );
    socket.on('quizResults', (results) => store.getState().set({ quizResults: results }));
    socket.on('quizClosed', () => store.getState().set({ activeQuiz: null }));

    socket.on('pollStarted', (poll) =>
      store.getState().set({ activePoll: poll, pollResults: null })
    );
    socket.on('pollResults', (results) => store.getState().set({ pollResults: results }));
    socket.on('pollClosed', () => store.getState().set({ activePoll: null }));

    // The server sends the whole queue on every change, already ordered and
    // already carrying this viewer's own upvote state.
    socket.on('qaList', (questions) => store.getState().set({ questions }));

    socket.on('spotlightChanged', ({ peerId }) =>
      store.getState().set({ spotlightedPeerId: peerId })
    );

    // The host muted the room. Pausing the producer is the only thing a client
    // can do — the server cannot reach into the microphone itself.
    socket.on('forceMute', () => {
      const state = store.getState();
      if (!state.micOn) return;
      void toggleMicRef.current?.(false);
    });

    // A host is asking this peer to turn something on. Nothing is enabled
    // automatically — the prompt is the consent step, and the participant
    // decides. `mediaRequestRef` is set below once the toggles exist.
    socket.on('mediaRequested', ({ kind, by }) => {
      store.getState().set({ mediaRequest: { kind, by } });
    });

    socket.on('ctaShown', (cta) => store.getState().set({ activeCta: cta }));
    socket.on('ctaHidden', () => store.getState().set({ activeCta: null }));

    // Staff only — the offer's click tally moved. Participants never receive
    // this, so the count stays a host-side signal rather than social proof.
    socket.on('ctaClicks', ({ ctaId, clickCount }) => {
      const current = store.getState().activeCta;
      if (current && current.id === ctaId) {
        store.getState().set({ activeCta: { ...current, clickCount } });
      }
      store.getState().setCtaClickCount(ctaId, clickCount);
    });

    socket.on('recordingState', ({ recording }) => store.getState().set({ recording }));

    socket.on('webinarEnded', () => store.getState().set({ ended: true }));
    socket.on('kicked', ({ reason }) => {
      store.getState().set({ error: reason, ended: true });
      onError?.(reason);
    });
    socket.on('errorMessage', ({ message }) => onError?.(message));

    /* ── reconnect ───────────────────────────────────────── */
    // Socket.IO reconnects the transport automatically, but the server has
    // already torn down our Peer and its transports. Re-running the join
    // handshake rebuilds everything from a fresh snapshot.
    socket.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') return;
      store.getState().set({ connected: false });
    });

    socket.io.on('reconnect', () => {
      void rejoinRef.current?.();
    });

    await performJoin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [performJoin, store]);

  /* ── media effects ─────────────────────────────────────── */
  /**
   * Loads the saved preferences and pushes them into the store.
   *
   * Runs once, before the first `getUserMedia`, so the very first published
   * frame already has the participant's chosen background rather than showing
   * their room for a second and then switching.
   */
  const loadPreferences = useCallback(async () => {
    if (prefsRef.current) return prefsRef.current;

    const prefs = loadPrefs();

    // A custom upload lives in IndexedDB, not localStorage, so its object URL
    // has to be recreated on every page load.
    if (prefs.background.image?.type === 'custom') {
      const url = await loadCustomBackground();
      if (url) prefs.background.image = { type: 'custom', src: url };
      else prefs.background = { mode: 'off', image: null };
    }

    prefsRef.current = prefs;
    store.getState().set({
      backgroundMode: prefs.background.mode,
      noiseSuppression: prefs.noiseSuppression,
      videoFit: prefs.videoFit,
      mirror: prefs.mirror,
    });
    return prefs;
  }, [store]);

  /** Persists the current preferences. */
  const persist = useCallback((patch: Partial<MediaPrefs>) => {
    if (!prefsRef.current) return;
    prefsRef.current = { ...prefsRef.current, ...patch };
    savePrefs(prefsRef.current);
  }, []);

  /**
   * Swaps the published camera track for a new one.
   *
   * `replaceTrack` keeps the producer id, so every viewer keeps their consumer
   * and simply starts receiving the new frames — no renegotiation, no black
   * flash, no re-subscribe.
   */
  const swapCameraTrack = useCallback(async (track: MediaStreamTrack) => {
    const producer = [...producersRef.current.values()].find(
      (p) => p.kind === 'video' && p.appData?.source !== 'screen'
    );
    if (producer && !producer.closed) await producer.replaceTrack({ track });
  }, []);

  /**
   * Applies a virtual background to the outgoing camera.
   *
   * The failure path is the important one: if the model will not load or the
   * GPU throws, the participant keeps their raw camera and gets an explanation
   * instead of a black tile. An effect is a nicety; video is not.
   */
  const setBackground = useCallback(
    async (mode: BackgroundMode, image?: BackgroundImage | null) => {
      if (applyingRef.current) return;
      applyingRef.current = true;

      const state = store.getState();
      const prefs = prefsRef.current ?? (await loadPreferences());
      const chosen = image !== undefined ? image : prefs.background.image;

      store.getState().set({ backgroundBusy: true, backgroundError: null });

      try {
        if (mode !== 'off' && !BackgroundEffects.supported()) {
          throw new Error('This browser cannot apply virtual backgrounds.');
        }

        const local = state.localStream;
        const cameraTrack = rawCameraTrackRef.current ?? local?.getVideoTracks()[0] ?? null;

        if (mode !== 'off' && !cameraTrack) {
          throw new Error('Turn your camera on to use a background.');
        }

        if (mode === 'off') {
          // Tear the processor down and put the raw camera back.
          if (effectsRef.current) {
            effectsRef.current.stop(false);
            effectsRef.current = null;
          }
          if (cameraTrack) {
            await swapCameraTrack(cameraTrack);

            /**
             * The preview stream is still holding the processed canvas track,
             * which `stop(false)` just ended. Swapping the producer alone
             * would leave the participant looking at a frozen black tile
             * while everyone else sees them fine — the worst kind of bug,
             * because only they can see it.
             */
            const preview = store.getState().localStream;
            if (preview) {
              for (const old of preview.getVideoTracks()) {
                if (old === cameraTrack) continue;
                preview.removeTrack(old);
                old.stop();
              }
              if (!preview.getVideoTracks().includes(cameraTrack)) {
                preview.addTrack(cameraTrack);
              }
              store.getState().set({ localStream: preview });
            }
          }

          store.getState().set({ backgroundMode: 'off', backgroundBusy: false });
          persist({ background: { mode: 'off', image: chosen } });
          return;
        }

        // Resolve a preset id to a data URL the processor can draw.
        let resolved = chosen;
        if (mode === 'image') {
          if (!chosen) throw new Error('Choose a background image first.');
          if (chosen.type === 'preset') {
            const url = presetDataUrl(chosen.src);
            if (!url) throw new Error('That background is no longer available.');
            resolved = { type: 'preset', src: url };
          }
        }

        if (!effectsRef.current) {
          effectsRef.current = new BackgroundEffects((error) => {
            // The render loop fell back to the raw camera on its own; mirror
            // that in the UI so the panel does not claim a blur that stopped.
            console.warn('[effects] falling back to the raw camera', error);
            store.getState().set({
              backgroundMode: 'off',
              backgroundError: 'The background effect stopped. Your camera is still on.',
            });
            const raw = rawCameraTrackRef.current;
            if (raw) void swapCameraTrack(raw);
          });
        }

        const effects = effectsRef.current;

        // `start()` is only needed once; afterwards the canvas keeps capturing
        // and `setMode` changes what is drawn into it.
        if (!effects.videoTrack) {
          const processed = await effects.start(new MediaStream([cameraTrack!]));
          const processedTrack = processed.getVideoTracks()[0];
          if (!processedTrack) throw new Error('Could not start the background effect.');

          await effects.setMode(mode, resolved);
          await swapCameraTrack(processedTrack);

          // The local preview must show the effect too, or the participant has
          // no way to tell whether it worked.
          if (local) {
            const old = local.getVideoTracks()[0];
            if (old && old !== processedTrack) {
              local.removeTrack(old);
              // The raw camera is still needed to switch back, so it is not
              // stopped here — only detached from the preview stream.
            }
            local.addTrack(processedTrack);
            store.getState().set({ localStream: local });
          }
        } else {
          await effects.setMode(mode, resolved);
        }

        store.getState().set({ backgroundMode: mode, backgroundBusy: false });
        persist({ background: { mode, image: chosen } });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Could not apply that background.';

        // A failed switch must not leave the participant on a dead track.
        if (effectsRef.current && !effectsRef.current.videoTrack) {
          effectsRef.current.stop(false);
          effectsRef.current = null;
        }
        const raw = rawCameraTrackRef.current;
        if (raw) {
          await swapCameraTrack(raw).catch(() => {});
          // Same reasoning as the `off` branch: the preview must go back to
          // the raw camera too, or the participant is the only person who
          // cannot see themselves.
          const preview = store.getState().localStream;
          if (preview) {
            for (const old of preview.getVideoTracks()) {
              if (old === raw) continue;
              preview.removeTrack(old);
              old.stop();
            }
            if (!preview.getVideoTracks().includes(raw)) preview.addTrack(raw);
            store.getState().set({ localStream: preview });
          }
        }

        store.getState().set({
          backgroundMode: 'off',
          backgroundBusy: false,
          backgroundError: message,
        });
        persist({ background: { mode: 'off', image: chosen } });
      } finally {
        applyingRef.current = false;
      }
    },
    [loadPreferences, persist, store, swapCameraTrack]
  );

  /** Uploads a background image, stores it, and applies it. */
  const uploadBackground = useCallback(
    async (file: File): Promise<string | null> => {
      const result = await prepareUpload(file);
      if (!result.ok || !result.blob) return result.error ?? 'That image could not be used.';

      const stored = await saveCustomBackground(result.blob);
      if (!stored) return 'This browser could not store that image.';

      const url = URL.createObjectURL(result.blob);
      await setBackground('image', { type: 'custom', src: url });
      return null;
    },
    [setBackground]
  );

  /**
   * Routes the microphone through the noise-suppression gate.
   *
   * Returns the track to publish. When the worklet is unavailable the original
   * track is returned unchanged — the native constraint asked for in
   * `getUserMedia` is then the only suppression, which is still better than
   * nothing.
   */
  const applyAudioProcessing = useCallback(
    async (track: MediaStreamTrack, options: AudioProcessingOptions) => {
      audioProcessorRef.current?.stop();
      audioProcessorRef.current = null;

      if (!options.noiseSuppression) return track;

      const processor = new AudioProcessor();
      const processed = await processor.start(track, true);

      if (!processed) return track;

      audioProcessorRef.current = processor;
      return processed;
    },
    []
  );

  /** Turns the gate on or off without re-acquiring the microphone. */
  const setNoiseSuppression = useCallback(
    async (enabled: boolean) => {
      // Load first: `loadPreferences` seeds the store from storage, so calling
      // it after `persist` would overwrite the new value with the old one.
      const prefs = prefsRef.current ?? (await loadPreferences());
      persist({ noiseSuppression: enabled });
      store.getState().set({ noiseSuppression: enabled });

      const local = store.getState().localStream;
      const raw = rawMicTrackRef.current ?? local?.getAudioTracks()[0] ?? null;
      if (!raw) return;

      const producer = [...producersRef.current.values()].find(
        (p) => p.kind === 'audio' && p.appData?.source !== 'screen'
      );

      if (!enabled) {
        audioProcessorRef.current?.stop();
        audioProcessorRef.current = null;
        if (producer && !producer.closed) await producer.replaceTrack({ track: raw });
        return;
      }

      const processed = await applyAudioProcessing(raw, {
        ...prefs,
        noiseSuppression: true,
      });
      if (processed !== raw && producer && !producer.closed) {
        await producer.replaceTrack({ track: processed });
      }
    },
    [applyAudioProcessing, loadPreferences, persist, store]
  );

  /** Changes how video is fitted into its tile. Purely presentational. */
  const setVideoFit = useCallback(
    (fit: VideoFit) => {
      persist({ videoFit: fit });
      store.getState().set({ videoFit: fit });
    },
    [persist, store]
  );

  /** Mirrors the local preview. Peers always see the unmirrored frame. */
  const setMirror = useCallback(
    (mirror: boolean) => {
      persist({ mirror });
      store.getState().set({ mirror });
    },
    [persist, store]
  );

  /**
   * Toggles a native audio constraint.
   *
   * Echo cancellation and auto gain are applied by the browser at capture
   * time, so changing them means re-acquiring the microphone — there is no
   * way to retrofit them onto a live track. The new track is swapped in with
   * `replaceTrack`, which keeps the producer id and so does not renegotiate.
   */
  const setAudioConstraint = useCallback(
    async (key: 'echoCancellation' | 'autoGainControl', enabled: boolean) => {
      const prefs = prefsRef.current ?? (await loadPreferences());
      persist({ [key]: enabled });
      store.getState().set({ [key]: enabled });

      const raw = rawMicTrackRef.current;
      if (!raw) return;

      const producer = [...producersRef.current.values()].find(
        (p) => p.kind === 'audio' && p.appData?.source !== 'screen'
      );
      if (!producer || producer.closed) return;

      try {
        const next = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints({ ...prefs, [key]: enabled }),
        });
        const track = next.getAudioTracks()[0];
        if (!track) return;

        rawMicTrackRef.current = track;
        const processed = await applyAudioProcessing(track, {
          ...prefs,
          [key]: enabled,
        });
        await producer.replaceTrack({ track: processed });

        // Keep the local preview stream pointing at the live microphone.
        const local = store.getState().localStream;
        if (local) {
          for (const old of local.getAudioTracks()) {
            local.removeTrack(old);
            old.stop();
          }
          local.addTrack(processed);
        }
        raw.stop();
      } catch (err) {
        console.warn('[media] could not change audio constraint', err);
      }
    },
    [applyAudioProcessing, loadPreferences, persist, store]
  );

  const setEchoCancellation = useCallback(
    (enabled: boolean) => void setAudioConstraint('echoCancellation', enabled),
    [setAudioConstraint]
  );

  const setAutoGainControl = useCallback(
    (enabled: boolean) => void setAudioConstraint('autoGainControl', enabled),
    [setAudioConstraint]
  );

  /**
   * Changes the requested camera frame rate.
   *
   * Like the audio constraints this needs a fresh capture, so the camera is
   * re-acquired and pushed back through the background effect — otherwise
   * changing the frame rate would silently drop a virtual background.
   */
  const setFrameRate = useCallback(
    async (frameRate: number) => {
      const prefs = prefsRef.current ?? (await loadPreferences());
      persist({ frameRate });
      store.getState().set({ frameRate });

      const raw = rawCameraTrackRef.current;
      if (!raw) return;

      const producer = [...producersRef.current.values()].find(
        (p) => p.kind === 'video' && p.appData?.source !== 'screen'
      );
      if (!producer || producer.closed) return;

      try {
        const next = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: frameRate },
          },
        });
        const track = next.getVideoTracks()[0];
        if (!track) return;

        rawCameraTrackRef.current = track;
        raw.stop();

        const local = store.getState().localStream;
        if (local) {
          for (const old of local.getVideoTracks()) {
            local.removeTrack(old);
            old.stop();
          }
          local.addTrack(track);
        }

        const effects = effectsRef.current;
        if (effects?.videoTrack) {
          // Rebuild the effect around the new camera.
          effects.stop(false);
          effectsRef.current = null;
          await setBackground(prefs.background.mode, prefs.background.image);
        } else {
          await producer.replaceTrack({ track });
        }
      } catch (err) {
        console.warn('[media] could not change frame rate', err);
      }
    },
    [loadPreferences, persist, setBackground, store]
  );

  /* ── start publishing local media ──────────────────────── */
  const startPublishing = useCallback(
    async (withAudio: boolean, withVideo: boolean) => {
      try {
        const prefs = await loadPreferences();

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: withAudio ? audioConstraints(prefs) : false,
          video: withVideo
            ? {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: prefs.frameRate },
              }
            : false,
        });

        // Keep the raw tracks: switching an effect off has to be able to put
        // the original camera and microphone back.
        const rawVideo = stream.getVideoTracks()[0] ?? null;
        const rawAudio = stream.getAudioTracks()[0] ?? null;
        if (rawVideo) rawCameraTrackRef.current = rawVideo;
        if (rawAudio) rawMicTrackRef.current = rawAudio;

        store.getState().set({
          localStream: stream,
          micOn: withAudio,
          camOn: withVideo,
        });

        for (const track of stream.getTracks()) {
          if (track.kind === 'audio') {
            const processed = await applyAudioProcessing(track, prefs);
            await publishTrack(processed, 'audio');
          } else {
            await publishTrack(track, 'video');
          }
        }

        // Apply the saved background after the raw camera is on air, so a slow
        // model load delays the effect rather than the participant's video.
        if (withVideo && prefs.background.mode !== 'off') {
          await setBackground(prefs.background.mode, prefs.background.image);
        }
      } catch (err) {
        console.error('[media] getUserMedia failed', err);
        onError?.('Could not access your camera or microphone');
      }
    },
    [applyAudioProcessing, loadPreferences, publishTrack, setBackground, store, onError]
  );

  /* ── toggle helpers ────────────────────────────────────── */
  const toggleMic = useCallback(async (force?: boolean) => {
    const state = store.getState();
    const local = state.localStream;

    if (!local) {
      if (force === false) return;
      await startPublishing(true, false);
      return;
    }

    const audioTrack = local.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = force ?? !audioTrack.enabled;
      store.getState().set({ micOn: audioTrack.enabled });
      return;
    }

    if (force === false) return;

    // No audio track yet — add one.
    try {
      const prefs = prefsRef.current ?? (await loadPreferences());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(prefs),
      });
      const track = stream.getAudioTracks()[0];
      if (!track) return;

      rawMicTrackRef.current = track;
      const processed = await applyAudioProcessing(track, prefs);
      local.addTrack(processed);
      await publishTrack(processed, 'audio');
      store.getState().set({ micOn: true });
    } catch {
      onError?.('Microphone unavailable');
    }
  }, [applyAudioProcessing, loadPreferences, publishTrack, startPublishing, store, onError]);

  toggleMicRef.current = toggleMic;

  const toggleCam = useCallback(async (force?: boolean) => {
    const state = store.getState();
    const local = state.localStream;

    if (!local) {
      if (force === false) return;
      await startPublishing(false, true);
      return;
    }

    const videoTrack = local.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = force ?? !videoTrack.enabled;
      store.getState().set({ camOn: videoTrack.enabled });
      return;
    }

    if (force === false) return;

    try {
      const prefs = prefsRef.current ?? (await loadPreferences());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: prefs.frameRate },
        },
      });
      const track = stream.getVideoTracks()[0];
      if (!track) return;

      rawCameraTrackRef.current = track;
      local.addTrack(track);
      await publishTrack(track, 'video');
      store.getState().set({ camOn: true });

      // A participant who had a background on expects it back when they turn
      // the camera on again, not a bare frame.
      if (prefs.background.mode !== 'off') {
        await setBackground(prefs.background.mode, prefs.background.image);
      }
    } catch {
      onError?.('Camera unavailable');
    }
  }, [loadPreferences, publishTrack, setBackground, startPublishing, store, onError]);

  /**
   * Publish this peer's mic/camera state to the room.
   *
   * The producer list cannot answer "is this person audible?" — a muted mic
   * keeps its producer open — so the host would otherwise have no way to know
   * who needs asking. Reporting on every change keeps the participant list
   * honest without polling.
   */
  useEffect(() => {
    return useRoomStore.subscribe((state, prev) => {
      if (state.micOn === prev.micOn && state.camOn === prev.camOn) return;
      socketRef.current?.emit(
        'mediaState',
        { micOn: state.micOn, camOn: state.camOn },
        () => {}
      );
    });
  }, []);

  /* ── screen sharing ────────────────────────────────────── */
  const stopScreenShare = useCallback(async () => {
    const producer = screenProducerRef.current;
    screenProducerRef.current = null;

    if (producer && !producer.closed) {
      const socket = socketRef.current;
      // Tell the server first so it can announce the closure to the room.
      socket?.emit('closeProducer', { producerId: producer.id }, () => {});
      producer.close();
      producersRef.current.delete(producer.id);
    }

    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;

    store.getState().set({ screenSharing: false, screenStream: null });
  }, [store]);

  const startScreenShare = useCallback(async () => {
    if (screenProducerRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
    } catch {
      return; // user cancelled the picker
    }

    const track = stream.getVideoTracks()[0];
    if (!track) return;

    try {
      const producer = await publishTrack(track, 'video', 'screen');
      if (!producer) {
        stream.getTracks().forEach((t) => t.stop());
        onError?.('Screen sharing is not available yet');
        return;
      }

      screenProducerRef.current = producer;
      screenStreamRef.current = stream;
      store.getState().set({ screenSharing: true, screenStream: stream });

      // The browser's own "Stop sharing" button ends the track.
      track.onended = () => {
        void stopScreenShare();
      };
    } catch (err) {
      console.error('[screen] publish failed', err);
      stream.getTracks().forEach((t) => t.stop());
      onError?.('Could not share your screen');
    }
  }, [publishTrack, stopScreenShare, store, onError]);

  const toggleScreenShare = useCallback(async () => {
    if (screenProducerRef.current) await stopScreenShare();
    else await startScreenShare();
  }, [startScreenShare, stopScreenShare]);

  /* ── device switching ──────────────────────────────────── */
  /**
   * Swaps the live camera or microphone track without renegotiating the
   * transport: `producer.replaceTrack()` keeps the same producer id, so every
   * viewer keeps their consumer and simply starts receiving the new device.
   */
  const switchDevice = useCallback(
    async (kind: 'audio' | 'video', deviceId: string) => {
      const local = store.getState().localStream;
      if (!local) return;

      const prefs = prefsRef.current ?? (await loadPreferences());

      const existing =
        kind === 'audio' ? local.getAudioTracks()[0] : local.getVideoTracks()[0];

      try {
        const fresh = await navigator.mediaDevices.getUserMedia({
          audio:
            kind === 'audio'
              ? { deviceId: { exact: deviceId }, ...audioConstraints(prefs) }
              : false,
          video:
            kind === 'video'
              ? {
                  deviceId: { exact: deviceId },
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                  frameRate: { ideal: prefs.frameRate },
                }
              : false,
        });
        const track = kind === 'audio' ? fresh.getAudioTracks()[0] : fresh.getVideoTracks()[0];
        if (!track) return;

        // Find the producer that is currently sending this kind of camera media.
        const producer = [...producersRef.current.values()].find(
          (p) => p.kind === kind && p.appData?.source !== 'screen'
        );

        if (kind === 'audio') {
          // Producers no longer stop tracks for us, so the mic we are
          // replacing has to be released here or it stays open forever.
          rawMicTrackRef.current?.stop();
          rawMicTrackRef.current = track;
          const processed = await applyAudioProcessing(track, prefs);
          if (producer && !producer.closed) await producer.replaceTrack({ track: processed });
          else await publishTrack(processed, 'audio');

          if (existing) {
            local.removeTrack(existing);
            existing.stop();
          }
          local.addTrack(processed);
          store.getState().set({ localStream: local });
          return;
        }

        // Video: the new camera has to go through the effect too, or switching
        // cameras would silently drop the participant's background.
        rawCameraTrackRef.current?.stop();
        rawCameraTrackRef.current = track;

        if (effectsRef.current?.videoTrack) {
          // Rebuild the processor against the new camera — the old one is
          // bound to a track that is about to be stopped.
          effectsRef.current.stop(false);
          effectsRef.current = null;
          if (existing) {
            local.removeTrack(existing);
            existing.stop();
          }
          local.addTrack(track);
          store.getState().set({ localStream: local });
          await setBackground(prefs.background.mode, prefs.background.image);
          return;
        }

        if (producer && !producer.closed) await producer.replaceTrack({ track });
        else await publishTrack(track, 'video');

        if (existing) {
          local.removeTrack(existing);
          existing.stop();
        }
        local.addTrack(track);
        store.getState().set({ localStream: local });
      } catch (err) {
        console.error('[media] device switch failed', err);
        onError?.(`Could not switch ${kind === 'audio' ? 'microphone' : 'camera'}`);
      }
    },
    [applyAudioProcessing, loadPreferences, publishTrack, setBackground, store, onError]
  );

  /* ── cleanup ───────────────────────────────────────────── */
  useEffect(() => {
    return () => {
      for (const producer of producersRef.current.values()) producer.close();
      for (const consumer of consumersRef.current.values()) consumer.close();
      producersRef.current.clear();
      consumersRef.current.clear();
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      // The effect owns a hidden <video> and three canvases; leaving them
      // behind leaks a camera light that never turns off.
      effectsRef.current?.stop();
      effectsRef.current = null;
      audioProcessorRef.current?.stop();
      audioProcessorRef.current = null;
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
      store.getState().localStream?.getTracks().forEach((t) => t.stop());
      /**
       * Producers are created with `stopTracks: false`, so closing them does
       * not release the hardware. The raw camera and mic are held outside the
       * preview stream (the effect swaps them out), so they have to be stopped
       * here or the camera light stays on after leaving the room.
       */
      rawCameraTrackRef.current?.stop();
      rawCameraTrackRef.current = null;
      rawMicTrackRef.current?.stop();
      rawMicTrackRef.current = null;
      socketRef.current?.removeAllListeners();
      socketRef.current?.disconnect();
      joinedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    join,
    toggleMic,
    toggleCam,
    startScreenShare,
    stopScreenShare,
    toggleScreenShare,
    switchDevice,
    startPublishing,
    /* media effects */
    setBackground,
    uploadBackground,
    setNoiseSuppression,
    setEchoCancellation,
    setAutoGainControl,
    setFrameRate,
    setVideoFit,
    setMirror,
    socket: socketRef,
    producers: producersRef,
  };
}

export { API_URL };
