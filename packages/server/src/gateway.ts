import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { formatWorldTime, patchAtPosition, regionIds, regionOfPatch, seasonAt, worldExtentM, type Agent, type Carcass, type Patch } from '@vana/shared';
import type { CheckpointObservation, SimHost } from './simHost.js';
import { floweringGuildSummary } from './floweringObservation.js';
import { ConnectionCaps, GENERAL_LIMIT_DEFAULTS } from './limits.js';
import { forwardedClient, networkKey } from './network.js';
import { WindowMax } from './metrics.js';

export interface GatewaySocket {
  /** A string or an encoded Buffer, always sent as a text message. */
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued for this viewer and not yet taken by it (ws's bufferedAmount). */
  readonly bufferedAmount?: number;
  /** Drops the connection at once, discarding whatever is still queued. */
  terminate?(): void;
}

/**
 * A viewer this far behind on reading is cut off rather than queued for without limit: a
 * client that never reads would otherwise hold every scene and live update in server memory.
 * A whole scene is about a megabyte, so a slow but working connection stays well below it.
 */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/**
 * WebSocket close code 1013, "Try Again Later": the server is full or has no saved world to show.
 * The observer waits longer, with jitter, after this code than after an ordinary drop.
 */
export const LIVE_BUSY_CLOSE_CODE = 1013;

export interface GatewayOptions {
  /** Concurrent /live connections in total; 0 is no cap. */
  maxConnections?: number;
  /** Concurrent /live connections from one visitor network; 0 is no cap. */
  maxPerNetwork?: number;
  /** Proxies whose X-Forwarded-For entry is trusted, as for the HTTP API (VANA_TRUSTED_PROXY_HOPS). */
  trustedProxyHops?: number;
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
/** Congo 1A.3: a region is sent once a viewer's view comes within this of it. */
const REGION_MARGIN_M = 300;
/** Distinct region sets serialized per checkpoint; beyond this a set is built per viewer. */
const MAX_REGION_SCENES = 64;
/** A viewer is sent a new region set at most this often, however often its view moves. */
export const REGION_SWITCH_MIN_MS = 10_000;

interface Session {
  socket: GatewaySocket;
  watching: string | null;
  recordedFrameId: string | null;
  recordingDirty: boolean;
  checkpointId: string;
  lastHeartbeatAt: number;
  view: { x: number; z: number; radius: number } | null;
  liveEmpty: boolean;
  /** Congo 1A.3: on a world of many regions, those this viewer was last sent, and whether its view has moved off them. */
  regions: string[] | null;
  /** The regions its view now reaches; they become `regions` when they are next sent. */
  wantedRegions: string[] | null;
  regionsDirty: boolean;
  lastRegionSceneAt: number;
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
  #regionScenes: { checkpointId: string; scenes: Map<string, { base: string; environment: string }> } = { checkpointId: '', scenes: new Map() };
  /** A world of more than one region (Congo) is served a region at a time; the island is one region. */
  get #regional(): boolean { return regionIds(this.host.grid).length > 1; }
  readonly #caps: ConnectionCaps;
  readonly #hops: number;

  constructor(private readonly host: SimHost, options: GatewayOptions = {}) {
    this.#caps = new ConnectionCaps(options.maxConnections ?? GENERAL_LIMIT_DEFAULTS.liveMaxConnections,
      options.maxPerNetwork ?? GENERAL_LIMIT_DEFAULTS.liveMaxPerNetwork);
    this.#hops = options.trustedProxyHops ?? 0;
  }

  /** Counted since start, for /metrics (metrics.ts). */
  readonly stats = {
    accepted: 0, refused: { busy: 0, busy_network: 0, world_unavailable: 0 }, messages: 0, bytes: 0, slowConsumerTerminations: 0,
    /** Sockets ws closed for a bad frame (too large, malformed): each only cut that viewer off. */
    badFrames: 0,
    broadcastSeconds: { scene: new WindowMax(), live: new WindowMax(), roster: new WindowMax() },
  };

