import type { WorldEvent } from '@vana/shared';
import {
  SIM_VERSION, createWorld, restoreSnapshot, takeSnapshot, type World,
} from '@vana/sim';
import type { Pool } from './db/pool.js';
import { EventStore } from './db/eventStore.js';
import { SnapshotStore } from './db/snapshotStore.js';

export interface SimHostOptions {
  pool: Pool;
  seed: number;
  speciesDir: string;
  /** Live acceleration. 24 means one world hour every 2.5 real minutes. */
  worldHoursPerRealHour?: number;
  snapshotEveryWorldHours?: number;
  initialAgents?: Record<string, number>;
  minPopulation?: Record<string, number>;
}

export interface BootResult {
  restoredFrom: number | null;
  rolledBackEvents: number;
}

export class SimHost {
  world!: World;

  readonly #events: EventStore;
  readonly #snapshots: SnapshotStore;
  readonly #options: Required<SimHostOptions>;
  #publishedEventCount = 0;
  #worldHoursSinceSnapshot = 0;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;

  constructor(options: SimHostOptions) {
    this.#options = {
      worldHoursPerRealHour: 24,
      snapshotEveryWorldHours: 1,
      initialAgents: { sambar: 60 },
      minPopulation: { sambar: 20 },
      ...options,
    };
    this.#events = new EventStore(options.pool);
    this.#snapshots = new SnapshotStore(options.pool);
  }

  get worldOptions(): {
    seed: number; speciesDir: string;
    initialAgents: Record<string, number>; minPopulation: Record<string, number>;
  } {
    return {
      seed: this.#options.seed,
      speciesDir: this.#options.speciesDir,
      initialAgents: this.#options.initialAgents,
      minPopulation: this.#options.minPopulation,
    };
  }

  async boot(): Promise<BootResult> {
    const snapshot = await this.#snapshots.loadLatest();

    if (snapshot === null) {
      this.world = createWorld(this.worldOptions);
      this.#publishedEventCount = 0;
      await this.flush();
      return { restoredFrom: null, rolledBackEvents: 0 };
    }

    if (snapshot.simVersion !== SIM_VERSION) {
      throw new Error(
        `refusing to boot: snapshot ${snapshot.simVersion} predates runtime ${SIM_VERSION}`,
      );
    }

    this.world = restoreSnapshot(snapshot, this.worldOptions);
    this.#publishedEventCount = this.world.log.size();

    // Events written after the newest snapshot belong to a timeline that did not survive the
    // restart. Remove them and say so out loud rather than leaving an inconsistent history.
    const orphaned = await this.#events.countAfter(snapshot.worldTime);
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

  /** Writes any simulation events not yet persisted. */
  async flush(): Promise<void> {
    const all = this.world.log.all();
    if (all.length <= this.#publishedEventCount) return;
    const pending = all.slice(this.#publishedEventCount) as WorldEvent[];
    await this.#events.appendBatch(pending);
    this.#publishedEventCount = all.length;
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
      if (this.#worldHoursSinceSnapshot >= this.#options.snapshotEveryWorldHours) {
        await this.snapshotNow();
      }
    }
    await this.flush();
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
