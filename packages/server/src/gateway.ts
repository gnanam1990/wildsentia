import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { formatWorldTime, seasonAt } from '@vana/shared';
import type { SimHost } from './simHost.js';

export interface GatewaySocket {
  send(data: string): void;
  close(): void;
}

export type ClientMessage =
  | { type: 'watch'; actorId: string }
  | { type: 'unwatch' };

interface Session {
  socket: GatewaySocket;
  watching: string | null;
}

/**
 * The only client-to-server vocabulary is `watch` and `unwatch`. Nothing a viewer can say
 * reaches world state.
 */
export class Gateway {
  readonly #sessions = new Map<GatewaySocket, Session>();
  readonly #watchers = new Map<string, Set<GatewaySocket>>();
  #wss: WebSocketServer | null = null;

  constructor(private readonly host: SimHost) {}

  handle(socket: GatewaySocket): void {
    this.#sessions.set(socket, { socket, watching: null });
    socket.send(JSON.stringify(this.#worldMessage()));
    socket.send(JSON.stringify(this.#animalsMessage()));
  }

  receive(socket: GatewaySocket, message: ClientMessage): void {
    const session = this.#sessions.get(socket);
    if (!session) return;

    if (message?.type === 'watch' && typeof message.actorId === 'string') {
      this.#unwatch(session);
      session.watching = message.actorId;
      const set = this.#watchers.get(message.actorId) ?? new Set<GatewaySocket>();
      set.add(socket);
      this.#watchers.set(message.actorId, set);
      this.#publishViewerCount(message.actorId);
      return;
    }

    if (message?.type === 'unwatch') {
      this.#unwatch(session);
      return;
    }

    socket.send(JSON.stringify({ type: 'error', message: 'unsupported message type' }));
  }

  disconnect(socket: GatewaySocket): void {
    const session = this.#sessions.get(socket);
    if (session) this.#unwatch(session);
    this.#sessions.delete(socket);
  }

  viewerCount(actorId: string): number {
    return this.#watchers.get(actorId)?.size ?? 0;
  }

  broadcast(): void {
    const world = JSON.stringify(this.#worldMessage());
    const animals = JSON.stringify(this.#animalsMessage());
    for (const { socket } of this.#sessions.values()) {
      socket.send(world);
      socket.send(animals);
    }
    for (const actorId of this.#watchers.keys()) this.#publishViewerCount(actorId);
  }

  attach(server: Server): void {
    this.#wss = new WebSocketServer({ server, path: '/live' });
    this.#wss.on('connection', (raw: WebSocket) => {
      const socket: GatewaySocket = {
        send: (data) => raw.send(data),
        close: () => raw.close(),
      };
      this.handle(socket);
      raw.on('message', (data) => {
        try {
          this.receive(socket, JSON.parse(String(data)) as ClientMessage);
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'unsupported message type' }));
        }
      });
      raw.on('close', () => this.disconnect(socket));
    });
  }

  close(): void {
    this.#wss?.close();
    this.#wss = null;
  }

  #unwatch(session: Session): void {
    if (session.watching === null) return;
    const set = this.#watchers.get(session.watching);
    set?.delete(session.socket);
    if (set && set.size === 0) this.#watchers.delete(session.watching);
    const actorId = session.watching;
    session.watching = null;
    this.#publishViewerCount(actorId);
  }

  #publishViewerCount(actorId: string): void {
    const payload = JSON.stringify({ type: 'viewers', actorId, count: this.viewerCount(actorId) });
    for (const socket of this.#watchers.get(actorId) ?? []) socket.send(payload);
  }

  #worldMessage(): Record<string, unknown> {
    const now = this.host.world.now();
    const population: Record<string, number> = {};
    for (const speciesId of this.host.world.species.keys()) {
      population[speciesId] = this.host.world.livingCount(speciesId);
    }
    return {
      type: 'world', worldTime: now, formatted: formatWorldTime(now),
      season: seasonAt(now), population,
    };
  }

  #animalsMessage(): Record<string, unknown> {
    return {
      type: 'animals',
      animals: this.host.world.agents.filter((a) => a.alive).map((a) => ({
        id: a.id, speciesId: a.speciesId, patchId: a.patchId,
        state: a.state, currentGoal: a.currentGoal, drives: a.drives,
      })),
    };
  }
}
