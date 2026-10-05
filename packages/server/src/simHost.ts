import type { Agent, Carcass, Patch, WorldEvent, LiveEncounterFrame, LiveMovement, WaterBudget, TerrainProfile, MicroEcologyState, CommunityProfile, CommunityState, CommunityMotion, WorldPosition } from '@vana/shared';
import { movementAt, paceMovement, recordedSecondAt, type Pacing } from '@vana/shared';
import { randomUUID } from 'node:crypto';
import { collectLiveEncounters, indexLiveMovements, selectLiveMovements, encounterAppearance } from './liveEncounters.js';
import {
  FOREST_FLOOR, FOREST_LANDSCAPE, FOREST_POPULATION, ISLAND_POPULATION, SIM_VERSION,
  upgradeV16Snapshot, upgradeV17Snapshot, upgradeV18Snapshot, upgradeV19Snapshot, upgradeV20Snapshot, upgradeV21Snapshot, upgradeV22Snapshot, upgradeV23Snapshot, upgradeV24Snapshot, upgradeV25Snapshot, upgradeV26Snapshot, upgradeV27Snapshot, upgradeV28Snapshot, upgradeV29Snapshot, upgradeV30Snapshot, upgradeV31Snapshot,
  createWorld, restoreSnapshot, takeSnapshot, totalNutrients, upgradeV5Snapshot, upgradeV6Snapshot, upgradeV7Snapshot, upgradeV8Snapshot, upgradeV9Snapshot, upgradeV10Snapshot, upgradeV11Snapshot, upgradeV12Snapshot, upgradeV13Snapshot, upgradeV14Snapshot, upgradeV15Snapshot, type Snapshot, type World, type WorldOptions,
} from '@vana/sim';
import type { Pool } from './db/pool.js';
import { EventStore } from './db/eventStore.js';
import { SnapshotStore } from './db/snapshotStore.js';
import { LifeStore } from './db/lifeStore.js';
import { HumanMotionStore } from './db/humanMotionStore.js';
import { WorldWriter } from './db/worldWriter.js';
import { migrateOwned } from './db/migrate.js';

export interface SimHostOptions {
  communityProfile?: CommunityProfile;
  initialCommunityRulesVersion?: 2 | 3 | 4 | 5 | 6 | 7 | 8;
  terrainProfile?: TerrainProfile;
  /** Explicit acknowledgement of household stored-water routing correction. */
  allowV16Upgrade?: boolean;
  /** Explicit acknowledgement of source-backed boar young-care rules. */
  allowV17Upgrade?: boolean;
  /** Explicit acknowledgement of finite freshwater primary-producer rules. */
  allowV18Upgrade?: boolean;
  /** Explicit acknowledgement of the island freshwater-basin layout change. */
  allowV19Upgrade?: boolean;
  /** Explicit acknowledgement of the carrion-illness lifecycle rule change. */
  allowV20Upgrade?: boolean;
  /** Explicit acknowledgement of closed-island founder and early boar hydration rules. */
  allowV21Upgrade?: boolean;
  /** Explicit acknowledgement of mobile tiger cub freshwater access. */
  allowV22Upgrade?: boolean;
  /** Explicit acknowledgement of parent-opened finite tiger cub meat access. */
  allowV23Upgrade?: boolean;
  /** Explicit acknowledgement of authoritative langur/squirrel climbing. */
  allowV24Upgrade?: boolean;
  /** Explicit acknowledgement of contact-grounded survivor wound rules. */
  allowV25Upgrade?: boolean;
  /** Explicit acknowledgement of finite freshwater early-life recruitment. */
  allowV26Upgrade?: boolean;
  allowV27Upgrade?: boolean;
  /** Explicit acknowledgement of reciprocal, contact-grounded mate response. */
  allowV28Upgrade?: boolean;
  /** v0.30 moves water access points off patch centres; see upgradeV29Snapshot. */
  allowV29Upgrade?: boolean;
  /** v0.31 keeps prey off a predator's kill and allows agent-steered animals; see upgradeV30Snapshot. */
  allowV30Upgrade?: boolean;
  /** v0.32 changes three parental-care decisions (hunger, predator presence, idle range); see upgradeV31Snapshot. */
  allowV31Upgrade?: boolean;
  allowV15Upgrade?: boolean;
  allowV14Upgrade?: boolean;
  /** Explicit rules-change acknowledgement. Back up the database before enabling. Default false. */
  allowV5Upgrade?: boolean;
  /** Separate opt-in from v0.6, including lifecycle and subsequent rules changes. */
  allowV6Upgrade?: boolean;
  /** Separate opt-in from v0.7 for contact and remaining-time feeding rules. */
  allowV7Upgrade?: boolean;
  /** Separate opt-in from v0.8 for ordinary locomotion/routing rules. */
  allowV8Upgrade?: boolean;
  /** Separate opt-in from v0.9 for local water contact and drinking time. */
  allowV9Upgrade?: boolean;
  /** Separate opt-in from v0.10 for contact-based parental care and family movement. */
  allowV10Upgrade?: boolean;
  /** Separate opt-in from v0.11 for scheduled nursing, intake budgets and rendezvous. */
  allowV11Upgrade?: boolean;
  /** Separate opt-in from v0.12 for carried food and cooperative pack care. */
  allowV12Upgrade?: boolean;
  /** Separate opt-in from v0.13 for conserved downstream surface-water routing. */
  allowV13Upgrade?: boolean;
  pool: Pool;
  seed: number;
  speciesDir: string;
  /** Live acceleration. 12 means one world hour every 5 real minutes, independent of route length. */
  worldHoursPerRealHour?: number;
  snapshotEveryWorldHours?: number;
  /** How often every animal's position and drives are sampled for life replay. */
  trackEveryWorldHours?: number;
  /** How often routine events are pruned and the long departed archived. */
  housekeepingEveryWorldHours?: number;
  /** How long hour-by-hour routine events stay in the log before they are pruned. */
  routineRetentionWorldDays?: number;
  /**
   * How long the dead stay in the running world before they are archived and released. Long
   * enough that no pregnancy still names one as the father: the longest gestation is 640 days.
   */
  archiveAfterWorldDays?: number;
  /** Seed counts, floors and edge exchange. Each defaults to the canonical forest in @vana/sim. */
  initialAgents?: Record<string, number>;
  minPopulation?: Record<string, number>;
  /** The country around the forest. `null` closes the edge. */
  landscape?: NonNullable<WorldOptions['landscape']> | null;
}

