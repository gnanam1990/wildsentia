import {
  NUTRIENT_PER_KG_BIOMASS, PATCH_COUNT, WORLD_SECONDS_PER_HOUR,
  createRng, seasonAt,
  type Agent, type Carcass, type DeathCause, type Patch, type Rng,
  type RngState, type SpeciesConfig, type WorldTime,
} from '@vana/shared';
import { buildGrid } from './grid.js';
import { loadSpeciesDir } from './config/loader.js';
import { growPlants } from './fields/plants.js';
import { updateWater } from './fields/water.js';
import { decayCarcass, isSpent, makeCarcass } from './fields/decomposition.js';
import { totalNutrients, type NutrientLedger } from './fields/nutrients.js';
import { EventLog } from './events/log.js';
import { updateDrives } from './agents/drives.js';
import { perceive, type WorldView } from './agents/perception.js';
import { selectGoal } from './agents/goals.js';
import { executeGoal, type WorldServices } from './agents/behaviours.js';

export const SIM_VERSION = 'sim_0.2.0';

export interface WorldOptions {
  seed: number;
  speciesDir: string;
  initialAgents: Record<string, number>;
  minPopulation: Record<string, number>;
  /** Bound the in-memory event buffer for long runs. Defaults to keeping everything. */
  retainEvents?: number | 'all';
}

export class World {
  readonly patches: Patch[];
  readonly agents: Agent[] = [];
  readonly carcasses: Carcass[] = [];
  readonly log: EventLog;
  readonly ledger: NutrientLedger = { imported: 0, exported: 0 };
  readonly species: Map<string, SpeciesConfig>;

  #time: WorldTime = 0;
  #agentSeq = 0;
  #carcassSeq = 0;
  readonly #rng: Rng;
  readonly #options: WorldOptions;
  readonly #agentsByPatch = new Map<number, Agent[]>();
  readonly #carcassesByPatch = new Map<number, Carcass[]>();

  constructor(options: WorldOptions) {
    this.#options = options;
    this.#rng = createRng(options.seed, 'world');
    this.patches = buildGrid(options.seed);
    this.species = loadSpeciesDir(options.speciesDir);
    this.log = new EventLog(options.seed, SIM_VERSION, { retain: options.retainEvents ?? 'all' });

    for (const [speciesId, count] of Object.entries(options.initialAgents)) {
      for (let i = 0; i < count; i++) this.#spawn(speciesId, false);
    }
  }

  now(): WorldTime { return this.#time; }

  livingCount(speciesId: string): number {
    return this.agents.reduce((n, a) => n + (a.alive && a.speciesId === speciesId ? 1 : 0), 0);
  }

  totalNutrients(): number {
    return totalNutrients(this.patches, this.agents, this.ledger, this.carcasses);
  }

  /** @internal — used only by the snapshot codec. */
  __exportState(): { time: WorldTime; agentSeq: number; carcassSeq: number; seed: number; rngState: RngState } {
    return {
      time: this.#time, agentSeq: this.#agentSeq, carcassSeq: this.#carcassSeq,
      seed: this.#options.seed, rngState: this.#rng.exportState(),
    };
  }

  /** @internal — used only by the snapshot codec. */
  __importState(time: WorldTime, agentSeq: number, rngState: RngState, carcassSeq = 0): void {
    this.#time = time;
    this.#agentSeq = agentSeq;
    this.#carcassSeq = carcassSeq;
    this.#rng.importState(rngState);
  }

  #view(): WorldView {
    return {
      patches: this.patches,
      agentsInPatch: (patchId) => this.#agentsByPatch.get(patchId) ?? [],
      carcassesInPatch: (patchId) => this.#carcassesByPatch.get(patchId) ?? [],
      speciesOf: (speciesId) => this.species.get(speciesId)!,
    };
  }

