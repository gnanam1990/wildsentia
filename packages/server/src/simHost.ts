import type { WorldEvent } from '@vana/shared';
import {
  FOREST_FLOOR, FOREST_LANDSCAPE, FOREST_POPULATION, SIM_VERSION,
  createWorld, restoreSnapshot, takeSnapshot, type World, type WorldOptions,
} from '@vana/sim';
import type { Pool } from './db/pool.js';
import { EventStore } from './db/eventStore.js';
import { SnapshotStore } from './db/snapshotStore.js';
import { LifeStore } from './db/lifeStore.js';

export interface SimHostOptions {
  pool: Pool;
  seed: number;
  speciesDir: string;
  /** Live acceleration. 24 means one world hour every 2.5 real minutes. */
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

export class SimHost {
  world!: World;

  readonly #events: EventStore;
  readonly #snapshots: SnapshotStore;
  readonly #life: LifeStore;
  #worldHoursSinceTrack = 0;
  #worldHoursSinceHousekeeping = 0;
  readonly #options: Required<SimHostOptions>;
  #worldHoursSinceSnapshot = 0;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;

  constructor(options: SimHostOptions) {
    this.#options = {
      worldHoursPerRealHour: 24,
      snapshotEveryWorldHours: 1,
      trackEveryWorldHours: 6,
      housekeepingEveryWorldHours: 24,
      routineRetentionWorldDays: 3,
      archiveAfterWorldDays: 730,
      initialAgents: FOREST_POPULATION,
      minPopulation: FOREST_FLOOR,
      landscape: FOREST_LANDSCAPE,
      ...options,
    };
    this.#events = new EventStore(options.pool);
    this.#snapshots = new SnapshotStore(options.pool);
    this.#life = new LifeStore(options.pool);
  }

  get worldOptions(): WorldOptions {
    return {
      seed: this.#options.seed,
      speciesDir: this.#options.speciesDir,
      initialAgents: this.#options.initialAgents,
      minPopulation: this.#options.minPopulation,
      ...(this.#options.landscape === null ? {} : { landscape: this.#options.landscape }),
    };
  }

  async boot(): Promise<BootResult> {
    const snapshot = await this.#snapshots.loadLatest();

    if (snapshot === null) {
      this.world = createWorld(this.worldOptions);
      await this.flush();
      return { restoredFrom: null, rolledBackEvents: 0 };
    }

    if (snapshot.simVersion !== SIM_VERSION) {
      throw new Error(
        `refusing to boot: snapshot ${snapshot.simVersion} predates runtime ${SIM_VERSION}`,
      );
    }

    this.world = restoreSnapshot(snapshot, this.worldOptions);

    // Events written after the newest snapshot belong to a timeline that did not survive the
    // restart. Remove them and say so out loud rather than leaving an inconsistent history.
    const orphaned = await this.#events.countAfter(snapshot.worldTime);
    await this.#life.deleteTracksAfter(snapshot.worldTime);
    if (orphaned > 0) {
      await this.#events.deleteAfter(snapshot.worldTime);
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

    return { restoredFrom: snapshot.worldTime, rolledBackEvents: orphaned };
  }

  /**
   * Drains the simulation's event buffer into Postgres. Taking rather than copying is what keeps
   * a world that runs for months from filling the heap with its own history.
   */
  async flush(): Promise<void> {
    const pending: WorldEvent[] = this.world.log.take();
    if (pending.length === 0) return;
    await this.#events.appendBatch(pending);
  }

  async snapshotNow(): Promise<void> {
    await this.flush();
    await this.#snapshots.save(takeSnapshot(this.world));
    await this.#snapshots.prune(48);
    this.#worldHoursSinceSnapshot = 0;
  }

  async advance(worldHours: number): Promise<void> {
    for (let h = 0; h < worldHours; h++) {
      this.world.step(1);
      this.#worldHoursSinceSnapshot++;
      if (++this.#worldHoursSinceTrack >= this.#options.trackEveryWorldHours) {
        this.#worldHoursSinceTrack = 0;
        await this.#sampleTracks();
      }
      if (++this.#worldHoursSinceHousekeeping >= this.#options.housekeepingEveryWorldHours) {
        this.#worldHoursSinceHousekeeping = 0;
        await this.#housekeeping();
      }
      if (this.#worldHoursSinceSnapshot >= this.#options.snapshotEveryWorldHours) {
        await this.snapshotNow();
      }
    }
    await this.flush();
  }

  /** Where every animal is and how it is, for life replay (spec §11). */
  async #sampleTracks(): Promise<void> {
    const now = this.world.now();
    await this.#life.appendTracks(this.world.agents.filter((a) => a.alive).map((a) => ({
      id: a.id, worldTime: now, patchId: a.patchId, state: a.state, goal: a.currentGoal, drives: a.drives,
    })));
  }

  /**
   * Keeps a world that runs for years from outgrowing its disk and memory. Routine events past
   * their window are pruned (the life story survives in the rest and in the tracks), and the
   * long departed are archived first and only then released from the running world.
   */
  async #housekeeping(): Promise<void> {
    await this.flush();
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
    if (this.#timer !== null) return;
    const realMsPerWorldHour = 3_600_000 / this.#options.worldHoursPerRealHour;
    this.#timer = setInterval(() => {
      if (this.#ticking) return;
      this.#ticking = true;
      void this.advance(1).finally(() => { this.#ticking = false; });
    }, realMsPerWorldHour);
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.snapshotNow();
  }
}
