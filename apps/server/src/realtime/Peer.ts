import type {
  Consumer,
  Producer,
  Router,
  RtpCapabilities,
  RtpParameters,
  WebRtcTransport,
} from 'mediasoup/types';
import type { Role, MediaSource, CohostPermissions } from '@webinar/shared';
import { webRtcTransportOptions } from '../config/mediasoup.js';
import { canConsume, canPublish, type VisibilitySubject, type VisibilityPolicy } from './visibility.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('peer');

export interface PeerInit {
  peerId: string;
  userId: string;
  name: string;
  role: Role;
  socketId: string;
  /**
   * Resolved co-host permissions. `null` means "not a co-host" — an owner, an
   * admin or a plain moderator, all of whom are governed by their role rather
   * than by a permission map.
   */
  permissions?: CohostPermissions | null;
}

/**
 * One Peer per connected socket. Owns its transports, producers and consumers.
 */
export class Peer implements VisibilitySubject {
  readonly peerId: string;
  readonly userId: string;
  readonly socketId: string;
  name: string;
  role: Role;

  isApprovedSpeaker = false;
  handRaisedAt: number | null = null;

  /**
   * Co-host permissions, or `null` when this peer is not a co-host.
   *
   * A co-host is a HOST-role peer whose powers come from a per-webinar map
   * rather than from the role alone. Keeping it separate from `role` means the
   * existing `isStaff` checks keep working — a co-host is staff, they just may
   * not be allowed to do every staff thing.
   */
  permissions: CohostPermissions | null = null;

  /**
   * Whether this peer's mic and camera are live right now.
   *
   * Reported by the client rather than derived from the producer list: a muted
   * mic keeps its producer open, so "has an audio producer" and "is audible"
   * are different questions. The host needs the second one.
   */
  micOn = false;
  camOn = false;

  sendTransport: WebRtcTransport | null = null;
  recvTransport: WebRtcTransport | null = null;

  readonly producers = new Map<string, Producer>();
  readonly consumers = new Map<string, Consumer>();

  /** producerId → where that producer's media comes from. */
  readonly producerSources = new Map<string, MediaSource>();

  constructor(init: PeerInit) {
    this.peerId = init.peerId;
    this.userId = init.userId;
    this.name = init.name;
    this.role = init.role;
    this.socketId = init.socketId;
    this.permissions = init.permissions ?? null;
  }

  get isStaff(): boolean {
    return this.role === 'ADMIN' || this.role === 'HOST' || this.role === 'MODERATOR';
  }

  /**
   * Whether this peer may perform a named staff action.
   *
   * A peer with no permission map is governed by role alone, so every staff
   * action is allowed. A co-host is checked against their map, and a permission
   * they were not granted is a refusal — not a silent no-op.
   */
  can(permission: keyof CohostPermissions): boolean {
    if (!this.isStaff) return false;
    if (!this.permissions) return true;
    return this.permissions[permission] === true;
  }

  async createTransport(router: Router, direction: 'send' | 'recv'): Promise<WebRtcTransport> {
    const transport = await router.createWebRtcTransport(webRtcTransportOptions);

    transport.on('dtlsstatechange', (state: string) => {
      if (state === 'closed') {
        log.debug(`transport closed for ${this.name}`);
        transport.close();
      }
    });

    if (direction === 'send') this.sendTransport = transport;
    else this.recvTransport = transport;

    return transport;
  }

  async produce(
    transportId: string,
    kind: 'audio' | 'video',
    rtpParameters: RtpParameters,
    appData: Record<string, unknown>,
    settings: { allowMic: boolean; allowVideo: boolean },
    source: MediaSource = kind === 'audio' ? 'microphone' : 'camera'
  ): Promise<Producer> {
    if (!this.sendTransport || this.sendTransport.id !== transportId) {
      throw new Error('Send transport not found');
    }

    // Server-side publish authorisation — never trust the client.
    if (!canPublish(this, settings, kind)) {
      throw new Error(
        kind === 'audio'
          ? 'You are not allowed to publish audio right now'
          : 'You are not allowed to publish video right now'
      );
    }

    const producer = await this.sendTransport.produce({
      kind,
      rtpParameters,
      appData: { ...appData, peerId: this.peerId, userId: this.userId, source },
    });

    this.producers.set(producer.id, producer);
    this.producerSources.set(producer.id, source);

    producer.on('transportclose', () => {
      this.producers.delete(producer.id);
      this.producerSources.delete(producer.id);
    });

    return producer;
  }

  /** The source tag for a producer, defaulting sensibly for older clients. */
  sourceOf(producerId: string, kind: 'audio' | 'video'): MediaSource {
    return this.producerSources.get(producerId) ?? (kind === 'audio' ? 'microphone' : 'camera');
  }

  async consume(
    router: Router,
    producer: Producer,
    owner: Peer,
    rtpCapabilities: RtpCapabilities,
    policy: VisibilityPolicy
  ): Promise<Consumer> {
    if (!this.recvTransport) throw new Error('Receive transport not found');

    const kind = producer.kind as 'audio' | 'video';
    const source = owner.sourceOf(producer.id, kind);

    // ── THE POLICY CHECK ──────────────────────────────────────
    if (
      !canConsume(
        this,
        {
          role: owner.role,
          isApprovedSpeaker: owner.isApprovedSpeaker,
          kind,
          source,
        },
        policy
      )
    ) {
      throw new Error('Not allowed to consume this producer');
    }

    if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      throw new Error('Cannot consume — incompatible RTP capabilities');
    }

    const consumer = await this.recvTransport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true, // resumed explicitly by the client after it wires up the track
      appData: { peerId: owner.peerId, userId: owner.userId, kind, source },
    });

    this.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => this.consumers.delete(consumer.id));
    consumer.on('producerclose', () => this.consumers.delete(consumer.id));

    return consumer;
  }

  /**
   * Closes every consumer that delivers media from `ownerPeerId`.
   *
   * Returns the **producer** ids, not the consumer ids. The client keys its
   * consumer map and its remote-stream map by producer id, so a
   * `producerClosed` broadcast carrying a consumer id matches nothing and the
   * departed peer's tile stays on screen forever.
   */
  closeConsumersFrom(ownerPeerId: string): string[] {
    const closed: string[] = [];
    for (const [id, consumer] of this.consumers) {
      if (consumer.appData?.peerId === ownerPeerId) {
        closed.push(consumer.producerId);
        consumer.close();
        this.consumers.delete(id);
      }
    }
    return closed;
  }

  closeAllProducers(): string[] {
    const ids: string[] = [];
    for (const [id, producer] of this.producers) {
      producer.close();
      this.producers.delete(id);
      this.producerSources.delete(id);
      ids.push(id);
    }
    return ids;
  }

  close(): void {
    for (const consumer of this.consumers.values()) consumer.close();
    for (const producer of this.producers.values()) producer.close();
    this.consumers.clear();
    this.producers.clear();
    this.producerSources.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
  }

  toInfo() {
    return {
      peerId: this.peerId,
      userId: this.userId,
      name: this.name,
      role: this.role,
      isApprovedSpeaker: this.isApprovedSpeaker,
      producers: [...this.producers.values()].map((p) => ({
        producerId: p.id,
        kind: p.kind as 'audio' | 'video',
        source: this.sourceOf(p.id, p.kind as 'audio' | 'video'),
      })),
      micOn: this.micOn,
      camOn: this.camOn,
    };
  }
}