  #services(): WorldServices {
    return {
      kill: (victim, cause, killerId) => this.#kill(victim, cause, killerId),
      removeCarcassIfSpent: (carcass) => {
        if (!isSpent(carcass)) return;
        this.#retireCarcass(carcass);
      },
    };
  }

  #reindex(): void {
    this.#agentsByPatch.clear();
    for (const agent of this.agents) {
      if (!agent.alive) continue;
      const list = this.#agentsByPatch.get(agent.patchId);
      if (list) list.push(agent);
      else this.#agentsByPatch.set(agent.patchId, [agent]);
    }
    this.#carcassesByPatch.clear();
    for (const carcass of this.carcasses) {
      const list = this.#carcassesByPatch.get(carcass.patchId);
      if (list) list.push(carcass);
      else this.#carcassesByPatch.set(carcass.patchId, [carcass]);
    }
  }

  #spawn(speciesId: string, immigrant: boolean): Agent {
    const cfg = this.species.get(speciesId);
    if (!cfg) throw new Error(`unknown species: ${speciesId}`);

    const patchId = this.#rng.int(PATCH_COUNT);
    const agent: Agent = {
      id: `${speciesId}_${(this.#agentSeq++).toString(16).padStart(4, '0')}`,
      speciesId, bornAt: this.#time, massKg: cfg.body.adultMassKg, patchId,
      state: 'resting', currentGoal: 'wander', alternativeGoal: null, goalScore: 0,
      targetId: null, stamina: 1,
      drives: {
        hunger: this.#rng.range(0.1, 0.5), thirst: this.#rng.range(0.1, 0.5),
        fatigue: this.#rng.range(0.1, 0.4), fear: 0,
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

  /** Death creates a carcass. The animal record is never deleted; it becomes history. */
  #kill(agent: Agent, cause: DeathCause, killerId: string | null): Carcass {
    agent.alive = false;
    agent.state = 'dead';

    const carcass = makeCarcass(
      `carc_${(this.#carcassSeq++).toString(16).padStart(4, '0')}`,
      agent.id, agent.speciesId, agent.patchId, this.#time,
      cause, cause === 'predation' ? 'authoritative' : 'high',
      agent.massKg,
    );
    this.carcasses.push(carcass);

    const actors = killerId === null ? [agent.id] : [agent.id, killerId];
    this.log.append({
      type: 'died', worldTime: this.#time, simVersion: SIM_VERSION, patchId: agent.patchId,
      actors, conditions: { cause, hunger: agent.drives.hunger, thirst: agent.drives.thirst },
      outcome: 'success', effects: { massKg: agent.massKg },
      causalParents: [], confidence: 'authoritative',
    });
    this.log.append({
      type: 'carcass_created', worldTime: this.#time, simVersion: SIM_VERSION, patchId: agent.patchId,
      actors: [carcass.id, agent.id],
      conditions: { species: agent.speciesId, cause },
      outcome: 'success', effects: { massKg: agent.massKg, scentRadiusM: carcass.scentRadiusM },
      causalParents: [], confidence: 'authoritative',
    });
    return carcass;
  }

  #retireCarcass(carcass: Carcass): void {
    const index = this.carcasses.indexOf(carcass);
    if (index < 0) return;
    // Whatever is left goes to the soil, so nothing leaves the world unaccounted for.
    const remaining =
      carcass.biomass.muscle + carcass.biomass.organ + carcass.biomass.hide + carcass.biomass.bone;
    this.patches[carcass.patchId]!.soilNutrients += remaining * NUTRIENT_PER_KG_BIOMASS;
    carcass.biomass = { muscle: 0, organ: 0, hide: 0, bone: 0 };
    this.carcasses.splice(index, 1);

    this.log.append({
      type: 'nutrients_returned', worldTime: this.#time, simVersion: SIM_VERSION,
      patchId: carcass.patchId, actors: [carcass.id],
      conditions: { species: carcass.speciesId, daysDead: (this.#time - carcass.diedAt) / 86400 },
      outcome: 'success', effects: { kg: remaining },
      causalParents: [], confidence: 'authoritative',
    });
  }

  step(hours: number): void {
    const season = seasonAt(this.#time);

    for (const patch of this.patches) {
      updateWater(patch, hours, season);
      growPlants(patch, hours, season);
    }

    for (const carcass of [...this.carcasses]) {
      const result = decayCarcass(carcass, this.patches[carcass.patchId]!, hours, season);
      if (result.stageChanged) {
        this.log.append({
          type: 'carcass_stage', worldTime: this.#time, simVersion: SIM_VERSION,
          patchId: carcass.patchId, actors: [carcass.id],
          conditions: { species: carcass.speciesId, stage: result.stage },
          outcome: 'success', effects: { removedKg: result.removedKg },
          causalParents: [], confidence: 'authoritative',
        });
      }
      if (isSpent(carcass)) this.#retireCarcass(carcass);
    }

    this.#reindex();
    const view = this.#view();
    const services = this.#services();

    for (const agent of this.agents) {
      if (!agent.alive) continue;
      const cfg = this.species.get(agent.speciesId)!;

      updateDrives(agent, cfg, hours);
      agent.stamina = Math.min(1, (agent.stamina ?? 1) + 0.04 * hours);

      if (agent.drives.hunger >= 1) { this.#kill(agent, 'starvation', null); continue; }
      if (agent.drives.thirst >= 1) { this.#kill(agent, 'dehydration', null); continue; }
      if (this.#rng.bool(cfg.lifecycle.baselineMortalityPerDay * (hours / 24))) {
        this.#kill(agent, 'senescence', null);
        continue;
      }

      const percept = perceive(agent, cfg, view);

      // An animal that can see a predator hunting it becomes afraid, and where the species
      // shares alarm, so does everything else of its kind standing with it.
      if (percept.threat !== null) {
        agent.drives.fear = Math.min(1, agent.drives.fear + 0.3 * hours);
        if (cfg.social.alarmSharing) {
          for (const other of view.agentsInPatch(agent.patchId)) {
            if (other.alive && other.speciesId === agent.speciesId && other.id !== agent.id) {
              other.drives.fear = Math.min(1, Math.max(other.drives.fear, agent.drives.fear * 0.7));
            }
          }
        }
      }

      const choice = selectGoal(agent, cfg, percept, this.#rng);
      executeGoal({
        agent, species: cfg, patches: this.patches, view, percept, choice,
        hours, worldTime: this.#time, log: this.log, rng: this.#rng, services,
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