  /** Open /live connections that were admitted under the caps. */
  get connectionCount(): number { return this.#caps.total; }

  handle(socket: GatewaySocket): void {
    const view = this.host.observation();
    if (!view) { this.stats.refused.world_unavailable++; socket.close(LIVE_BUSY_CLOSE_CODE, 'world_unavailable'); return; }
    const regions = this.#regional ? this.#regionsFor(null) : null;
    const frame = this.host.liveEncounterFrame(null, regions ? new Set(regions) : undefined);
    this.#sessions.set(socket, { socket, watching: null, recordedFrameId: frame?.id ?? null,
      recordingDirty: false, checkpointId: view.id, lastHeartbeatAt: Date.now(), view: null, liveEmpty: true,
      regions, wantedRegions: regions, regionsDirty: false, lastRegionSceneAt: 0 });
    const scene = regions ? this.#regionScene(view, regions) : this.#scene(view);
    this.#send(socket, `${scene.base},"environment":${scene.environment},"frame":${JSON.stringify(frame)}}`);
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
      // Only the new watcher hears the count now; the others get it with the next broadcast,
      // so switching back and forth cannot make the server write to every watcher each time.
      this.#send(socket, JSON.stringify({ type: 'viewers', actorId: message.actorId, count: set.size }));
      return;
    }

    if (message?.type === 'view') {
      const { x, z, radius } = message;
      if (![x, z, radius].every((v) => typeof v === 'number' && Number.isFinite(v)) || radius <= 0) return;
      session.view = { x, z, radius: Math.min(radius, MAX_VIEW_RADIUS_M) };
      if (session.regions) {
        const next = this.#regionsFor(session.view);
        session.wantedRegions = next;
        session.regionsDirty = next.join(',') !== session.regions.join(',');
      }
      return;
    }

    if (message?.type === 'unwatch') {
      if (session.watching !== null) session.recordingDirty = true;
      this.#unwatch(session);
      return;
    }

