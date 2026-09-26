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
  | { type: 'unwatch' }
  /** Where the viewer's camera looks, so live agents are sent only for that part of the island. */
  | { type: 'view'; x: number; z: number; radius: number };

/** What the live layer publishes each quarter second (see live/liveLayer.ts publicState). */
export interface LiveBroadcast {
  avatars: Array<{ agentId: string; name: string; animalId: string; speciesId: string; x: number; z: number } & Record<string, unknown>>;
  drops: object[];
  /** Wild animals in a live chase, off their recordings. */
  wild?: Array<{ animalId: string; x: number; z: number } & Record<string, unknown>>;
}
/** Largest view a viewer may ask for: past this the island is dots, not animals. */
export const MAX_VIEW_RADIUS_M = 1500;

interface Session {
  socket: GatewaySocket;
  watching: string | null;
  recordedFrameId: string | null;
  recordingDirty: boolean;
  checkpointId: string;
  lastHeartbeatAt: number;
  view: { x: number; z: number; radius: number } | null;
  liveEmpty: boolean;
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
      recordingDirty: false, checkpointId: view.id, lastHeartbeatAt: Date.now(), view: null, liveEmpty: true });
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

    if (message?.type === 'view') {
      const { x, z, radius } = message;
      if (![x, z, radius].every((v) => typeof v === 'number' && Number.isFinite(v)) || radius <= 0) return;
      session.view = { x, z, radius: Math.min(radius, MAX_VIEW_RADIUS_M) };
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

  /**
   * The live layer's state, a quarter second's worth, per viewer: agents near where that
   * viewer's camera looks and the one it follows, and every drop. A viewer that has not said
   * where it looks gets none; the roster (below) still tells it who is playing.
   */
  broadcastLive(state: LiveBroadcast, at: number): void {
    for (const session of this.#sessions.values()) {
      const view = session.view;
      const avatars = state.avatars.filter((a) => a.animalId === session.watching
        || (view !== null && Math.hypot(a.x - view.x, a.z - view.z) <= view.radius));
      const wild = (state.wild ?? []).filter((w) => w.animalId === session.watching
        || (view !== null && Math.hypot(w.x - view.x, w.z - view.z) <= view.radius));
      const empty = avatars.length === 0 && state.drops.length === 0 && wild.length === 0;
      if (empty && session.liveEmpty) continue;
      session.liveEmpty = empty;
      session.socket.send(JSON.stringify({ type: 'live', at, avatars, drops: state.drops, wild }));
    }
  }

  /** Who is playing, everywhere, in brief: for the agents list, every couple of seconds. */
  broadcastRoster(state: LiveBroadcast): void {
    const payload = JSON.stringify({ type: 'live-roster', agents: state.avatars.map((a) => ({ agentId: a.agentId, name: a.name,
      animalId: a.animalId, speciesId: a.speciesId, x: Math.round(a.x), z: Math.round(a.z),
      activity: a.action === 'hunt' || a.action === 'feed' ? a.action : (a.altitude as number) >= 20 ? 'fly' : a.moving ? `${a.gait}` : a.action })) });
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
