import {
  NUTRIENT_PER_KG_BIOMASS, PATCH_COUNT, WORLD_SECONDS_PER_DAY, WORLD_SECONDS_PER_HOUR,
  createRng, seasonAt,
  type Agent, type Carcass, type DeathCause, type Patch, type Rng, type SkillId,
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
import { foundingTraits } from './agents/genetics.js';
import { Pedigree } from './agents/pedigree.js';
import { mortalityFor, stageFor, targetMass } from './agents/lifecycle.js';
import { isFloater } from './agents/territory.js';
import { decaySkills, experiencedSkills, recordOutcome, teach } from './agents/learning.js';
import { EDGE_PATCHES, EDGE_PATCH_IDS, expectedExchange } from './landscape.js';
import {
  assessMate, attemptCourtship, birth, conceive, endOestrus, isReadyToGiveBirth, isReceptive,
  packAllowsBreeding,
} from './agents/reproduction.js';

export const SIM_VERSION = 'sim_0.5.0';

export interface WorldOptions {
  seed: number;
  speciesDir: string;
  initialAgents: Record<string, number>;
  minPopulation: Record<string, number>;
  /** Bound the in-memory event buffer for long runs. Defaults to keeping everything. */
  retainEvents?: number | 'all';
  /**
   * The country around this forest. `regional` is how many of each species a stretch this size
   * holds out there; animals cross the edge in proportion to the difference, at `exchangePerDay`.
   */
  landscape?: { regional: Record<string, number>; exchangePerDay: number };
}

export class World {
  readonly patches: Patch[];
  /** Living animals only. The dead move to `deceased` so they leave every per-tick loop. */
  readonly agents: Agent[] = [];
  /** Permanent record. A death removes an animal from the world, never from its history. */
  readonly deceased: Agent[] = [];
  readonly carcasses: Carcass[] = [];
  readonly log: EventLog;
  readonly ledger: NutrientLedger = { imported: 0, exported: 0 };
  readonly species: Map<string, SpeciesConfig>;
  readonly pedigree = new Pedigree();
  readonly #agentsById = new Map<string, Agent>();
  readonly #livingBySpecies = new Map<string, number>();
  births = 0;

  #time: WorldTime = 0;
  #agentSeq = 0;
  #carcassSeq = 0;
  readonly #rng: Rng;
  readonly #options: WorldOptions;
  readonly #agentsByPatch = new Map<number, Agent[]>();
  /** Herds, troops, packs and families: the spec's group entity, kept light. */
  readonly #groups = new Map<string, { speciesId: string; memberIds: string[] }>();
  #groupSeq = 0;
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
    return this.#livingBySpecies.get(speciesId) ?? 0;
  }

  totalNutrients(): number {
    return totalNutrients(this.patches, this.agents, this.ledger, this.carcasses);
  }

  /** @internal — used only by the snapshot codec. */
  __exportState(): {
    time: WorldTime; agentSeq: number; carcassSeq: number; groupSeq: number;
    seed: number; rngState: RngState;
    groups: Array<[string, { speciesId: string; memberIds: string[] }]>;
    pedigree: ReturnType<Pedigree['toJSON']>;
  } {
    return {
      time: this.#time, agentSeq: this.#agentSeq, carcassSeq: this.#carcassSeq,
      groupSeq: this.#groupSeq,
      seed: this.#options.seed, rngState: this.#rng.exportState(),
      groups: [...this.#groups.entries()],
      pedigree: this.pedigree.toJSON(),
    };
  }

  /**
   * @internal — used only by the snapshot codec.
   *
   * Everything the world carries has to come back, not just the clock: without the groups a
   * restored herd forgets it is a herd, and without the pedigree it forgets who its parents
   * were and will happily breed with its own sibling.
   */
  __importState(
    time: WorldTime,
    agentSeq: number,
    rngState: RngState,
    carcassSeq = 0,
    groupSeq = 0,
    groups: Array<[string, { speciesId: string; memberIds: string[] }]> = [],
    pedigreeEntries: ReturnType<Pedigree['toJSON']> = [],
  ): void {
    this.#time = time;
    this.#agentSeq = agentSeq;
    this.#carcassSeq = carcassSeq;
    this.#groupSeq = groupSeq;
    this.#rng.importState(rngState);

    this.#groups.clear();
    for (const [groupId, group] of groups) this.#groups.set(groupId, group);

    this.pedigree.clear();
    for (const [childId, parents] of pedigreeEntries) {
      this.pedigree.record(childId, parents.mother, parents.father);
    }

    // Rebuild the indexes that are derived from the agent list.
    this.#agentsById.clear();
    this.#livingBySpecies.clear();
    for (const agent of this.agents) {
      this.#agentsById.set(agent.id, agent);
      if (agent.alive) {
        this.#livingBySpecies.set(
          agent.speciesId, (this.#livingBySpecies.get(agent.speciesId) ?? 0) + 1,
        );
      }
    }
    for (const agent of this.deceased) this.#agentsById.set(agent.id, agent);
  }

  #view(): WorldView {
    return {
      patches: this.patches,
      agentsInPatch: (patchId) => this.#agentsByPatch.get(patchId) ?? [],
      carcassesInPatch: (patchId) => this.#carcassesByPatch.get(patchId) ?? [],
      speciesOf: (speciesId) => this.species.get(speciesId)!,
      groupPatch: (groupId) => this.#groupPatch(groupId),
    };
  }

  #services(): WorldServices {
    return {
      kill: (victim, cause, killerId) => this.#kill(victim, cause, killerId),
      removeCarcassIfSpent: (carcass) => {
        if (!isSpent(carcass)) return;
        this.#retireCarcass(carcass);
      },
      practised: (agent, skill, success) => this.#practised(agent, skill, success),
    };
  }

  /**
   * An animal used a skill. It learns from the outcome, and when it went well, any young still
   * depending on it — always beside it — learn by watching (spec §8.2). A lesson that moves a
   * pupil across a tenth is recorded, so who taught whom can be read back years later.
   */
  #practised(agent: Agent, skill: SkillId, success: boolean): void {
    const cfg = this.species.get(agent.speciesId)!;
    recordOutcome(agent, cfg, skill, success, this.#time);
    if (!success) return;
    for (const childId of agent.offspringIds) {
      const child = this.#agentsById.get(childId);
      if (child === undefined || !child.alive || child.dependentOn !== agent.id) continue;
      if (!teach(child, agent, cfg, skill, this.#time)) continue;
      this.log.append({
        type: 'skill_taught', worldTime: this.#time, simVersion: SIM_VERSION,
        patchId: child.patchId, actors: [child.id, agent.id],
        conditions: { skill, species: agent.speciesId },
        outcome: 'success', effects: { confidence: child.skills?.[skill]?.confidence ?? 0 },
        causalParents: [], confidence: 'authoritative',
      });
    }
  }

  /** Where a group is: the patch holding the most of its living members. */
  #groupPatch(groupId: string): number | null {
    const group = this.#groups.get(groupId);
    if (group === undefined) return null;

    const byPatch = new Map<number, number>();
    for (const memberId of group.memberIds) {
      const member = this.#agentsById.get(memberId);
      if (member === undefined || !member.alive) continue;
      byPatch.set(member.patchId, (byPatch.get(member.patchId) ?? 0) + 1);
    }

    let bestPatch: number | null = null;
    let bestCount = 0;
    for (const [patchId, count] of byPatch) {
      if (count > bestCount) { bestCount = count; bestPatch = patchId; }
    }
    return bestPatch;
  }

  #assignGroup(agent: Agent, cfg: SpeciesConfig): void {
    const structure = cfg.social.structure;
    if (structure === 'solitary') return;

    const [, max] = cfg.social.groupSize;
    for (const [groupId, group] of this.#groups) {
      if (group.speciesId !== agent.speciesId) continue;
      const living = group.memberIds.filter((id) => this.#agentsById.get(id)?.alive === true).length;
      if (living >= max) continue;
      group.memberIds.push(agent.id);
      agent.groupId = groupId;
      // Join the group where it stands, rather than appearing somewhere it is not.
      const home = this.#groupPatch(groupId);
      if (home !== null) agent.patchId = home;
      return;
    }

    const groupId = `${agent.speciesId}_grp_${(this.#groupSeq++).toString(16)}`;
    this.#groups.set(groupId, { speciesId: agent.speciesId, memberIds: [agent.id] });
    agent.groupId = groupId;
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

  #spawn(speciesId: string, immigrant: boolean, atEdge = false): Agent {
    const cfg = this.species.get(speciesId);
    if (!cfg) throw new Error(`unknown species: ${speciesId}`);

    const patchId = atEdge
      ? EDGE_PATCH_IDS[this.#rng.int(EDGE_PATCH_IDS.length)]!
      : this.#rng.int(PATCH_COUNT);
    // Founders and immigrants arrive as adults of a spread of ages, so a population does not
    // reach sexual maturity in lockstep.
    const ageDays = cfg.lifecycle.sexualMaturityDays
      + this.#rng.range(0, cfg.lifecycle.maxAgeDays * 0.35);
    const agent: Agent = {
      id: `${speciesId}_${(this.#agentSeq++).toString(16).padStart(4, '0')}`,
      speciesId, bornAt: this.#time, massKg: cfg.body.adultMassKg, patchId,
      state: 'resting', currentGoal: 'wander', alternativeGoal: null, goalScore: 0,
      targetId: null, stamina: 1,
      sex: this.#rng.bool(0.5) ? 'female' : 'male',
      ageDays,
      lifeStage: stageFor(ageDays, cfg),
      traits: foundingTraits(this.#rng),
      motherId: null, fatherId: null, generation: 0,
      dependentOn: null, pregnantSince: null, lastBirthAt: null, offspringIds: [],
      skills: experiencedSkills(cfg, this.#rng, this.#time),
      drives: {
        hunger: this.#rng.range(0.05, 0.35), thirst: this.#rng.range(0.05, 0.35),
        fatigue: this.#rng.range(0.1, 0.4), fear: 0,
      },
      alive: true,
    };
    this.agents.push(agent);
    this.#agentsById.set(agent.id, agent);
    this.#livingBySpecies.set(speciesId, (this.#livingBySpecies.get(speciesId) ?? 0) + 1);
    this.pedigree.record(agent.id, null, null);
    this.#assignGroup(agent, cfg);
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
    this.#livingBySpecies.set(
      agent.speciesId, Math.max(0, (this.#livingBySpecies.get(agent.speciesId) ?? 1) - 1),
    );

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

  /** Looks for a mate in the same patch. Returns true when courtship consumed the tick. */
  #tryBreed(agent: Agent, cfg: SpeciesConfig, view: ReturnType<World['__viewForTest']>): boolean {
    if (!isReceptive(agent, cfg, this.#time)) return false;
    // Only females carry the pregnancy, so only they initiate here; males are assessed.
    if (agent.sex !== 'female') return false;
    if (agent.groupId != null) {
      const group = this.#groups.get(agent.groupId);
      const packmates = (group?.memberIds ?? [])
        .map((id) => this.#agentsById.get(id))
        .filter((member): member is Agent => member !== undefined);
      const hasDependants = (mother: Agent): boolean => mother.offspringIds.some((id) => {
        const child = this.#agentsById.get(id);
        return child !== undefined && child.alive && child.dependentOn === mother.id;
      });
      if (!packAllowsBreeding(agent, cfg, packmates, hasDependants)) return false;
    }

    // Look across the patch and its neighbours. Animals three hundred metres apart are well
    // within sight of one another; confining courtship to a single patch made mating a matter
    // of luck rather than of being in the same herd.
    let best: ReturnType<typeof assessMate> = null;
    let bestPatchId = agent.patchId;
    for (const patchId of [agent.patchId, ...this.patches[agent.patchId]!.neighbours]) {
      for (const other of view.agentsInPatch(patchId)) {
        if (!other.alive || other.speciesId !== agent.speciesId) continue;
        if (!isReceptive(other, cfg, this.#time)) continue;
        const assessment = assessMate(agent, other, this.pedigree);
        if (assessment !== null && (best === null || assessment.score > best.score)) {
          best = assessment;
          bestPatchId = patchId;
        }
      }
    }
    if (best === null) return false;
    // Go to him rather than courting across a field.
    if (bestPatchId !== agent.patchId) { agent.patchId = bestPatchId; return true; }

    // Crowding is measured over the patch and its neighbours, which is the range an animal
    // can actually perceive.
    let localDensity = 0;
    for (const patchId of [agent.patchId, ...this.patches[agent.patchId]!.neighbours]) {
      for (const other of view.agentsInPatch(patchId)) {
        if (other.alive && other.speciesId === agent.speciesId) localDensity++;
      }
    }
    const groupMax = cfg.social.groupSize[1];
    const succeeded = attemptCourtship(agent, best.candidate, this.#rng, localDensity, groupMax);
    this.log.append({
      type: 'courtship', worldTime: this.#time, simVersion: SIM_VERSION, patchId: agent.patchId,
      actors: [agent.id, best.candidate.id],
      conditions: { species: agent.speciesId, relatedness: best.relatedness },
      outcome: succeeded ? 'success' : 'failure', effects: {},
      causalParents: [], confidence: 'authoritative',
    });
    if (!succeeded) { endOestrus(agent, cfg, this.#time); return true; }

    conceive(agent, best.candidate, this.#time);
    return true;
  }

  #giveBirth(mother: Agent, cfg: SpeciesConfig): void {
    const fatherId = mother.targetId;
    const father = fatherId == null ? null : this.#agentsById.get(fatherId) ?? null;

    const result = birth(
      mother, father, cfg, this.patches[mother.patchId]!, this.pedigree, this.#rng, this.#time,
      () => `${mother.speciesId}_${(this.#agentSeq++).toString(16).padStart(4, '0')}`,
    );

    for (const child of result.newborns) {
      this.agents.push(child);
      this.#agentsById.set(child.id, child);
      this.#livingBySpecies.set(
        child.speciesId, (this.#livingBySpecies.get(child.speciesId) ?? 0) + 1,
      );
      // A calf belongs to its mother's herd from birth.
      if (mother.groupId != null) {
        child.groupId = mother.groupId;
        this.#groups.get(mother.groupId)?.memberIds.push(child.id);
      }
      this.births++;
      this.log.append({
        type: 'born', worldTime: this.#time, simVersion: SIM_VERSION, patchId: child.patchId,
        actors: [child.id, mother.id, ...(father === null ? [] : [father.id])],
        conditions: {
          species: child.speciesId, sex: child.sex, generation: child.generation,
          coatVariant: child.traits.coatVariant,
        },
        outcome: 'success', effects: { massKg: child.massKg },
        causalParents: [], confidence: 'authoritative',
      });
    }

    if (result.newborns.length === 0) {
      this.log.append({
        type: 'courtship', worldTime: this.#time, simVersion: SIM_VERSION, patchId: mother.patchId,
        actors: [mother.id], conditions: { reason: 'no_nutrients_for_litter' },
        outcome: 'failure', effects: {}, causalParents: [], confidence: 'authoritative',
      });
    }
  }

  #exchangeWithLandscape(hours: number): void {
    const landscape = this.#options.landscape;
    if (landscape === undefined) return;

    for (const [speciesId, regional] of Object.entries(landscape.regional)) {
      const expected = expectedExchange(
        this.livingCount(speciesId), regional, landscape.exchangePerDay, hours,
      );
      const whole = Math.floor(Math.abs(expected));
      const count = whole + (this.#rng.bool(Math.abs(expected) - whole) ? 1 : 0);
      for (let i = 0; i < count; i++) {
        if (expected > 0) this.#spawn(speciesId, true, true);
        else if (!this.#emigrate(speciesId)) break;
      }
    }
  }

  /** One independent animal standing at the edge walks out. False when none is there to go. */
  #emigrate(speciesId: string): boolean {
    const raisingYoung = (agent: Agent): boolean => agent.offspringIds.some((id) => {
      const child = this.#agentsById.get(id);
      return child !== undefined && child.alive && child.dependentOn === agent.id;
    });
    const leavers = this.agents.filter((agent) =>
      agent.alive && agent.speciesId === speciesId && EDGE_PATCHES.has(agent.patchId)
      && agent.dependentOn === null && agent.pregnantSince === null && !raisingYoung(agent));
    if (leavers.length === 0) return false;

    const agent = leavers[this.#rng.int(leavers.length)]!;
    agent.alive = false;
    agent.state = 'emigrated';
    this.#livingBySpecies.set(speciesId, Math.max(0, (this.#livingBySpecies.get(speciesId) ?? 1) - 1));
    // Its body leaves with it, so the ledger records what went out of the forest.
    this.ledger.exported += agent.massKg * NUTRIENT_PER_KG_BIOMASS;
    this.log.append({
      type: 'emigration', worldTime: this.#time, simVersion: SIM_VERSION, patchId: agent.patchId,
      actors: [agent.id], conditions: { species: speciesId },
      outcome: 'success', effects: { massKg: agent.massKg },
      causalParents: [], confidence: 'authoritative',
    });
    return true;
  }

  /** @internal — lets the breed helper share the world view type. */
  __viewForTest(): WorldView { return this.#view(); }

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

    // Move the tick's dead into the permanent record and out of every loop that follows.
    if (this.agents.some((a) => !a.alive)) {
      for (let i = this.agents.length - 1; i >= 0; i--) {
        const agent = this.agents[i]!;
        if (agent.alive) continue;
        this.deceased.push(agent);
        this.agents.splice(i, 1);
      }
    }

    this.#reindex();
    const view = this.#view();
    const services = this.#services();

    // Rivals for range, gathered once a tick for the species that hold territories.
    const rangeHolders = new Map<string, Agent[]>();
    for (const agent of this.agents) {
      if (!agent.alive || this.species.get(agent.speciesId)!.social.territory === undefined) continue;
      const list = rangeHolders.get(agent.speciesId);
      if (list === undefined) rangeHolders.set(agent.speciesId, [agent]);
      else list.push(agent);
    }

    for (const agent of this.agents) {
      if (!agent.alive) continue;
      const cfg = this.species.get(agent.speciesId)!;

      updateDrives(agent, cfg, hours);
      decaySkills(agent, cfg, hours, this.#time);
      agent.stamina = Math.min(1, (agent.stamina ?? 1) + 0.04 * hours);

      agent.ageDays += hours / 24;
      const stage = stageFor(agent.ageDays, cfg);
      if (stage !== agent.lifeStage) {
        agent.lifeStage = stage;
        this.log.append({
          type: 'life_stage', worldTime: this.#time, simVersion: SIM_VERSION,
          patchId: agent.patchId, actors: [agent.id],
          conditions: { stage, species: agent.speciesId },
          outcome: 'success', effects: { ageDays: agent.ageDays },
          causalParents: [], confidence: 'authoritative',
        });
      }

      // Growth builds tissue out of what the animal ate, which the feeding model already
      // returned to the soil. Drawing it back keeps the ledger exact.
      const target = targetMass(agent, cfg);
      if (agent.massKg < target) {
        const growth = Math.min(target - agent.massKg, target * 0.004 * hours);
        const patch = this.patches[agent.patchId]!;
        const affordable = Math.min(growth, Math.max(0, patch.soilNutrients) / NUTRIENT_PER_KG_BIOMASS);
        agent.massKg += affordable;
        patch.soilNutrients -= affordable * NUTRIENT_PER_KG_BIOMASS;
      }

      // Dependants follow their mother and are fed by her; they do not forage for themselves.
      if (agent.dependentOn !== null) {
        const mother = this.#agentsById.get(agent.dependentOn);
        if (mother === undefined || !mother.alive) {
          // An orphan is on its own from here. It keeps whatever it already knows.
          agent.dependentOn = null;
        } else if (agent.ageDays >= cfg.lifecycle.dispersalDays) {
          agent.dependentOn = null;
          this.log.append({
            type: 'dispersed', worldTime: this.#time, simVersion: SIM_VERSION,
            patchId: agent.patchId, actors: [agent.id, mother.id],
            conditions: { species: agent.speciesId, ageDays: agent.ageDays },
            outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative',
          });
        } else {
          agent.patchId = mother.patchId;
          agent.drives.hunger = Math.min(agent.drives.hunger, mother.drives.hunger);
          agent.drives.thirst = Math.min(agent.drives.thirst, mother.drives.thirst);
        }
      }

      if (agent.ageDays >= cfg.lifecycle.maxAgeDays) { this.#kill(agent, 'senescence', null); continue; }
      if (agent.drives.hunger >= 1) { this.#kill(agent, 'starvation', null); continue; }
      if (agent.drives.thirst >= 1) { this.#kill(agent, 'dehydration', null); continue; }
      // The per-stage hazard is not old age — a newborn dying at six times the adult rate has
      // not died of senescence — so it is recorded as what it is.
      if (this.#rng.bool(mortalityFor(agent, cfg) * (hours / 24))) {
        this.#kill(agent, 'natural', null);
        continue;
      }

      // A floater lives in someone else's range: it does not breed, and it is killed in a fight
      // or pushed out of the forest far more often than a resident is.
      const territory = cfg.social.territory;
      const floater = territory !== undefined
        && isFloater(agent, cfg, rangeHolders.get(agent.speciesId) ?? [], this.patches);
      if (floater && this.#rng.bool(territory.floaterMortalityPerDay * (hours / 24))) {
        this.#kill(agent, 'territorial', null);
        continue;
      }

      if (isReadyToGiveBirth(agent, cfg, this.#time)) { this.#giveBirth(agent, cfg); continue; }
      if (!floater && this.#tryBreed(agent, cfg, view)) continue;

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

    this.#exchangeWithLandscape(hours);

    for (const [speciesId, floor] of Object.entries(this.#options.minPopulation)) {
      while (this.livingCount(speciesId) < floor) this.#spawn(speciesId, true);
    }

    this.#time += hours * WORLD_SECONDS_PER_HOUR;
  }
}

export function createWorld(options: WorldOptions): World {
  return new World(options);
}
