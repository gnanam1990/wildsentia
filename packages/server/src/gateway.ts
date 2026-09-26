import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { formatWorldTime, seasonAt } from '@vana/shared';
import type { CheckpointObservation, SimHost } from './simHost.js';
import { floweringGuildSummary } from './floweringObservation.js';

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
  recordedFrameId: string | null;
  recordingDirty: boolean;
  checkpointId: string;
  lastHeartbeatAt: number;
}

/**
 * The only client-to-server vocabulary is `watch` and `unwatch`. Nothing a viewer can say
 * reaches world state.
 */
export class Gateway {
  readonly #sessions = new Map<GatewaySocket, Session>();
  readonly #watchers = new Map<string, Set<GatewaySocket>>();
  #wss: WebSocketServer | null = null;
  #cachedScene: { id: string; base: string; environment: string } | null = null;

  constructor(private readonly host: SimHost) {}

  handle(socket: GatewaySocket): void {
    const view = this.host.observation();
    if (!view) { socket.close(); return; }
    const frame = this.host.liveEncounterFrame();
    this.#sessions.set(socket, { socket, watching: null, recordedFrameId: frame?.id ?? null,
      recordingDirty: false, checkpointId: view.id, lastHeartbeatAt: Date.now() });
    const scene = this.#scene(view);
    socket.send(`${scene.base},"environment":${scene.environment},"frame":${JSON.stringify(frame)}}`);
  }

  receive(socket: GatewaySocket, message: ClientMessage): void {
    const session = this.#sessions.get(socket);
    if (!session) return;

    if (message?.type === 'watch' && typeof message.actorId === 'string') {
      if (session.watching === message.actorId) return;
      this.#unwatch(session);
      session.watching = message.actorId;
      // Coalesce selection changes until the next normal broadcast; never send large geometry
      // immediately for every incoming watch message. This does not advance simulation time.
      session.recordingDirty = true;
      const set = this.#watchers.get(message.actorId) ?? new Set<GatewaySocket>();
      set.add(socket);
      this.#watchers.set(message.actorId, set);
      this.#publishViewerCount(message.actorId);
      return;
    }

    if (message?.type === 'unwatch') {
      if (session.watching !== null) session.recordingDirty = true;
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

  /** Sends one already-serialised message to every connected viewer (the live layer's state). */
  broadcastRaw(payload: string): void {
    for (const { socket } of this.#sessions.values()) socket.send(payload);
  }

  broadcast(): void {
    const view = this.host.observation();
    if (!view) {
      for (const { socket } of this.#sessions.values()) socket.close();
      this.#sessions.clear(); this.#watchers.clear();
      return;
    }
    const scene = this.#scene(view);
    const frame = this.host.liveEncounterFrame();
    const frameId = frame?.id ?? null;
    const recordings = new Map<string | null, { payload: string; id: string | null }>();
    for (const session of this.#sessions.values()) {
      const { socket } = session;
      const changed = session.checkpointId !== view.id || session.recordingDirty || session.recordedFrameId !== frameId;
      if (!changed) {
        // A world hour takes five real minutes. Repeating the unchanged ~1 MB scene every
        // second wastes tens of GB per viewer/day without advancing the client playhead.
        if (Date.now() - session.lastHeartbeatAt >= 30_000) {
          socket.send(JSON.stringify({ type: 'heartbeat', checkpointId: view.id }));
          session.lastHeartbeatAt = Date.now();
        }
        continue;
      }
      let payload = scene.base;
      if (session.checkpointId !== view.id) payload += `,"environment":${scene.environment}`;
      // Immutable checkpoint geometry can exceed 1 MB. Existing viewers already have its
      // rate/playhead: do not serialize or transmit it again on every status heartbeat.
      if (session.checkpointId !== view.id || session.recordingDirty || session.recordedFrameId !== frameId) {
        let recording = recordings.get(session.watching);
        if (!recording) {
          const selected = session.watching === null ? frame : this.host.liveEncounterFrame(session.watching);
          // Most followed actors already fit the shared selection. Reuse its serialization;
          // retain at most eight custom selections, not one megabyte per distinct viewer.
          const shared = selected?.id === frame?.id && selected?.movements === frame?.movements;
          recording = shared ? recordings.get(null) : undefined;
          if (!recording) {
            const timed = selected && frame && selected.id === frame.id
              ? { ...selected, elapsedWorldSeconds: frame.elapsedWorldSeconds } : selected;
            recording = { payload: JSON.stringify(timed), id: timed?.id ?? null };
            if (shared) recordings.set(null, recording);
            else if (recordings.size < 8) recordings.set(session.watching, recording);
          }
        }
        payload += `,"frame":${recording.payload}`;
        session.recordedFrameId = recording.id;
        session.recordingDirty = false;
      }
      socket.send(`${payload}}`);
      session.checkpointId = view.id;
      session.lastHeartbeatAt = Date.now();
    }
    for (const actorId of this.#watchers.keys()) this.#publishViewerCount(actorId);
  }

  attach(server: Server): void {
    // Large checkpoint JSON is sparse and compresses well; small keepalives stay below
    // threshold. Bound zlib concurrency so a viewer surge cannot fork unlimited compressors.
    this.#wss = new WebSocketServer({ server, path: '/live', maxPayload: 1024, perMessageDeflate: {
      threshold: 64 * 1024, concurrencyLimit: 4, clientNoContextTakeover: true,
      serverNoContextTakeover: true,
    } });
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

  #worldMessage(view: CheckpointObservation): Record<string, unknown> {
    const now = view.worldTime;
    return {
      type: 'world', worldTime: now, formatted: formatWorldTime(now),
      season: seasonAt(now), population: view.summary().population,
      source: 'checkpoint', nextEventSequence: view.nextSequence,
      worldHoursPerRealHour: this.host.worldHoursPerRealHour,
    };
  }

  /** Serialize immutable common state once per checkpoint, not once per heartbeat or viewer. */
  #scene(view: CheckpointObservation): { id: string; base: string; environment: string } {
    if (this.#cachedScene?.id === view.id) return this.#cachedScene;
    const base = JSON.stringify({ type: 'scene', protocol: 1, checkpointId: view.id,
      world: this.#worldMessage(view), animals: this.#animalsMessage(view).animals }).slice(0, -1);
    const environment = JSON.stringify({
      patches: view.patches().map((p) => ({ id: p.id, x: p.x, y: p.y, habitat: p.habitat,
        elevation: p.elevation, canopyCover: p.canopyCover, islandSeed: p.islandSeed, surface: p.surface, grass: p.plant.grass,
        browse: p.plant.browse, floweringGuild: floweringGuildSummary(p),
        water: p.waterVolume, drainage: p.drainage })),
      microEcology: view.microEcology(),
      community: view.community(),
      carcasses: view.carcasses().map((c) => ({ id: c.originId, speciesId: c.speciesId,
        patchId: c.patchId, position: c.position, state: 'dead', currentGoal: '',
        decayStage: c.decayStage,
        sizeRatio: c.originalMassKg / (this.host.world.species.get(c.speciesId)?.body.adultMassKg ?? c.originalMassKg),
        drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } })),
    });
    return this.#cachedScene = { id: view.id, base, environment };
  }

  #animalsMessage(view: CheckpointObservation): Record<string, unknown> {
    return {
      type: 'animals',
      worldTime: view.worldTime, source: 'checkpoint', nextEventSequence: view.nextSequence,
      animals: view.livingAnimals().map((a) => ({
        id: a.id, speciesId: a.speciesId, patchId: a.patchId,
        position: a.position,
        state: a.state, currentGoal: a.currentGoal, drives: a.drives,
        ...(a.illness?.phase === 'active' ? { illnessStatus: 'symptomatic' } : {}),
        ...(a.wound ? { woundStatus: a.wound.phase } : {}),
        ...(a.altitudeM === undefined ? {} : { altitudeM: a.altitudeM, locomotionMode: a.locomotionMode ?? 'flight' }),
        lifeStage: a.lifeStage, sex: a.sex, coatVariant: a.traits.coatVariant,
        sizeRatio: a.massKg / (this.host.world.species.get(a.speciesId)?.body.adultMassKg ?? a.massKg),
        dependentOn: a.dependentOn, groupId: a.groupId ?? null,
        // What the thought bubble reads; see thoughtFor in @vana/shared.
        alternativeGoal: a.alternativeGoal, goalScore: a.goalScore, dependent: a.dependentOn !== null,
      })),
    };
  }
}
