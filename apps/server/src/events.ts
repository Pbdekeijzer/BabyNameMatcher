import type { ServerResponse } from 'node:http';

export class RoomEventBroker {
  private readonly listeners = new Map<string, Set<ServerResponse>>();

  subscribe(roomId: string, response: ServerResponse, revision: number): () => void {
    const roomListeners = this.listeners.get(roomId) ?? new Set<ServerResponse>();
    roomListeners.add(response);
    this.listeners.set(roomId, roomListeners);
    response.write(`event: revision\ndata: ${revision}\n\n`);

    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': keep-alive\n\n');
    }, 25_000);

    return () => {
      clearInterval(heartbeat);
      roomListeners.delete(response);
      if (roomListeners.size === 0) this.listeners.delete(roomId);
    };
  }

  publish(roomId: string, revision: number): void {
    for (const response of this.listeners.get(roomId) ?? []) {
      if (!response.destroyed) response.write(`event: revision\ndata: ${revision}\n\n`);
    }
  }

  close(): void {
    for (const responses of this.listeners.values()) {
      for (const response of responses) response.end();
    }
    this.listeners.clear();
  }
}