export interface BootResult {
  restoredFrom: number | null;
  rolledBackEvents: number;
}

export interface CheckpointObservation {
  community(): CommunityState | null;
  id: string;
  worldTime: number;
  nextSequence: number;
  /** Returns a detached copy from this checkpoint, even if another tick finishes later. */
  animal(id: string): Agent | undefined;
  livingAnimals(): Agent[];
  patches(): Patch[];
  carcasses(): Carcass[];
  waterBudget(): WaterBudget | null;
  microEcology(): MicroEcologyState;
  summary(): { population: Record<string, number>; patches: number; totalNutrients: number };
}

export class SimHost {
  world!: World;

  readonly #events: EventStore;
  readonly #snapshots: SnapshotStore;
  readonly #life: LifeStore;
  readonly #humanMotion: HumanMotionStore;
  readonly #writer: WorldWriter;
  #lifecycle: 'new' | 'booting' | 'running' | 'closed' = 'new';
  #worldHoursSinceTrack = 0;
  #worldHoursSinceHousekeeping = 0;
  readonly #options: Required<SimHostOptions>;
  #worldHoursSinceSnapshot = 0;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;
  #operations: Promise<unknown> = Promise.resolve();
  #pendingEvents: WorldEvent[] = [];
  #pendingHumanMotion: Array<{ community: CommunityState; motion: CommunityMotion }> = [];
  readonly #streamId = randomUUID();
  #pendingEncounterFrame: LiveEncounterFrame | null = null;
  #encounterFrame: LiveEncounterFrame | null = null;
  #pendingMovementIndex = new Map<string, LiveMovement>();
  #movementIndex = new Map<string, LiveMovement>();
  #encounterPublishedAt = 0;
  /** Exposed to diagnostics; a failed scheduler tick is never an unhandled rejection. */
  lastError: string | null = null;
  #consecutiveTickFailures = 0;
  #checkpointTime: number | null = null;
  #checkpointEventSequence = 0;
  #rewardSubjects = new Map<string, { alive: boolean; carcass: boolean }>();
  #worldId: string | null = null;
  #checkpointAnimals = new Map<string, Agent>();
  #checkpointEnvironment: Pick<Snapshot, 'patches' | 'carcasses'> = { patches: [], carcasses: [] };
  #checkpointSummary = { population: {} as Record<string, number>, patches: 0, totalNutrients: 0 };
  #checkpointLiving: Agent[] = [];
  #checkpointWaterBudget: WaterBudget | null = null;
  #checkpointMicroEcology: MicroEcologyState = { updatedAt: 0, patches: [] };
  #checkpointCommunity: CommunityState | null = null;
  #checkpointRevision = 0;
  #lastCheckpointWallMs = 0;
  /** Where the clock stood when start() began scheduling hours, for vana_world_clock_lag_seconds. */
  #schedule: { wallMs: number; worldTime: number } | null = null;
  /** Figures for /metrics (metrics.ts); counted since this process started. */
  readonly stats = { tickFailures: 0, ticksSkipped: 0, lastTickSeconds: 0, maxTickSeconds: 0 };
  readonly simVersion = SIM_VERSION;

