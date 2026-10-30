'use client';

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@webinar/shared';
import { SOCKET_URL } from './api';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

export function getSocket(token: string): AppSocket {
  if (socket?.connected) return socket;

  socket?.disconnect();
  socket = io(SOCKET_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 8,
    reconnectionDelay: 800,
    timeout: 15_000,
  }) as AppSocket;

  return socket;
}

export function closeSocket() {
  socket?.disconnect();
  socket = null;
}

export function currentSocket() {
  return socket;
}
