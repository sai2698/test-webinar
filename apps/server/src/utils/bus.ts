/**
 * Process-wide event bus.
 *
 * Lets REST modules (payments) notify the realtime layer (rooms) without a
 * circular import. When you scale to multiple server instances, replace this
 * with Redis pub/sub — the emit/subscribe surface stays the same.
 */
import { EventEmitter } from 'node:events';

export interface AppEvents {
  'enrollment:created': { webinarId: string | null; userId: string; courseTitle: string };
  'registration:paid': { webinarId: string; userId: string };
  'webinar:ended': { webinarId: string };
}

class TypedEmitter extends EventEmitter {
  emitEvent<K extends keyof AppEvents>(event: K, payload: AppEvents[K]) {
    this.emit(event, payload);
  }

  onEvent<K extends keyof AppEvents>(event: K, listener: (payload: AppEvents[K]) => void) {
    this.on(event, listener as (...args: unknown[]) => void);
  }
}

export const bus = new TypedEmitter();
bus.setMaxListeners(50);
