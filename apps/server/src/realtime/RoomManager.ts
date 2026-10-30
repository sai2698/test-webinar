import type { Server } from 'socket.io';
import { Room, type RoomContext } from './Room.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('rooms');

/**
 * Registry of live Rooms keyed by webinar id. A Room is created lazily when
 * the first peer joins and destroyed when the last peer leaves.
 */
class RoomManager {
  private rooms = new Map<string, Room>();
  private io: Server | null = null;

  setIo(io: Server) {
    this.io = io;
  }

  async getOrCreate(ctx: RoomContext): Promise<Room> {
    const existing = this.rooms.get(ctx.webinarId);
    if (existing) {
      // Keep settings fresh — an admin may have edited them mid-session.
      existing.settings = ctx.settings;
      existing.title = ctx.title;
      existing.status = ctx.status;
      existing.hostId = ctx.hostId;
      existing.moderatorIds = ctx.moderatorIds;
      // The row may have been reset (or started) since this Room was built.
      existing.syncStartedAt(ctx.startedAt, ctx.status);
      return existing;
    }

    if (!this.io) throw new Error('RoomManager not initialised');

    const room = new Room(this.io, ctx);
    await room.init();
    this.rooms.set(ctx.webinarId, room);
    log.info(`Room created: ${ctx.slug}`);
    return room;
  }

  get(webinarId: string): Room | undefined {
    return this.rooms.get(webinarId);
  }

  getBySlug(slug: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.slug === slug) return room;
    }
    return undefined;
  }

  async destroy(webinarId: string): Promise<void> {
    const room = this.rooms.get(webinarId);
    if (!room) return;
    await room.destroy();
    this.rooms.delete(webinarId);
  }

  async destroyIfEmpty(webinarId: string): Promise<void> {
    const room = this.rooms.get(webinarId);
    if (room && room.peers.size === 0) {
      await this.destroy(webinarId);
    }
  }

  get all(): Room[] {
    return [...this.rooms.values()];
  }
}

export const roomManager = new RoomManager();