    this.#send(socket, JSON.stringify({ type: 'error', message: 'unsupported message type' }));
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
    const started = performance.now();
    // Each agent, wild chaser and the drop list are serialized once per broadcast and joined per
    // viewer. One JSON.stringify per viewer saturated the event loop and then the heap at 500
    // viewers and 250 agents (load test, 5 October 2026).
    let avatarJson: string[] | null = null, wildJson: string[] | null = null, dropsJson: string | null = null;
    const wildState = state.wild ?? [];
    for (const session of this.#sessions.values()) {
      const view = session.view;
      const sees = (p: { animalId: string; x: number; z: number }) => p.animalId === session.watching
        || (view !== null && Math.hypot(p.x - view.x, p.z - view.z) <= view.radius);
      const avatars: string[] = [], wild: string[] = [];
      for (let i = 0; i < state.avatars.length; i++) if (sees(state.avatars[i]!)) avatars.push((avatarJson ??= state.avatars.map((a) => JSON.stringify(a)))[i]!);
      for (let i = 0; i < wildState.length; i++) if (sees(wildState[i]!)) wild.push((wildJson ??= wildState.map((w) => JSON.stringify(w)))[i]!);
      const empty = avatars.length === 0 && state.drops.length === 0 && wild.length === 0;
      if (empty && session.liveEmpty) continue;
      session.liveEmpty = empty;
      dropsJson ??= JSON.stringify(state.drops);
      this.#send(session.socket, `{"type":"live","at":${JSON.stringify(at)},"avatars":[${avatars.join(',')}],"drops":${dropsJson},"wild":[${wild.join(',')}]}`);
    }
    this.stats.broadcastSeconds.live.record((performance.now() - started) / 1000);
  }

  /** Who is playing, everywhere, in brief: for the agents list, every couple of seconds. */
  broadcastRoster(state: LiveBroadcast): void {
    const started = performance.now();
    const payload = JSON.stringify({ type: 'live-roster', agents: state.avatars.map((a) => ({ agentId: a.agentId, name: a.name,
      animalId: a.animalId, speciesId: a.speciesId, x: Math.round(a.x), z: Math.round(a.z),
      activity: a.action === 'hunt' || a.action === 'feed' ? a.action : (a.altitude as number) >= 20 ? 'fly' : a.moving ? `${a.gait}` : a.action })) });
    for (const { socket } of this.#sessions.values()) this.#send(socket, payload);
    this.stats.broadcastSeconds.roster.record((performance.now() - started) / 1000);
  }

  broadcast(): void {
    const started = performance.now();
    try { this.#broadcast(); } finally { this.stats.broadcastSeconds.scene.record((performance.now() - started) / 1000); }
  }

  #broadcast(): void {
    const view = this.host.observation();
    if (!view) {
      for (const { socket } of this.#sessions.values()) socket.close(LIVE_BUSY_CLOSE_CODE, 'world_unavailable');
      this.#sessions.clear(); this.#watchers.clear();
      return;
    }
    // The whole-world scene is built only if a one-region (island) viewer needs it.
    let wholeScene: { id: string; base: string; environment: string } | null = null;
    const scene = (): { id: string; base: string; environment: string } => wholeScene ??= this.#scene(view);
    const frame = this.host.liveEncounterFrame();
    const frameId = frame?.id ?? null;
    // One serialization per distinct recording, and one encoded copy per distinct message: every
    // viewer due the same scene is handed the same Buffer. Building and converting a ~1.6 MB
    // string per viewer held the event loop for ~1.9 s at 500 viewers (load test, 5 October).
    // Encoded once per (region set, fresh or not): viewers looking at the same regions share a Buffer.
    type Recording = { payload: string; id: string | null; encoded: Map<string, Buffer> };
    const recordings = new Map<string | null, Recording>();
    let custom = 0;
    for (const session of this.#sessions.values()) {
      const { socket } = session;
      // A viewer that has moved onto other regions is sent them as a fresh scene, at most once
      // per REGION_SWITCH_MIN_MS: a view flipping back and forth cannot make a 2 MB scene a second.
      const moved = session.regionsDirty && Date.now() - session.lastRegionSceneAt >= REGION_SWITCH_MIN_MS;
      const freshCheckpoint = session.checkpointId !== view.id || moved;
      if (moved && session.wantedRegions) session.regions = session.wantedRegions;
      if (!freshCheckpoint && !session.recordingDirty && session.recordedFrameId === frameId) {
        // A world hour takes five real minutes. Repeating the unchanged ~1 MB scene every
        // second wastes tens of GB per viewer/day without advancing the client playhead.
        if (Date.now() - session.lastHeartbeatAt >= 30_000) {
          this.#send(socket, JSON.stringify({ type: 'heartbeat', checkpointId: view.id }));
          session.lastHeartbeatAt = Date.now();
        }
        continue;
      }
      // A regional viewer (Congo 1A.4) is sent only what ends in its regions: one recording per
      // region set, shared by every viewer of it who follows no one outside it.
      const regionKey = session.regions?.join(',') ?? null;
      if (regionKey !== null) {
        const key = `${session.watching ?? ''}|${regionKey}`;
        let recording = recordings.get(key);
        if (!recording) {
          const selected = this.host.liveEncounterFrame(session.watching, new Set(session.regions!));
          const timed = selected && frame && selected.id === frame.id
            ? { ...selected, elapsedWorldSeconds: frame.elapsedWorldSeconds } : selected;
          recording = { payload: JSON.stringify(timed), id: timed?.id ?? null, encoded: new Map() };
          if (session.watching === null || custom++ < 8) recordings.set(key, recording);
        }
        this.#sendRecording(session, recording, view, freshCheckpoint, moved, scene);
        continue;
      }
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
          recording = { payload: JSON.stringify(timed), id: timed?.id ?? null, encoded: new Map() };
          if (shared) recordings.set(null, recording);
          else if (custom++ < 8) recordings.set(session.watching, recording);
        }
        if (shared) recordings.set(session.watching, recording);
      }
      this.#sendRecording(session, recording, view, freshCheckpoint, moved, scene);
    }
    for (const actorId of this.#watchers.keys()) this.#publishViewerCount(actorId);
  }

  #sendRecording(session: Session, recording: { payload: string; id: string | null; encoded: Map<string, Buffer> },
    view: CheckpointObservation, freshCheckpoint: boolean, moved: boolean,
    scene: () => { id: string; base: string; environment: string }): void {
    // Immutable checkpoint geometry can exceed 1 MB: only a viewer new to this checkpoint gets it.
    const encodedKey = `${session.regions?.join(',') ?? ''}|${freshCheckpoint}`;
    let message = recording.encoded.get(encodedKey);
    if (!message) {
      const part = session.regions ? this.#regionScene(view, session.regions) : scene();
      message = Buffer.from(`${part.base}${freshCheckpoint ? `,"environment":${part.environment}` : ''},"frame":${recording.payload}}`);
      recording.encoded.set(encodedKey, message);
    }
    this.#send(session.socket, message);
    session.recordedFrameId = recording.id;
    session.recordingDirty = false;
    if (session.regions) {
      if (moved) session.lastRegionSceneAt = Date.now();
      // Still dirty if the view wants other regions than those just sent (a checkpoint's scene, not a move).
      session.regionsDirty = (session.wantedRegions ?? session.regions).join(',') !== session.regions.join(',');
    }
    session.checkpointId = view.id;
    session.lastHeartbeatAt = Date.now();
  }

  attach(server: Server): void {
    // Large checkpoint JSON is sparse and compresses well; small keepalives stay below
    // threshold. Bound zlib concurrency so a viewer surge cannot fork unlimited compressors.
    this.#wss = new WebSocketServer({ server, path: '/live', maxPayload: 1024, perMessageDeflate: {
      threshold: 64 * 1024, concurrencyLimit: 4, clientNoContextTakeover: true,
      // Level 3 deflates a 1.6 MB scene in under half the time of the default 6, for ~10% more
      // bytes on the wire; each viewer's copy is compressed separately (load test, 5 October).
      zlibDeflateOptions: { level: 3 },
      serverNoContextTakeover: true,
    } });
    // A server-level error (the HTTP server failing under it) is logged, never left to crash the process.
    this.#wss.on('error', (error) => console.error('[gateway] websocket server error', error.message));
    this.#wss.on('connection', (raw: WebSocket, request: IncomingMessage) => {
      // A frame too large, malformed UTF-8 or an unmasked frame makes ws close that socket and
      // emit 'error': with no listener that error would end the whole process. Only that viewer goes.
      raw.on('error', () => { this.stats.badFrames++; });
      // Every new viewer is sent the whole scene, so connections are capped in total and per
      // visitor network. A refused one is told to try later rather than simply dropped.
      const network = networkKey(forwardedClient(request.socket.remoteAddress ?? '', request.headers['x-forwarded-for'], this.#hops));
      const admitted = this.#caps.admit(network);
      if (admitted !== 'ok') {
        const reason = admitted === 'total' ? 'busy' : 'busy_network';
        this.stats.refused[reason]++;
        raw.close(LIVE_BUSY_CLOSE_CODE, reason);
        return;
      }
      this.stats.accepted++;
      raw.once('close', () => this.#caps.release(network));
      const socket: GatewaySocket = {
        // Buffers are shared encoded scenes; they are still JSON text, never binary frames.
        send: (data) => raw.send(data, { binary: false }),
        close: (code, reason) => raw.close(code, reason),
        get bufferedAmount() { return raw.bufferedAmount; },
        terminate: () => raw.terminate(),
      };
      this.handle(socket);
      raw.on('message', (data) => {
        try {
          this.receive(socket, JSON.parse(String(data)) as ClientMessage);
        } catch {
          this.#send(socket, JSON.stringify({ type: 'error', message: 'unsupported message type' }));
        }
      });
      raw.on('close', () => this.disconnect(socket));
    });
  }

  /** Stops taking viewers and closes every open one (1001: going away), so the HTTP server can finish closing. */
  close(): void {
    for (const client of this.#wss?.clients ?? []) client.close(1001, 'restarting');
    this.#wss?.close();
    this.#wss = null;
  }

  #unwatch(session: Session): void {
    if (session.watching === null) return;
    const set = this.#watchers.get(session.watching);
    set?.delete(session.socket);
    if (set && set.size === 0) this.#watchers.delete(session.watching);
    session.watching = null; // The remaining watchers hear the new count with the next broadcast.
  }

  #publishViewerCount(actorId: string): void {
    const payload = JSON.stringify({ type: 'viewers', actorId, count: this.viewerCount(actorId) });
    for (const socket of this.#watchers.get(actorId) ?? []) this.#send(socket, payload);
  }

  /** Sends to a viewer that is keeping up; one that has stopped reading is cut off instead. */
  #send(socket: GatewaySocket, data: string | Buffer): void {
    if ((socket.bufferedAmount ?? 0) <= MAX_BUFFERED_BYTES) {
      socket.send(data);
      this.stats.messages++; this.stats.bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      return;
    }
    this.stats.slowConsumerTerminations++;
    this.disconnect(socket);
    if (socket.terminate) socket.terminate(); else socket.close();
  }

  #worldMessage(view: CheckpointObservation): Record<string, unknown> {
    const now = view.worldTime;
    return {
      type: 'world', worldTime: now, formatted: formatWorldTime(now, this.host.world?.terrainProfile),
      season: seasonAt(now, this.host.world?.terrainProfile), population: view.summary().population,
      source: 'checkpoint', nextEventSequence: view.nextSequence,
      worldHoursPerRealHour: this.host.worldHoursPerRealHour,
      grid: this.host.grid,
    };
  }

  /** Serialize immutable common state once per checkpoint, not once per heartbeat or viewer. */
  #scene(view: CheckpointObservation): { id: string; base: string; environment: string } {
    if (this.#cachedScene?.id === view.id) return this.#cachedScene;
    const base = JSON.stringify({ type: 'scene', protocol: 1, checkpointId: view.id,
      world: this.#worldMessage(view), animals: this.#animalsMessage(view).animals }).slice(0, -1);
    const environment = JSON.stringify({
      patches: view.patches().map((p) => this.#patchView(p)),
      microEcology: view.microEcology(),
      community: view.community(),
      carcasses: view.carcasses().map((c) => this.#carcassView(c)),
    });
    return this.#cachedScene = { id: view.id, base, environment };
  }

  #patchView(p: Patch): Record<string, unknown> {
    return { id: p.id, x: p.x, y: p.y, habitat: p.habitat,
      elevation: p.elevation, canopyCover: p.canopyCover, islandSeed: p.islandSeed,
      ...(p.congoSeed === undefined ? {} : { congoSeed: p.congoSeed }), surface: p.surface, grass: p.plant.grass,
      browse: p.plant.browse, floweringGuild: floweringGuildSummary(p),
      water: p.waterVolume, drainage: p.drainage };
  }

  #carcassView(c: Carcass): Record<string, unknown> {
    return { id: c.originId, speciesId: c.speciesId,
      patchId: c.patchId, position: c.position, state: 'dead', currentGoal: '',
      decayStage: c.decayStage,
      sizeRatio: c.originalMassKg / (this.host.world.species.get(c.speciesId)?.body.adultMassKg ?? c.originalMassKg),
      drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } };
  }

  #animalsMessage(view: CheckpointObservation): Record<string, unknown> {
    return {
      type: 'animals',
      worldTime: view.worldTime, source: 'checkpoint', nextEventSequence: view.nextSequence,
      animals: view.livingAnimals().map((a) => this.#animalView(a)),
    };
  }

  #animalView(a: Agent): Record<string, unknown> {
    return {
      id: a.id, speciesId: a.speciesId, patchId: a.patchId,
      position: a.position,
      state: a.state, currentGoal: a.currentGoal, drives: a.drives,
      ...(a.illness?.phase === 'active' ? { illnessStatus: 'symptomatic' } : {}),
      ...(a.wound ? { woundStatus: a.wound.phase } : {}),
      ...(a.altitudeM === undefined ? {} : { altitudeM: a.altitudeM, locomotionMode: a.locomotionMode ?? 'flight' }),
      ...(a.locomotionMode === 'submerged' ? { locomotionMode: 'submerged' } : {}),
      lifeStage: a.lifeStage, sex: a.sex, coatVariant: a.traits.coatVariant,
      sizeRatio: a.massKg / (this.host.world.species.get(a.speciesId)?.body.adultMassKg ?? a.massKg),
      dependentOn: a.dependentOn, groupId: a.groupId ?? null,
      // What the thought bubble reads; see thoughtFor in @vana/shared.
      alternativeGoal: a.alternativeGoal, goalScore: a.goalScore, dependent: a.dependentOn !== null,
    };
  }

  /** Congo 1A.3: the regions (6 km squares) a viewer is sent: those its view reaches, or the centre one. */
  #regionsFor(view: Session['view']): string[] {
    const grid = this.host.grid, side = grid.regionPatches * grid.patchM, min = -grid.patchM / 2;
    if (!view) {
      const e = worldExtentM(grid);
      return [regionOfPatch(grid, patchAtPosition(grid, { x: (e.min + e.maxX) / 2, z: (e.min + e.maxZ) / 2, heading: 0 }))];
    }
    const reach = view.radius + REGION_MARGIN_M;
    return regionIds(grid).filter((id) => {
      const [c, r] = id.slice(1).split('_').map(Number) as [number, number];
      const x0 = min + c * side, z0 = min + r * side;
      const dx = Math.max(x0 - view.x, 0, view.x - (x0 + side)), dz = Math.max(z0 - view.z, 0, view.z - (z0 + side));
      return Math.hypot(dx, dz) <= reach;
    });
  }

  /** One serialization per checkpoint and region set: animals, patches and the rest of those regions only. */
  #regionScene(view: CheckpointObservation, regions: readonly string[]): { base: string; environment: string } {
    const key = regions.join(',');
    if (this.#regionScenes.checkpointId !== view.id) this.#regionScenes = { checkpointId: view.id, scenes: new Map() };
    const cached = this.#regionScenes.scenes.get(key);
    if (cached) return cached;
    const base = JSON.stringify({ type: 'scene', protocol: 1, checkpointId: view.id, regions,
      world: this.#worldMessage(view), animals: regions.flatMap((id) => view.regionAnimals(id)).map((a) => this.#animalView(a)) }).slice(0, -1);
    const micro = regions.map((id) => view.regionMicroEcology(id));
    const environment = JSON.stringify({
      patches: regions.flatMap((id) => view.regionPatches(id)).map((p) => this.#patchView(p)),
      microEcology: { updatedAt: micro[0]?.updatedAt ?? view.worldTime, patches: micro.flatMap((m) => m.patches) },
      community: null,
      carcasses: regions.flatMap((id) => view.regionCarcasses(id)).map((c) => this.#carcassView(c)),
    });
    const scene = { base, environment };
    // Least recently built first out: no set of viewers can pin the cache full.
    if (this.#regionScenes.scenes.size >= MAX_REGION_SCENES) this.#regionScenes.scenes.delete(this.#regionScenes.scenes.keys().next().value!);
    this.#regionScenes.scenes.set(key, scene);
    return scene;
  }
}