  get checkpointTime(): number | null { return this.#checkpointTime; }
  /** Wall-clock milliseconds of the last durable checkpoint; 0 before the first. */
  get lastCheckpointAt(): number { return this.#lastCheckpointWallMs; }
  /**
   * World seconds the clock is behind the hours it should have stepped since start(): 0 while
   * every scheduled hour has run, an hour while one is in flight, more once hours fail or pile up.
   */
  clockLagSeconds(now = Date.now()): number {
    if (!this.#schedule) return 0;
    const due = Math.floor((now - this.#schedule.wallMs) * this.#options.worldHoursPerRealHour / 3_600_000);
    return Math.max(0, this.#schedule.worldTime + due * 3600 - this.world.now());
  }
  get checkpointEventSequence(): number { return this.#checkpointEventSequence; }
  /** A healthy HTTP listener is not proof that the autonomous clock is still advancing. */
  get hasFreshCheckpoint(): boolean {
    const maxLagMs = Math.max(15 * 60_000, 3 * 3_600_000 / this.#options.worldHoursPerRealHour);
    return this.#lastCheckpointWallMs > 0 && Date.now() - this.#lastCheckpointWallMs <= maxLagMs;
  }

  observation(): CheckpointObservation | null {
    if (!this.isWriterActive || this.lastError || !this.hasFreshCheckpoint || this.#checkpointTime === null) return null;
    const animals = this.#checkpointAnimals;
    const living = this.#checkpointLiving, environment = this.#checkpointEnvironment, summary = this.#checkpointSummary;
    const waterBudget = this.#checkpointWaterBudget;
    const community = this.#checkpointCommunity;
    return { id: `${this.#streamId}:${this.#checkpointRevision}`, worldTime: this.#checkpointTime, nextSequence: this.#checkpointEventSequence,
      livingAnimals: () => structuredClone(living),
      patches: () => structuredClone(environment.patches),
      carcasses: () => structuredClone(environment.carcasses),
      waterBudget: () => structuredClone(waterBudget),
      community: () => structuredClone(community),
      microEcology: () => structuredClone(this.#checkpointMicroEcology),
      summary: () => structuredClone(summary),
      animal(id) { const a = animals.get(id); return a === undefined ? undefined : structuredClone(a); } };
  }

  /**
   * The founded world's durable identity. A new founding on the same database gets a new one,
   * so records keyed by actor ID (the reward ledger) cannot carry over to a different world.
   */
  get worldId(): string | null {
    return this.#worldId;
  }

  async #bindWorldIdentity(founded: boolean): Promise<void> {
    if (!founded) {
      const { rows } = await this.#writer.query<{ world_id: string }>('select world_id from world_identity');
      // A world saved before identities existed is bound to one now, in place.
      if (rows[0]) { this.#worldId = rows[0].world_id; return; }
    }
    const id = randomUUID();
    await this.#writer.query(`insert into world_identity (singleton, world_id) values (true, $1)
      on conflict (singleton) do update set world_id = excluded.world_id, founded_at = now()`, [id]);
    this.#worldId = id;
  }

  /** A reward may reference only checkpointed subjects, never a rollback-prone birth/death. */
  rewardSubject(id: string): { alive: boolean; carcass: boolean } | null {
    if (!this.isWriterActive || this.lastError || !this.hasFreshCheckpoint) return null;
    const subject = this.#rewardSubjects.get(id);
    return subject ? { ...subject } : null;
  }

  #publishCheckpoint(snapshot: Snapshot): void {
    this.#checkpointRevision++;
    this.#lastCheckpointWallMs = Date.now();
    this.#checkpointTime = snapshot.worldTime;
    this.#checkpointEventSequence = snapshot.eventSequence ?? 0;
    // The snapshot detached these records before the database write. Retain only observer
    // slices, not RNG/internal state or another world clone. Readers receive their own copies.
    this.#checkpointAnimals = new Map([...snapshot.deceased, ...snapshot.agents].map((a) => [a.id, a]));
    this.#checkpointLiving = snapshot.agents.filter((a) => a.alive);
    this.#checkpointEnvironment = { patches: snapshot.patches, carcasses: snapshot.carcasses };
    this.#checkpointWaterBudget = snapshot.waterBudget ? structuredClone(snapshot.waterBudget) : null;
    this.#checkpointCommunity = snapshot.community ? structuredClone(snapshot.community) : null;
    this.#checkpointMicroEcology = structuredClone(snapshot.microEcology ?? { updatedAt: snapshot.worldTime, patches: [] });
    const population = Object.fromEntries([...this.world.species.keys()].map((id) => [id, 0]));
    for (const animal of this.#checkpointLiving) population[animal.speciesId] = (population[animal.speciesId] ?? 0) + 1;
    this.#checkpointSummary = { population, patches: snapshot.patches.length,
      totalNutrients: totalNutrients(snapshot.patches, snapshot.agents, snapshot.ledger, snapshot.carcasses, snapshot.microEcology, snapshot.community) };
    this.#rewardSubjects = new Map(snapshot.agents.filter((a) => a.alive)
      .map((a) => [a.id, { alive: true, carcass: false }]));
    for (const c of snapshot.carcasses) this.#rewardSubjects.set(c.originId, { alive: false, carcass: true });
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation);
    this.#operations = result.catch(() => undefined);
    return result;
  }

  constructor(options: SimHostOptions) {
    this.#options = {
      communityProfile: 'none',
      initialCommunityRulesVersion: 8,
      terrainProfile: 'mainland',
      allowV14Upgrade: false,
      allowV15Upgrade: false,
      allowV16Upgrade: false,
      allowV17Upgrade: false,
      allowV18Upgrade: false,
      allowV19Upgrade: false,
      allowV20Upgrade: false,
      allowV21Upgrade: false,
      allowV22Upgrade: false,
      allowV23Upgrade: false,
      allowV24Upgrade: false,
      allowV25Upgrade: false,
      allowV26Upgrade: false,
      allowV27Upgrade: false,
      allowV28Upgrade: false,
      allowV29Upgrade: false,
      allowV30Upgrade: false,
      allowV31Upgrade: false,
      allowV5Upgrade: false,
      allowV6Upgrade: false,
      allowV7Upgrade: false,
      allowV8Upgrade: false,
      allowV9Upgrade: false,
      allowV10Upgrade: false,
      allowV11Upgrade: false,
      allowV12Upgrade: false,
      allowV13Upgrade: false,
      worldHoursPerRealHour: 12,
      snapshotEveryWorldHours: 1,
      trackEveryWorldHours: 6,
      housekeepingEveryWorldHours: 24,
      routineRetentionWorldDays: 3,
      archiveAfterWorldDays: 730,
      initialAgents: options.terrainProfile === 'island_v1' ? ISLAND_POPULATION : FOREST_POPULATION,
      minPopulation: options.terrainProfile === 'island_v1' ? {} : FOREST_FLOOR,
      landscape: options.terrainProfile === 'island_v1' ? null : FOREST_LANDSCAPE,
      ...options,
    };
    this.#writer = new WorldWriter(options.pool, () => {
      this.lastError = 'world writer connection lost; restart required';
      if (this.#timer !== null) clearInterval(this.#timer);
      this.#timer = null;
    });
    this.#events = new EventStore(this.#writer);
    this.#snapshots = new SnapshotStore(this.#writer);
    this.#life = new LifeStore(this.#writer);
    this.#humanMotion = new HumanMotionStore(this.#writer);
  }

  get worldOptions(): WorldOptions {
    return {
      communityProfile: this.#options.communityProfile,
      initialCommunityRulesVersion: this.#options.initialCommunityRulesVersion,
      terrainProfile: this.#options.terrainProfile,
      seed: this.#options.seed,
      speciesDir: this.#options.speciesDir,
      initialAgents: this.#options.initialAgents,
      minPopulation: this.#options.minPopulation,
      ...(this.#options.landscape === null ? {} : { landscape: this.#options.landscape }),
    };
  }

  /** How many world hours pass per real hour, for clients pacing their animation. */
  get worldHoursPerRealHour(): number {
    return this.#options.worldHoursPerRealHour;
  }

  get isWriterActive(): boolean { return this.#lifecycle === 'running' && this.#writer.active; }
  get consecutiveTickFailures(): number { return this.#consecutiveTickFailures; }

  /** A monotonic server-relative clock lets joins/repeated broadcasts share the same playhead. */
  readonly #pacing = new WeakMap<object, Pacing>();
  /**
   * Where a wild animal is being shown right now: on its recorded route at the moment being
   * played, paced exactly as the observer paces it, or else where it was last saved. The live
   * layer uses this to tell whether a predator has really reached its prey.
   */
  playedPosition(id: string): WorldPosition | null {
    const frame = this.liveEncounterFrame();
    const movement = frame ? this.#movementIndex.get(id) : undefined;
    if (frame && movement) {
      let pacing = this.#pacing.get(movement.trace);
      if (!pacing) { pacing = paceMovement(movement.trace, movement.actor.speciesId, frame.rate); this.#pacing.set(movement.trace, pacing); }
      const seconds = recordedSecondAt(pacing, frame.elapsedWorldSeconds);
      const activity = movement.activity;
      if (activity && seconds >= activity.startSeconds) return { ...activity.position };
      const at = movementAt(movement.trace, seconds);
      return { x: at.x, z: at.z, heading: at.heading };
    }
    const agent = this.world.animal(id);
    return agent?.alive && agent.position ? { ...agent.position } : null;
  }

  liveEncounterFrame(priorityActorId: string | null = null): LiveEncounterFrame | null {
    const frame = this.#encounterFrame;
    if (!this.isWriterActive || this.lastError || !frame) return null;
    const elapsedWorldSeconds = (performance.now() - this.#encounterPublishedAt) * frame.rate / 1000;
    if (elapsedWorldSeconds >= frame.endWorldTime - frame.startWorldTime) return null;
    const prioritize = priorityActorId !== null && this.#movementIndex.has(priorityActorId)
      && !frame.movements?.some((m) => m.actor.id === priorityActorId);
    return { ...frame, elapsedWorldSeconds,
      ...(prioritize ? { movements: selectLiveMovements(this.#movementIndex, priorityActorId) } : {}) };
  }

  boot(): Promise<BootResult> {
    return this.#serial(async () => {
      if (this.#lifecycle !== 'new') throw new Error('world host has already booted or closed');
      this.#lifecycle = 'booting';
      try {
        await this.#writer.acquire();
        await migrateOwned(this.#writer);
        const result = await this.#boot();
        this.#lifecycle = 'running';
        return result;
      } catch (error) {
        this.#lifecycle = 'closed';
        await this.#writer.release();
        throw error;
      }
    });
  }

  async #boot(): Promise<BootResult> {
    let snapshot = await this.#snapshots.loadLatest();
    let upgradedFrom: string | null = null;

    if (snapshot === null) {
      if (await this.#humanMotion.hasAny())
        throw new Error('refusing to found world: historical human motion exists without a snapshot; recover the checkpoint explicitly');
      this.world = createWorld(this.worldOptions);
      await this.#bindWorldIdentity(true);
      await this.#snapshotNow();
      return { restoredFrom: null, rolledBackEvents: 0 };
    }

    if (snapshot.simVersion !== SIM_VERSION) {
      // Wounds first existed in v0.26. Pre-v0.26 direct jumps must not smuggle them in;
      // a genuine v0.26 checkpoint may preserve its active wound across this upgrade.
      if (!['sim_0.26.0', 'sim_0.27.0', 'sim_0.28.0', 'sim_0.29.0', 'sim_0.30.0', 'sim_0.31.0'].includes(snapshot.simVersion)
        && snapshot.agents.some(agent => agent.wound !== undefined))
        throw new Error('refusing to upgrade: old snapshot contains future wound state');
      if (!['sim_0.27.0', 'sim_0.28.0', 'sim_0.29.0', 'sim_0.30.0', 'sim_0.31.0'].includes(snapshot.simVersion)
        && snapshot.microEcology?.patches.some(patch => patch.fishCohort !== undefined))
        throw new Error('refusing to upgrade: old snapshot contains future fish cohort state');
      if (!['sim_0.28.0', 'sim_0.29.0', 'sim_0.30.0', 'sim_0.31.0'].includes(snapshot.simVersion)
        && snapshot.patches.some(patch => patch.floweringGuild !== undefined))
        throw new Error('refusing to upgrade: old snapshot contains future flowering guild state');
      if (this.#options.allowV5Upgrade && snapshot.simVersion === 'sim_0.5.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV5Snapshot(snapshot);
      } else if (this.#options.allowV6Upgrade && snapshot.simVersion === 'sim_0.6.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV6Snapshot(snapshot);
      } else if (this.#options.allowV7Upgrade && snapshot.simVersion === 'sim_0.7.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV7Snapshot(snapshot);
      } else if (this.#options.allowV8Upgrade && snapshot.simVersion === 'sim_0.8.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV8Snapshot(snapshot);
      } else if (this.#options.allowV9Upgrade && snapshot.simVersion === 'sim_0.9.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV9Snapshot(snapshot);
      } else if (this.#options.allowV10Upgrade && snapshot.simVersion === 'sim_0.10.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV10Snapshot(snapshot);
      } else if (this.#options.allowV11Upgrade && snapshot.simVersion === 'sim_0.11.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV11Snapshot(snapshot);
      } else if (this.#options.allowV12Upgrade && snapshot.simVersion === 'sim_0.12.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV12Snapshot(snapshot);
      } else if (this.#options.allowV13Upgrade && snapshot.simVersion === 'sim_0.13.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV13Snapshot(snapshot);
      } else if (this.#options.allowV14Upgrade && snapshot.simVersion === 'sim_0.14.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV14Snapshot(snapshot);
      } else if (this.#options.allowV15Upgrade && snapshot.simVersion === 'sim_0.15.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV15Snapshot(snapshot);
      } else if (this.#options.allowV16Upgrade && snapshot.simVersion === 'sim_0.16.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV16Snapshot(snapshot);
      } else if (this.#options.allowV17Upgrade && snapshot.simVersion === 'sim_0.17.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV17Snapshot(snapshot);
      } else if (this.#options.allowV18Upgrade && snapshot.simVersion === 'sim_0.18.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV18Snapshot(snapshot);
      } else if (this.#options.allowV19Upgrade && snapshot.simVersion === 'sim_0.19.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV19Snapshot(snapshot);
      } else if (this.#options.allowV20Upgrade && snapshot.simVersion === 'sim_0.20.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV20Snapshot(snapshot);
      } else if (this.#options.allowV21Upgrade && snapshot.simVersion === 'sim_0.21.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV21Snapshot(snapshot);
      } else if (this.#options.allowV22Upgrade && snapshot.simVersion === 'sim_0.22.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV22Snapshot(snapshot);
      } else if (this.#options.allowV23Upgrade && snapshot.simVersion === 'sim_0.23.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV23Snapshot(snapshot);
      } else if (this.#options.allowV24Upgrade && snapshot.simVersion === 'sim_0.24.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV24Snapshot(snapshot);
      } else if (this.#options.allowV25Upgrade && snapshot.simVersion === 'sim_0.25.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV25Snapshot(snapshot);
      } else if (this.#options.allowV26Upgrade && snapshot.simVersion === 'sim_0.26.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV26Snapshot(snapshot);
      } else if (this.#options.allowV27Upgrade && snapshot.simVersion === 'sim_0.27.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV27Snapshot(snapshot);
      } else if (this.#options.allowV28Upgrade && snapshot.simVersion === 'sim_0.28.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV28Snapshot(snapshot);
      } else if (this.#options.allowV29Upgrade && snapshot.simVersion === 'sim_0.29.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV29Snapshot(snapshot);
      } else if (this.#options.allowV30Upgrade && snapshot.simVersion === 'sim_0.30.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV30Snapshot(snapshot);
      } else if (this.#options.allowV31Upgrade && snapshot.simVersion === 'sim_0.31.0') {
        upgradedFrom = snapshot.simVersion;
        snapshot = upgradeV31Snapshot(snapshot);
      } else throw new Error(
        `refusing to boot: snapshot ${snapshot.simVersion} predates runtime ${SIM_VERSION}`,
      );
    }

    this.world = restoreSnapshot(snapshot, this.worldOptions);
    this.#publishCheckpoint(takeSnapshot(this.world));

    // Events written after the newest snapshot belong to a timeline that did not survive the
    // restart. Remove them and say so out loud rather than leaving an inconsistent history.
    const orphaned = await this.#events.countAfter(snapshot.worldTime, snapshot.eventSequence ?? 0);
    await this.#life.deleteTracksAfter(snapshot.worldTime);
    await this.#humanMotion.deleteAfter(snapshot.worldTime);
    if (orphaned > 0) {
      await this.#events.deleteAfter(snapshot.worldTime, snapshot.eventSequence ?? 0);
      await this.#events.appendBatch([{
        id: `maintenance_${Date.now().toString(16)}`,
        type: 'maintenance',
        worldTime: snapshot.worldTime,
        simVersion: SIM_VERSION,
        patchId: 0,
        actors: [],
        conditions: { reason: 'restart_rollback' },
        outcome: 'success',
        effects: { rolledBackEvents: orphaned },
        causalParents: [],
        confidence: 'authoritative',
      }]);
    }

    if (upgradedFrom !== null) {
      this.world.log.append({
        type: 'maintenance', worldTime: this.world.now(), simVersion: SIM_VERSION, patchId: 0, actors: [],
        conditions: { reason: 'explicit_rules_upgrade', from: upgradedFrom, to: SIM_VERSION },
        outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative',
      });
      await this.#snapshotNow();
    }
    await this.#bindWorldIdentity(false);
    return { restoredFrom: snapshot.worldTime, rolledBackEvents: orphaned };
  }

  /**
   * Drains the simulation's event buffer into Postgres. Taking rather than copying is what keeps
   * a world that runs for months from filling the heap with its own history.
   */
  flush(): Promise<void> { return this.#serial(() => this.#flush()); }

  async #flush(): Promise<void> {
    this.#writer.assertActive();
    // Retain ownership until every chunk succeeds. Retrying a partially written batch is safe
    // because durable sequence IDs are stable and the store's inserts are idempotent.
    if (this.#pendingEvents.length === 0) this.#pendingEvents = this.world.log.take();
    if (this.#pendingEvents.length > 0) {
      await this.#events.appendBatch(this.#pendingEvents);
      this.#pendingEvents = [];
    }
    if (this.world.log.retainedCount() > 0) await this.#flush();
  }

  snapshotNow(): Promise<void> { return this.#serial(() => this.#snapshotNow()); }

  async #snapshotNow(): Promise<void> {
    await this.#flush();
    const checkpoint = takeSnapshot(this.world);
    // Persist every completed hour, not just `checkpoint.community.motion` (the final hour).
    // These inserts may be retried; only the subsequent durable snapshot publishes them.
    await this.#humanMotion.append(this.#pendingHumanMotion);
    await this.#snapshots.save(checkpoint);
    await this.#snapshots.prune(48);
    this.#publishCheckpoint(checkpoint);
    this.#pendingHumanMotion = [];
    this.#worldHoursSinceSnapshot = 0;
    // An event insert alone is insufficient: restart recovery may roll it back. Publish only
    // after the matching world checkpoint is durable, and never restart it on another save.
    if (this.#pendingEncounterFrame?.endWorldTime === this.world.now()) {
      this.#encounterFrame = this.#pendingEncounterFrame;
      this.#movementIndex = this.#pendingMovementIndex;
      this.#pendingMovementIndex = new Map();
      this.#pendingEncounterFrame = null;
      this.#encounterPublishedAt = performance.now();
    }
  }

  advance(worldHours: number): Promise<void> {
    return this.#serial(() => this.#advance(worldHours));
  }

  async #advance(worldHours: number): Promise<void> {
    this.#writer.assertActive();
    if (!Number.isSafeInteger(worldHours) || worldHours < 0) throw new Error('invalid world hours');
    await this.#flush();
    await this.#settlePeriodicWork();
    for (let h = 0; h < worldHours; h++) {
      this.#writer.assertActive();
      const start = this.world.now();
      const appearances = new Map(this.world.agents.filter((a) => a.alive).map((a) => [a.id,
        encounterAppearance(a, this.world.species.get(a.speciesId)!.body.adultMassKg)]));
      const startPositions = new Map(this.world.agents.filter((a) => a.alive && a.position)
        .map((a) => [a.id, { ...a.position! }]));
      this.world.step(1);
      const community = this.world.community;
      if (community?.motion) this.#pendingHumanMotion.push({ community: structuredClone(community), motion: structuredClone(community.motion) });
      this.#pendingMovementIndex = indexLiveMovements(this.world.log.all(), appearances, start, this.world.agents, startPositions);
      this.#pendingEncounterFrame = {
        id: `${this.#streamId}:${this.world.now()}`, startWorldTime: start, endWorldTime: this.world.now(),
        rate: this.worldHoursPerRealHour, elapsedWorldSeconds: 0,
        encounters: collectLiveEncounters(this.world.log.all(), appearances, start),
        movements: selectLiveMovements(this.#pendingMovementIndex),
      };
      this.#worldHoursSinceSnapshot++;
      this.#worldHoursSinceTrack++;
      this.#worldHoursSinceHousekeeping++;
      await this.#settlePeriodicWork();
    }
    await this.#flush();
  }

  /** A failed track/archive/checkpoint is retried at the same world time, before another step. */
  async #settlePeriodicWork(): Promise<void> {
    if (this.#worldHoursSinceTrack >= this.#options.trackEveryWorldHours) {
      await this.#sampleTracks();
      this.#worldHoursSinceTrack = 0;
    }
    if (this.#worldHoursSinceHousekeeping >= this.#options.housekeepingEveryWorldHours) {
      await this.#housekeeping();
      this.#worldHoursSinceHousekeeping = 0;
    }
    if (this.#worldHoursSinceSnapshot >= this.#options.snapshotEveryWorldHours) await this.#snapshotNow();
  }

  /** Where every animal is and how it is, for life replay (spec §11). */
  async #sampleTracks(): Promise<void> {
    const now = this.world.now();
    await this.#life.appendTracks(this.world.agents.filter((a) => a.alive).map((a) => ({
      id: a.id, worldTime: now, patchId: a.patchId, state: a.state, goal: a.currentGoal, drives: a.drives,
      position: a.position,
    })));
  }

  /**
   * Keeps a world that runs for years from outgrowing its disk and memory. Routine events past
   * their window are pruned (the life story survives in the rest and in the tracks), and the
   * long departed are archived first and only then released from the running world.
   */
  async #housekeeping(): Promise<void> {
    await this.#flush();
    const now = this.world.now();
    await this.#life.pruneRoutine(now - this.#options.routineRetentionWorldDays * 86_400);
    // A season of full detail, then daily, then weekly: enough to replay any life.
    await this.#life.thinTracks(now, 90, 730);
    const cutoff = now - this.#options.archiveAfterWorldDays * 86_400;
    const leaving = this.world.deceased.filter((a) => (a.departedAt ?? Infinity) < cutoff);
    if (leaving.length === 0) return;
    await this.#life.archive(leaving);
    this.world.releaseDeceased(cutoff);
  }

  /** Runs the world in real time at the configured acceleration. */
  start(): void {
    if (!this.isWriterActive) throw new Error('world host is not running');
    this.#writer.assertActive();
    if (this.#timer !== null) return;
    const realMsPerWorldHour = 3_600_000 / this.#options.worldHoursPerRealHour;
    this.#schedule = { wallMs: Date.now(), worldTime: this.world.now() };
    const tick = (): void => {
      if (this.#ticking) { this.stats.ticksSkipped++; return; }
      this.#ticking = true;
      const startedAt = performance.now();
      void this.advance(1)
        .then(() => {
          this.#consecutiveTickFailures = 0; if (this.isWriterActive) this.lastError = null;
          const seconds = (performance.now() - startedAt) / 1000;
          this.stats.lastTickSeconds = seconds;
          this.stats.maxTickSeconds = Math.max(this.stats.maxTickSeconds, seconds);
        })
        .catch((error: unknown) => {
          this.stats.tickFailures++;
          this.#consecutiveTickFailures++;
          this.lastError = error instanceof Error ? error.message : String(error);
        })
        .finally(() => { this.#ticking = false; });
    };
    this.#timer = setInterval(tick, realMsPerWorldHour);
    // A restored world has no recorded hour to play, so without this every wild animal would
    // stand still until the first interval ends (an hour, in the real-time world).
    if (this.#encounterFrame === null) { this.#schedule.worldTime += 3600; tick(); }
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#serial(async () => {
      if (this.#timer !== null) clearInterval(this.#timer);
      this.#timer = null;
      if (this.#lifecycle === 'closed') return;
      try { if (this.#lifecycle === 'running') await this.#snapshotNow(); }
      finally { this.#lifecycle = 'closed'; await this.#writer.release(); }
    });
  }

  /** Release ownership without saving volatile state; recovery uses the last durable checkpoint. */
  async abort(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#serial(async () => {
      if (this.#timer !== null) clearInterval(this.#timer);
      this.#timer = null;
      this.#lifecycle = 'closed';
      await this.#writer.release();
    });
  }
}
