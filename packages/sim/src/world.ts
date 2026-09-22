import {
  NUTRIENT_PER_KG_BIOMASS, PATCH_COUNT, WORLD_SECONDS_PER_HOUR,
  createRng, seasonAt,
  type Agent, type Patch, type Rng, type SpeciesConfig, type WorldTime,
} from '@vana/shared';
import { buildGrid } from './grid.js';
import { loadSpeciesDir } from './config/loader.js';
import { growPlants } from './fields/plants.js';
import { updateWater } from './fields/water.js';
import { totalNutrients, type NutrientLedger } from './fields/nutrients.js';
import { EventLog } from './events/log.js';
import { updateDrives } from './agents/drives.js';
import { perceive } from './agents/perception.js';
import { selectGoal } from './agents/goals.js';
import { executeGoal } from './agents/behaviours.js';

export const SIM_VERSION = 'sim_0.1.0';

export interface WorldOptions {
  seed: number;
  speciesDir: string;
  initialAgents: Record<string, number>;
  minPopulation: Record<string, number>;
}

export class World {
  readonly patches: Patch[];
  readonly agents: Agent[] = [];
  readonly log: EventLog;
  readonly ledger: NutrientLedger = { imported: 0, exported: 0 };
  readonly species: Map<string, SpeciesConfig>;

  #time: WorldTime = 0;
  #agentSeq = 0;
  readonly #rng: Rng;
  readonly #options: WorldOptions;

  constructor(options: WorldOptions) {
    this.#options = options;
    this.#rng = createRng(options.seed, 'world');
    this.patches = buildGrid(options.seed);
    this.species = loadSpeciesDir(options.speciesDir);
    this.log = new EventLog(options.seed, SIM_VERSION);

    for (const [speciesId, count] of Object.entries(options.initialAgents)) {
      for (let i = 0; i < count; i++) this.#spawn(speciesId, false);
    }
  }

  now(): WorldTime {
    return this.#time;
  }

  livingCount(speciesId: string): number {
    return this.agents.reduce((n, a) => n + (a.alive && a.speciesId === speciesId ? 1 : 0), 0);
  }

  totalNutrients(): number {
    return totalNutrients(this.patches, this.agents, this.ledger);
  }

  /** @internal — used only by the snapshot codec. */
  __exportState(): { time: WorldTime; agentSeq: number; seed: number } {
    return { time: this.#time, agentSeq: this.#agentSeq, seed: this.#options.seed };
  }

  /** @internal — used only by the snapshot codec. */
  __importState(time: WorldTime, agentSeq: number): void {
    this.#time = time;
    this.#agentSeq = agentSeq;
  }

  #spawn(speciesId: string, immigrant: boolean): Agent {
    const cfg = this.species.get(speciesId);
    if (!cfg) throw new Error(`unknown species: ${speciesId}`);

    const patchId = this.#rng.int(PATCH_COUNT);
    const agent: Agent = {
      id: `${speciesId}_${(this.#agentSeq++).toString(16).padStart(4, '0')}`,
      speciesId,
      bornAt: this.#time,
      massKg: cfg.body.adultMassKg,
      patchId,
      state: 'resting',
      currentGoal: 'wander',
      alternativeGoal: null,
      goalScore: 0,
      drives: {
        hunger: this.#rng.range(0.1, 0.5),
        thirst: this.#rng.range(0.1, 0.5),
        fatigue: this.#rng.range(0.1, 0.4),
        fear: 0,
      },
      alive: true,
    };
    this.agents.push(agent);

    if (immigrant) this.ledger.imported += agent.massKg * NUTRIENT_PER_KG_BIOMASS;

    this.log.append({
      type: immigrant ? 'immigration' : 'agent_spawned',
      worldTime: this.#time, simVersion: SIM_VERSION, patchId,
      actors: [agent.id], conditions: { species: speciesId },
      outcome: 'success', effects: { massKg: agent.massKg },
      causalParents: [], confidence: 'authoritative',
    });
    return agent;
  }

  #kill(agent: Agent, cause: 'starved' | 'died'): void {
    agent.alive = false;
    agent.state = 'dead';
    // M1 simplification: the body returns directly to patch soil. M4 replaces this with a carcass.
    this.patches[agent.patchId]!.soilNutrients += agent.massKg * NUTRIENT_PER_KG_BIOMASS;

    this.log.append({
      type: cause, worldTime: this.#time, simVersion: SIM_VERSION, patchId: agent.patchId,
      actors: [agent.id],
      conditions: { hunger: agent.drives.hunger, thirst: agent.drives.thirst },
      outcome: 'success', effects: { massKg: agent.massKg },
      causalParents: [], confidence: 'authoritative',
    });
  }

  step(hours: number): void {
    const season = seasonAt(this.#time);

    for (const patch of this.patches) {
      updateWater(patch, hours, season);
      growPlants(patch, hours, season);
    }

    for (const agent of this.agents) {
      if (!agent.alive) continue;
      const cfg = this.species.get(agent.speciesId)!;

      updateDrives(agent, cfg, hours);

      if (agent.drives.hunger >= 1 || agent.drives.thirst >= 1) {
        this.#kill(agent, 'starved');
        continue;
      }
      if (this.#rng.bool(cfg.lifecycle.baselineMortalityPerDay * (hours / 24))) {
        this.#kill(agent, 'died');
        continue;
      }

      const percept = perceive(agent, this.patches, cfg);
      const choice = selectGoal(agent, percept, this.#rng);
      executeGoal({
        agent, species: cfg, patches: this.patches, percept, choice,
        hours, worldTime: this.#time, log: this.log, rng: this.#rng,
      });
    }

    for (const [speciesId, floor] of Object.entries(this.#options.minPopulation)) {
      while (this.livingCount(speciesId) < floor) this.#spawn(speciesId, true);
    }

    this.#time += hours * WORLD_SECONDS_PER_HOUR;
  }
}

export function createWorld(options: WorldOptions): World {
  return new World(options);
}
