import {
  NUTRIENT_PER_KG_BIOMASS, PATCH_COUNT, WORLD_SECONDS_PER_DAY, WORLD_SECONDS_PER_HOUR,
  createRng, seasonAt, carcassMass, landWalkable, treeAnchorForPatch, type TerrainProfile,
  type Agent, type Carcass, type DeathCause, type Patch, type Rng, type SkillId,
  type RngState, type SpeciesConfig, type WorldTime, type WaterBudget, type MicroEcologyState, type CommunityState, type CommunityProfile,
} from '@vana/shared';
import { buildGrid } from './grid.js';
import { loadSpeciesDir } from './config/loader.js';
import { growPlants } from './fields/plants.js';
import { newWaterBudget, updateDrainage } from './fields/drainage.js';
import { decayCarcass, isSpent, makeCarcass } from './fields/decomposition.js';
import { totalNutrients, type NutrientLedger } from './fields/nutrients.js';
import { emptyMicroEcology, seedMicroEcology, stepMicroEcology } from './fields/microEcology.js';
import { establishFloweringGuild, stepFloweringGuild } from './fields/floweringGuild.js';
import { EventLog } from './events/log.js';
import { foundCommunity, stepCommunity } from './community.js';
import { updateDrives } from './agents/drives.js';
import { perceive, type WorldView } from './agents/perception.js';
import { selectGoal } from './agents/goals.js';
import { descendPerchedAnimal, executeGoal, type WorldServices } from './agents/behaviours.js';
import { foundingTraits } from './agents/genetics.js';
import { Pedigree } from './agents/pedigree.js';
import { mortalityFor, stageFor, targetMass } from './agents/lifecycle.js';
import { needsProvisioning, canFollowParent, careRadius, inCareContact } from './agents/needs.js';
import { availableForCare, chooseCareTarget, finishCare, travelToFamily, type FamilyLocation, type CareVisit } from './agents/family.js';
import { establishNursingSites, nursingEligible } from './agents/nursing.js';
import { choosePackRecipient, packDonorEligible, canWaitForPackFood, beginPackCollection, finishPackCollection,
  beginPackDelivery, finishPackDelivery, digestPackFood, type PackCollection, type PackDelivery } from './agents/packCare.js';
import { isFloater } from './agents/territory.js';
import { decaySkills, experiencedSkills, recordOutcome, teach } from './agents/learning.js';
import { advanceIllness } from './agents/illness.js';
import { advanceWound } from './agents/wound.js';
import { EDGE_PATCHES, EDGE_PATCH_IDS, expectedExchange } from './landscape.js';
import { locateAgent, locateCarcass, placeBeside } from './agents/spatial.js';
import { approachMate, finishCourtship, type CourtshipVisit } from './agents/courtship.js';
import {
  assessMate, birth, isReadyToGiveBirth, isReceptive,
  packAllowsBreeding,
} from './agents/reproduction.js';

export const SIM_VERSION = 'sim_0.30.0';

/** Uncalibrated group-decision policy, not a claim of a species-specific thirst measurement.
 * An unweaned independent drinker need not leave a nearby caregiver every hour for a sip. */
const DEPENDENT_URGENT_THIRST = 0.5;
const DEPENDENT_URGENT_HUNGER = 0.65;

export interface WorldOptions {
  communityProfile?: CommunityProfile;
  /** New worlds only. Restored households retain their saved rules version. */
  initialCommunityRulesVersion?: 2 | 3 | 4 | 5 | 6 | 7 | 8;
  terrainProfile?: TerrainProfile;
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
  community: CommunityState | null = null;
  readonly terrainProfile: TerrainProfile;
  readonly patches: Patch[];
  /** Living animals only. The dead move to `deceased` so they leave every per-tick loop. */
  readonly agents: Agent[] = [];
  /** Permanent record. A death removes an animal from the world, never from its history. */
  readonly deceased: Agent[] = [];
  readonly carcasses: Carcass[] = [];
  readonly log: EventLog;
  readonly ledger: NutrientLedger = { imported: 0, exported: 0 };
  /** Population-level organisms; notable animals remain individual agents. */
  microEcology: MicroEcologyState;
  waterBudget: WaterBudget;
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
    if (options.communityProfile !== undefined && !['none', 'household_v1'].includes(options.communityProfile))
      throw new Error('unknown community profile');
    if (options.initialCommunityRulesVersion !== undefined && ![2, 3, 4, 5, 6, 7, 8].includes(options.initialCommunityRulesVersion))
      throw new Error('unsupported initial community rules');
    this.terrainProfile = options.terrainProfile ?? 'mainland';
    if (this.terrainProfile !== 'mainland' && this.terrainProfile !== 'island_v1') throw new Error('unknown terrain profile');
    if (this.terrainProfile === 'island_v1' && !Number.isSafeInteger(options.seed)) throw new Error('island seed must be a safe integer');
    if (this.terrainProfile === 'island_v1' && (options.landscape || Object.values(options.minPopulation).some(n => n !== 0)))
      throw new Error('island worlds require closed population policy: no floors or mainland exchange');
    this.#options = options;
    this.#rng = createRng(options.seed, 'world');
    this.patches = buildGrid(options.seed, this.terrainProfile);
    this.microEcology = seedMicroEcology(this.patches, 0);
    establishFloweringGuild(this.patches, 0);
    this.waterBudget = newWaterBudget(this.patches, 0);
    this.species = loadSpeciesDir(options.speciesDir);
    this.log = new EventLog(options.seed, SIM_VERSION, { retain: options.retainEvents ?? 'all' });

    for (const [speciesId, count] of Object.entries(options.initialAgents)) {
      const founders: Agent[] = [];
      for (let i = 0; i < count; i++) founders.push(this.#spawn(speciesId, false));
      // A closed island starts with just two tigers and has no immigration/rescue floor.
      // Preserve every random draw and the first founder; only correct the second founder
      // when random sex assignment made the entire founding cohort unable to breed.
      if (this.terrainProfile === 'island_v1' && speciesId === 'tiger' && founders.length >= 2
        && founders.every(agent => agent.sex === founders[0]!.sex)) {
        founders[1]!.sex = founders[0]!.sex === 'female' ? 'male' : 'female';
      }
    }
    if (options.communityProfile === 'household_v1') this.community = foundCommunity(this.patches, options.seed, this.log, options.initialCommunityRulesVersion);
  }

  now(): WorldTime { return this.#time; }

  livingCount(speciesId: string): number {
    return this.#livingBySpecies.get(speciesId) ?? 0;
  }

  totalNutrients(): number {
    return totalNutrients(this.patches, this.agents, this.ledger, this.carcasses, this.microEcology, this.community);
  }

  /** @internal — used only by the snapshot codec. */
  __exportState(): {
    time: WorldTime; agentSeq: number; carcassSeq: number; groupSeq: number;
    seed: number; rngState: RngState;
    groups: Array<[string, { speciesId: string; memberIds: string[] }]>;
    pedigree: ReturnType<Pedigree['toJSON']>;
    microEcology: MicroEcologyState;
  } {
    return {
      time: this.#time, agentSeq: this.#agentSeq, carcassSeq: this.#carcassSeq,
      groupSeq: this.#groupSeq,
      seed: this.#options.seed, rngState: this.#rng.exportState(),
      groups: [...this.#groups.entries()],
      pedigree: this.pedigree.toJSON(),
      microEcology: structuredClone(this.microEcology),
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
    microEcology: MicroEcologyState | undefined = undefined,
  ): void {
    this.#time = time;
    this.#agentSeq = agentSeq;
    this.#carcassSeq = carcassSeq;
    this.#groupSeq = groupSeq;
    this.#rng.importState(rngState);
    this.microEcology = microEcology ? structuredClone(microEcology) : emptyMicroEcology(this.patches, time);

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
      locateAgent(agent);
      this.#agentsById.set(agent.id, agent);
      if (agent.alive) {
        this.#livingBySpecies.set(
          agent.speciesId, (this.#livingBySpecies.get(agent.speciesId) ?? 0) + 1,
        );
      }
    }
    for (const agent of this.deceased) { locateAgent(agent); this.#agentsById.set(agent.id, agent); }
    for (const carcass of this.carcasses) locateCarcass(carcass);
  }

  #view(): WorldView {
    return {
      patches: this.patches,
      agentsInPatch: (patchId) => (this.#agentsByPatch.get(patchId) ?? []).filter((a) => a.alive && a.patchId === patchId),
      agentById: (id) => this.#agentsById.get(id),
      carcassesInPatch: (patchId) => this.#carcassesByPatch.get(patchId) ?? [],
      speciesOf: (speciesId) => this.species.get(speciesId)!,
      groupPatch: (groupId) => this.#groupPatch(groupId),
    };
  }

  #services(): WorldServices {
    return {
      consumedWater: (litres) => { this.waterBudget.animalConsumptionL += litres; },
      kill: (victim, cause, killerId, context) => this.#kill(victim, cause, killerId, context),
      removeCarcassIfSpent: (carcass) => {
        if (!isSpent(carcass)) return;
        this.#retireCarcass(carcass);
      },
      practised: (agent, skill, success) => this.#practised(agent, skill, success),
    };
  }

  /**
   * An animal used a skill. It learns from the outcome, and when it went well, any young still
   * depending on it and locally within sight learn by watching (spec §8.2). A lesson that moves a
   * pupil across a tenth is recorded, so who taught whom can be read back years later.
   */
  #practised(agent: Agent, skill: SkillId, success: boolean): void {
    const cfg = this.species.get(agent.speciesId)!;
    recordOutcome(agent, cfg, skill, success, this.#time);
    if (!success) return;
    for (const childId of agent.offspringIds) {
      const child = this.#agentsById.get(childId);
      if (child === undefined || !child.alive || child.dependentOn !== agent.id) continue;
      const parentPosition = locateAgent(agent), childPosition = locateAgent(child);
      // A family ID is not evidence of observation. This is a bounded line-of-sight proxy;
      // obstacle occlusion and full action-window overlap remain separate work.
      const observationRadius = Math.min(20, cfg.senses.sightRangeM);
      if (child.patchId !== agent.patchId || Math.hypot(parentPosition.x - childPosition.x,
        parentPosition.z - childPosition.z) > observationRadius) continue;
      if (!teach(child, agent, cfg, skill, this.#time)) continue;
      this.log.append({
        type: 'skill_taught', worldTime: this.#time, simVersion: SIM_VERSION,
        patchId: child.patchId, actors: [child.id, agent.id],
        conditions: { skill, species: agent.speciesId, observationRadiusM: observationRadius },
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

    const eligibleLand = this.terrainProfile === 'island_v1' ? this.patches.filter(landWalkable) : null;
    if (eligibleLand && !eligibleLand.length) throw new Error('island has no founding habitat');
    const patchId = eligibleLand ? eligibleLand[this.#rng.int(eligibleLand.length)]!.id : atEdge
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
    locateAgent(agent);
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
  #kill(agent: Agent, cause: DeathCause, killerId: string | null, context?: { at: number; causalParent?: string }): Carcass {
    const at = context?.at ?? this.#time;
    const parents = context?.causalParent ? [context.causalParent] : [];
    // Carcasses have ground x/z positions, not a vertical state. A tree death is a
    // death-time gravity collapse at the same trunk, recorded explicitly; a dead agent
    // must not persist as a hovering climber after its carcass is grounded.
    const deathAltitudeM = agent.locomotionMode === 'climb' ? agent.altitudeM ?? 0 : 0;
    if (deathAltitudeM > 0) {
      delete agent.altitudeM; delete agent.locomotionMode; delete agent.treeAnchorId;
    }
    agent.alive = false;
    agent.state = 'dead';
    agent.departedAt = at;
    this.#livingBySpecies.set(
      agent.speciesId, Math.max(0, (this.#livingBySpecies.get(agent.speciesId) ?? 1) - 1),
    );

    const carcass = makeCarcass(
      `carc_${(this.#carcassSeq++).toString(16).padStart(4, '0')}`,
      agent.id, agent.speciesId, agent.patchId, at,
      cause, cause === 'predation' ? 'authoritative' : 'high',
      agent.massKg,
    );
    carcass.position = { ...locateAgent(agent) };
    const carried = agent.packFood;
    if (carried) {
      carcass.biomass.ingesta = carried.kg;
      carcass.originalMassKg += carried.kg;
      delete agent.packFood;
    }
    this.carcasses.push(carcass);

    const actors = killerId === null ? [agent.id] : [agent.id, killerId];
    this.log.append({
      type: 'died', worldTime: at, simVersion: SIM_VERSION, patchId: agent.patchId,
      position: { ...carcass.position! },
      actors, conditions: { cause, hunger: agent.drives.hunger, thirst: agent.drives.thirst,
        ...(deathAltitudeM > 0 ? { deathAltitudeM, fallPolicy: 'death_time_gravity_collapse' } : {}),
        lifeStage: agent.lifeStage, species: agent.speciesId, ageDays: agent.ageDays,
        careState: !needsProvisioning(agent, this.species.get(agent.speciesId)!) ? 'weaned'
          : this.#agentsById.get(agent.dependentOn ?? '')?.alive ? 'unweaned_with_parent' : 'unweaned_without_parent' },
      outcome: 'success', effects: { massKg: agent.massKg,
        ...(deathAltitudeM > 0 ? { fallDistanceM: deathAltitudeM } : {}) },
      causalParents: parents, confidence: 'authoritative',
    });
    this.log.append({
      type: 'carcass_created', worldTime: at, simVersion: SIM_VERSION, patchId: agent.patchId,
      position: { ...carcass.position! },
      actors: [carcass.id, agent.id],
      conditions: { species: agent.speciesId, cause, ...(carried ? { foodSourceCarcassId: carried.sourceCarcassId } : {}) },
      outcome: 'success', effects: { massKg: carcass.originalMassKg, scentRadiusM: carcass.scentRadiusM,
        ...(carried ? { ingestaKg: carried.kg } : {}) },
      causalParents: [...parents, ...(carried ? [carried.sourceEventId] : [])], confidence: 'authoritative',
    });
    return carcass;
  }

  /** A mate approach consumes real movement time, never a patch-only teleport. */
  #tryBreed(agent: Agent, cfg: SpeciesConfig, view: ReturnType<World['__viewForTest']>,
    starts: ReadonlyMap<string, FamilyLocation>, processed: ReadonlySet<string>, hours: number,
    visits: CourtshipVisit[], maleVisits: Map<string, CourtshipVisit>): boolean {
    if (!isReceptive(agent, cfg, this.#time)) return false;
    // Only females carry the pregnancy, so only they initiate here; males are assessed.
    if (agent.sex !== 'female') return false;
    if (!this.#packAllowsBreeding(agent, cfg)) return false;

    // Coarse perception policy: same/adjacent patches AND within a configured sensory range.
    // Use the recorded start location, never a mate's future end-of-decision position.
    let best: ReturnType<typeof assessMate> = null;
    const here = locateAgent(agent), senseRange = Math.max(cfg.senses.sightRangeM, cfg.senses.hearingRangeM, cfg.senses.smellRangeM);
    for (const patchId of [agent.patchId, ...this.patches[agent.patchId]!.neighbours]) {
      for (const other of view.agentsInPatch(patchId)) {
        if (!other.alive || other.speciesId !== agent.speciesId || (other.altitudeM ?? 0) > 0) continue;
        if (!isReceptive(other, cfg, this.#time)) continue;
        const target = starts.get(other.id);
        if (!target || !landWalkable(this.patches[target.patchId])
          || Math.hypot(here.x - target.position.x, here.z - target.position.z) > senseRange) continue;
        // A partner who already used this hour cannot be pursued at a stale start location.
        // A stationary resting male is still available; a moving/feeding male is not.
        if (processed.has(other.id) && (other.currentGoal !== 'rest'
          || other.patchId !== target.patchId
          || Math.hypot(locateAgent(other).x - target.position.x,
            locateAgent(other).z - target.position.z) > 1e-6)) continue;
        const assessment = assessMate(agent, other, this.pedigree);
        if (assessment !== null && (best === null || assessment.score > best.score)) {
          best = assessment;
        }
      }
    }
    if (best === null) return false;
    const visit = approachMate(agent, best.candidate, starts.get(best.candidate.id)!, cfg, this.patches,
      this.#time, hours, best.relatedness, this.log);
    visits.push(visit);
    const prior = maleVisits.get(best.candidate.id);
    if (!prior || visit.arrival < prior.arrival) maleVisits.set(best.candidate.id, visit);
    return true;
  }

  #packAllowsBreeding(agent: Agent, cfg: SpeciesConfig): boolean {
    if (agent.groupId == null) return true;
    const group = this.#groups.get(agent.groupId);
    const packmates = (group?.memberIds ?? []).map(id => this.#agentsById.get(id))
      .filter((member): member is Agent => member !== undefined);
    return packAllowsBreeding(agent, cfg, packmates, mother => mother.offspringIds.some(id => {
      const child = this.#agentsById.get(id);
      return child !== undefined && child.alive && child.dependentOn === mother.id;
    }));
  }

  #giveBirth(mother: Agent, cfg: SpeciesConfig): void {
    const fatherId = mother.pregnancyFatherId;
    const father = fatherId == null ? null : this.#agentsById.get(fatherId) ?? null;

    const result = birth(
      mother, father, cfg, this.patches[mother.patchId]!, this.pedigree, this.#rng, this.#time,
      () => `${mother.speciesId}_${(this.#agentSeq++).toString(16).padStart(4, '0')}`,
    );

    for (const child of result.newborns) {
      // Spawn one compact litter within nursing reach. The former minimum one-metre ring
      // spread tiny leverets/pups beyond contact, forcing mutually exclusive all-hour visits.
      // This is an initial birth anchor, never a recurring dependent-position correction.
      placeBeside(child, locateAgent(mother), careRadius(cfg) * 0.25);
      if (cfg.lifecycle.nursing) child.nursingSite = { patchId: mother.patchId,
        position: { ...locateAgent(mother) }, establishedAt: this.#time, origin: 'birth' };
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
        position: { ...locateAgent(child) },
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
      && agent.dependentOn === null && agent.pregnantSince === null && !raisingYoung(agent)
      && (agent.altitudeM ?? 0) === 0);
    if (leavers.length === 0) return false;

    const agent = leavers[this.#rng.int(leavers.length)]!;
    agent.alive = false;
    agent.state = 'emigrated';
    agent.departedAt = this.#time;
    // Landscape exchange runs at the end of a tick. Move the departed animal immediately so
    // the public living-agent view never carries a stale emigrated record until the next tick.
    const index = this.agents.indexOf(agent);
    if (index >= 0) this.agents.splice(index, 1);
    this.deceased.push(agent);
    this.#livingBySpecies.set(speciesId, Math.max(0, (this.#livingBySpecies.get(speciesId) ?? 1) - 1));
    // Its body leaves with it, so the ledger records what went out of the forest.
    this.ledger.exported += (agent.massKg + (agent.packFood?.kg ?? 0)) * NUTRIENT_PER_KG_BIOMASS;
    this.log.append({
      type: 'emigration', worldTime: this.#time, simVersion: SIM_VERSION, patchId: agent.patchId,
      actors: [agent.id], conditions: { species: speciesId },
      outcome: 'success', effects: { massKg: agent.massKg, ...(agent.packFood ? { carriedFoodKg: agent.packFood.kg } : {}) },
      causalParents: [], confidence: 'authoritative',
    });
    return true;
  }

  /**
   * Removes and returns the dead and departed who left before `before`, so a long-running host
   * can archive them and keep memory and snapshots from growing without end. Anything that left
   * recently stays: a pregnancy can still name a dead father until it comes to term.
   */
  releaseDeceased(before: WorldTime): Agent[] {
    const released: Agent[] = [];
    for (let i = this.deceased.length - 1; i >= 0; i--) {
      const agent = this.deceased[i]!;
      if ((agent.departedAt ?? Infinity) >= before) continue;
      released.push(agent);
      this.deceased.splice(i, 1);
      this.#agentsById.delete(agent.id);
    }
    return released.reverse();
  }

  /** @internal — lets the breed helper share the world view type. */
  __viewForTest(): WorldView { return this.#view(); }

  #retireCarcass(carcass: Carcass): void {
    const index = this.carcasses.indexOf(carcass);
    if (index < 0) return;
    // Whatever is left goes to the soil, so nothing leaves the world unaccounted for.
    const remaining = carcassMass(carcass.biomass);
    this.patches[carcass.patchId]!.soilNutrients += remaining * NUTRIENT_PER_KG_BIOMASS;
    carcass.biomass = { muscle: 0, organ: 0, hide: 0, bone: 0 };
    this.carcasses.splice(index, 1);

    const at = Math.max(this.#time, carcass.diedAt);
    this.log.append({
      type: 'nutrients_returned', worldTime: at, simVersion: SIM_VERSION,
      patchId: carcass.patchId, actors: [carcass.id],
      conditions: { species: carcass.speciesId, daysDead: (at - carcass.diedAt) / 86400 },
      outcome: 'success', effects: { kg: remaining },
      causalParents: [], confidence: 'authoritative',
    });
  }

  step(hours: number): void {
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('step hours must be finite and positive');
    // All ecological cohorts and encounters use the same hourly decision boundary. Long
    // calls cannot skip a fish or contact gate or count an hour twice.
    if (hours > 1) {
      let remaining = hours;
      while (remaining > 1) { this.step(1); remaining -= 1; }
      if (remaining > 0) this.step(remaining);
      return;
    }
    for (const agent of this.agents) locateAgent(agent);
    const season = seasonAt(this.#time);

    updateDrainage(this.patches, hours, season, this.waterBudget);
    for (const patch of this.patches) {
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

    const fishTransitions = stepMicroEcology(this.microEcology, this.patches, this.carcasses, hours, season, this.#time);
    const floweringTransitions = stepFloweringGuild(this.patches, this.microEcology,
      hours, this.#time + hours * WORLD_SECONDS_PER_HOUR);

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
    const familyStarts = new Map<string, FamilyLocation>(this.agents.map((a) =>
      [a.id, { patchId: a.patchId, position: { ...locateAgent(a) } }]));
    const childrenByParent = new Map<string, Agent[]>();
    for (const child of this.agents) {
      if (!child.dependentOn) continue;
      const siblings = childrenByParent.get(child.dependentOn) ?? [];
      siblings.push(child); childrenByParent.set(child.dependentOn, siblings);
    }
    const careTargets = new Map<string, Agent>();
    for (const [id, children] of childrenByParent) {
      const parent = this.#agentsById.get(id);
      if (!parent) continue;
      const cfg = this.species.get(parent.speciesId)!;
      establishNursingSites(parent, children, cfg, this.#time, this.log);
      const target = chooseCareTarget(parent, children, cfg, this.#time, hours);
      if (target) careTargets.set(id, target);
    }
    const careVisits: CareVisit[] = [];
    const deferredYoungNeeds: Array<{ agent: Agent; cfg: SpeciesConfig; choice: ReturnType<typeof selectGoal> }> = [];
    const courtshipVisits: CourtshipVisit[] = [];
    const maleCourtshipVisits = new Map<string, CourtshipVisit>();
    const processedAgents = new Set<string>();
    const nursingArrivals = new Map<string, CareVisit>();
    const activeNursingParents = () => new Set([...childrenByParent].filter(([, children]) => children.some(c =>
      c.alive && c.dependentOn !== null && needsProvisioning(c, this.species.get(c.speciesId)!))).map(([id]) => id));
    const nursingParents = activeNursingParents(), packTargets = new Map<string, Agent>(), packWaiters = new Set<string>();
    const packCollections: PackCollection[] = [], packDeliveries: PackDelivery[] = [];
    for (const donor of this.agents) {
      const cfg = this.species.get(donor.speciesId)!;
      const recipient = choosePackRecipient(donor, this.agents, cfg, nursingParents);
      if (!recipient) continue;
      packTargets.set(donor.id, recipient);
      if (canWaitForPackFood(donor, familyStarts.get(recipient.id)!, cfg, this.patches, this.#time, hours)) packWaiters.add(recipient.id);
    }

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
      processedAgents.add(agent.id);
      const cfg = this.species.get(agent.speciesId)!;

      updateDrives(agent, cfg, hours);
      digestPackFood(agent, cfg, this.patches[agent.patchId]!, this.#time, this.log);
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
      if (agent.massKg < target && agent.drives.hunger < 0.7 && agent.drives.thirst < 0.7) {
        const growth = Math.min(target - agent.massKg, target * 0.004 * hours);
        const patch = this.patches[agent.patchId]!;
        const affordable = Math.min(growth, Math.max(0, patch.soilNutrients) / NUTRIENT_PER_KG_BIOMASS);
        agent.massKg += affordable;
        patch.soilNutrients -= affordable * NUTRIENT_PER_KG_BIOMASS;
      }

      // Family association persists to dispersal; reserve provisioning stops at weaning.
      if (agent.dependentOn !== null) {
        const mother = this.#agentsById.get(agent.dependentOn);
        if (mother === undefined || !mother.alive) {
          // Record the loss; age-based ability limits still apply to an orphan.
          const lostParent = agent.dependentOn;
          agent.dependentOn = null;
          this.log.append({
            type: 'parent_lost', worldTime: this.#time, simVersion: SIM_VERSION,
            patchId: agent.patchId, actors: [agent.id, lostParent],
            conditions: { species: agent.speciesId, lifeStage: agent.lifeStage },
            outcome: 'interrupted', effects: {}, causalParents: [], confidence: 'authoritative',
          });
        } else if (agent.ageDays >= cfg.lifecycle.dispersalDays) {
          agent.dependentOn = null;
          this.log.append({
            type: 'dispersed', worldTime: this.#time, simVersion: SIM_VERSION,
            patchId: agent.patchId, actors: [agent.id, mother.id],
            conditions: { species: agent.speciesId, ageDays: agent.ageDays },
            outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative',
          });
        }
      }

      if (agent.ageDays >= cfg.lifecycle.maxAgeDays) { this.#kill(agent, 'senescence', null); continue; }
      // Unweaned animals get this decision's actual care opportunity before deficit mortality.
      // Natural hazards/predation still apply, and absent/contact-failed care cannot rescue them.
      if (!needsProvisioning(agent, cfg)) {
        if (agent.drives.hunger >= 1) { this.#kill(agent, 'starvation', null); continue; }
        if (agent.drives.thirst >= 1) { this.#kill(agent, 'dehydration', null); continue; }
      }
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

      // A perched animal cannot take a ground-only action. Stay at the fixed trunk while
      // a local threat remains, then spend real time descending; depleted canopy keeps a
      // stable remnant for that descent. Urgent needs compel descent despite the threat.
      if ((agent.altitudeM ?? 0) > 0 && agent.locomotionMode === 'climb') {
        const patch = this.patches[agent.patchId]!;
        const canopyLost = treeAnchorForPatch(patch) === null;
        const threatened = perceive(agent, cfg, view).threat !== null;
        const urgentNeed = agent.drives.thirst >= 0.72 || agent.drives.hunger >= 0.8;
        if (canopyLost || !threatened || urgentNeed) {
          descendPerchedAnimal(agent, patch, this.#time, hours,
            canopyLost ? 'canopy_lost' : !threatened ? 'threat_gone' : 'urgent_need', this.log);
        } else {
          agent.currentGoal = 'rest'; agent.alternativeGoal = null; agent.goalScore = 1;
          agent.state = 'resting';
        }
        continue;
      }

      if (isReadyToGiveBirth(agent, cfg, this.#time)) { this.#giveBirth(agent, cfg); continue; }
      // The joint encounter already consumed this prey's action; physiology above still runs.
      if (agent.lastEncounterAt === this.#time) continue;
      // A male who has not spent his decision can respond to a real female approach
      // by staying at the recorded contact anchor. Urgent needs, care or territorial
      // displacement still take priority. No partner is teleported or frozen later.
      const plannedMateVisit = agent.sex === 'male' ? maleCourtshipVisits.get(agent.id) : undefined;
      const mateVisit = plannedMateVisit?.female.alive && plannedMateVisit.arrival <= this.#time + hours * 3600
        ? plannedMateVisit : undefined;
      if (mateVisit && !careTargets.has(agent.id) && !packTargets.has(agent.id) && !packWaiters.has(agent.id)
        && !floater && isReceptive(agent, cfg, this.#time + hours * 3600)
        && agent.drives.fear < 0.5 && agent.drives.hunger < 0.55 && agent.drives.thirst < 0.55) {
        agent.currentGoal = 'breed'; agent.alternativeGoal = null; agent.goalScore = 1;
        agent.targetId = mateVisit.female.id; agent.state = 'resting'; delete agent.journey;
        this.log.append({ type: 'rested', worldTime: this.#time + hours * 3600,
          simVersion: SIM_VERSION, patchId: agent.patchId, actors: [agent.id, mateVisit.female.id],
          conditions: { reason: 'await_mate', species: agent.speciesId }, outcome: 'success',
          effects: { durationHours: hours }, causalParents: mateVisit.routeId ? [mateVisit.routeId] : [],
          confidence: 'authoritative', position: { ...locateAgent(agent) } });
        continue;
      }
      if (!careTargets.has(agent.id) && !packTargets.has(agent.id) && !packWaiters.has(agent.id)
        && !floater && this.#tryBreed(agent, cfg, view, familyStarts, processedAgents, hours,
          courtshipVisits, maleCourtshipVisits)) continue;

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
      const careTarget = careTargets.get(agent.id);
      const careStart = careTarget && (cfg.lifecycle.nursing ? careTarget.nursingSite : familyStarts.get(careTarget.id));
      // Hold only for an already loaded, route-reachable pack member, not for an empty promise.
      // A local mother may keep caring; a remote mother cannot walk away and receive at her old point.
      if (packWaiters.has(agent.id) && percept.threat === null && agent.drives.thirst < 0.8
        && !(careTarget && availableForCare(agent) && inCareContact(agent, careTarget, cfg))) {
        agent.currentGoal = 'wait_for_pack_food'; agent.state = 'resting'; agent.alternativeGoal = null;
        agent.goalScore = 1; agent.targetId = null; delete agent.journey; continue;
      }
      if (careStart && careTarget?.alive && availableForCare(agent) && percept.threat === null) {
        careVisits.push(travelToFamily(agent, cfg, this.patches, careStart, 'care_for_young', this.#time, hours, this.log));
        continue;
      }
      const packRecipient = packTargets.get(agent.id);
      if (packRecipient?.alive && percept.threat === null && packDonorEligible(agent, cfg, nursingParents)) {
        if (agent.packFood) {
          const delivery = beginPackDelivery(agent, packRecipient, familyStarts.get(packRecipient.id)!, cfg,
            this.patches, this.#time, hours, this.log);
          if (delivery) { packDeliveries.push(delivery); continue; }
        } else if (percept.carrion) {
          const collection = beginPackCollection(agent, packRecipient, percept.carrion.carcass, cfg,
            this.patches, this.#time, hours, this.log);
          if (collection) { packCollections.push(collection); continue; }
        } else if (percept.prey.length) {
          // Pack demand can motivate a real hunt; no bonus success or newborn hunting ability.
          executeGoal({ agent, species: cfg, patches: this.patches, view, percept,
            choice: { goal: 'hunt', score: 1, alternative: choice.goal }, hours, worldTime: this.#time,
            log: this.log, rng: this.#rng, services });
          continue;
        }
      }
      // Follow a perceivable start-of-hour parent location, not where the parent will arrive
      // later. Infants below the species' ground-following age wait for a visit instead.
      const parent = this.#agentsById.get(agent.dependentOn ?? ''), parentStart = parent && familyStarts.get(parent.id);
      const parentTarget = parent && careTargets.get(parent.id);
      const careSite = parentTarget && familyStarts.get(parentTarget.id);
      // For source-informed mobile young, family cohesion is a real route to the selected
      // sibling's start-site, not a teleport to a parent's future endpoint. A low thirst
      // increment does not make a piglet leave the litter hourly; urgent thirst/food still
      // overrides regrouping and uses the ordinary finite resource action.
      const mobileDependent = cfg.id === 'boar' && !cfg.lifecycle.nursing && cfg.lifecycle.drinkFromDays !== undefined
        && needsProvisioning(agent, cfg) && canFollowParent(agent, cfg) && parent?.alive
        && percept.threat === null;
      const independentNeed = choice.goal === 'find_food' || choice.goal === 'find_water';
      const urgentNeed = choice.goal === 'find_water' && agent.drives.thirst >= DEPENDENT_URGENT_THIRST
        || choice.goal === 'find_food' && agent.drives.hunger >= DEPENDENT_URGENT_HUNGER;
      if (mobileDependent && !urgentNeed) {
        const rendezvous = careSite ?? parentStart;
        if (rendezvous) {
          const gap = Math.hypot(agent.position!.x - rendezvous.position.x, agent.position!.z - rendezvous.position.z);
          const sensoryReach = Math.max(cfg.senses.sightRangeM, cfg.senses.hearingRangeM, cfg.senses.smellRangeM);
          if (rendezvous.patchId === agent.patchId && gap <= careRadius(cfg)) {
            if (careSite && independentNeed) {
              // A planned care visit gets its finite contact opportunity first. Failed care
              // falls back to the youngster's original water/food choice below this loop.
              agent.currentGoal = 'rest'; agent.state = 'resting'; agent.alternativeGoal = choice.goal;
              agent.goalScore = 1; agent.targetId = null;
              deferredYoungNeeds.push({ agent, cfg, choice });
              continue;
            }
            if (!careSite && choice.goal === 'find_water') {
              agent.currentGoal = 'rest'; agent.state = 'resting'; agent.alternativeGoal = choice.goal;
              agent.goalScore = 1; agent.targetId = null;
              continue;
            }
          } else if (gap <= sensoryReach) {
            nursingArrivals.set(agent.id, travelToFamily(agent, cfg, this.patches, rendezvous,
              'follow_parent', this.#time, hours, this.log));
            continue;
          }
        }
      }
      if (parent?.alive && cfg.lifecycle.nursing && needsProvisioning(agent, cfg) && agent.nursingSite
        && agent.ageDays >= cfg.lifecycle.nursing.locomotionFromDays && percept.threat === null
        && nursingEligible(agent, cfg, this.#time, this.#time + hours * 3600)) {
        nursingArrivals.set(agent.id, travelToFamily(agent, cfg, this.patches, agent.nursingSite,
          'seek_nursing', this.#time, hours, this.log));
        continue;
      }
      if (parent?.alive && parentStart && canFollowParent(agent, cfg)
        && !careTargets.has(parent.id) && percept.threat === null && ['rest', 'wander'].includes(choice.goal)
        && (needsProvisioning(agent, cfg) || agent.drives.fatigue < 0.6)
        && Math.hypot(agent.position!.x - parentStart.position.x, agent.position!.z - parentStart.position.z)
          <= Math.max(cfg.senses.sightRangeM, cfg.senses.hearingRangeM)) {
        travelToFamily(agent, cfg, this.patches, parentStart, 'follow_parent', this.#time, hours, this.log);
        continue;
      }
      executeGoal({
        agent, species: cfg, patches: this.patches, view, percept, choice,
        hours, worldTime: this.#time, log: this.log, rng: this.#rng, services,
      });
    }

    const servedYoung = new Set<string>();
    for (const visit of careVisits) for (const childId of finishCare(visit,
      childrenByParent.get(visit.parent.id) ?? [], familyStarts,
      this.species.get(visit.parent.speciesId)!, this.#time, this.#time + hours * 3600, this.log, nursingArrivals))
      servedYoung.add(childId);
    const afterCareView = this.#view();
    for (const { agent, cfg, choice } of deferredYoungNeeds) {
      if (!agent.alive || agent.lastEncounterAt === this.#time) continue;
      if (servedYoung.has(agent.id)) { delete agent.journey; continue; }
      executeGoal({ agent, species: cfg, patches: this.patches, view: afterCareView,
        percept: perceive(agent, cfg, afterCareView), choice, hours, worldTime: this.#time,
        log: this.log, rng: this.#rng, services });
    }
    const stillNursing = activeNursingParents();
    for (const collection of packCollections) finishPackCollection(collection, this.species.get(collection.visit.parent.speciesId)!,
      this.carcasses, stillNursing, this.log);
    // Delivery is after maternal provisioning: reserves received at this hour's end cannot
    // retroactively fund milk earlier in the same decision. They are available next decision.
    for (const delivery of packDeliveries) finishPackDelivery(delivery, this.species.get(delivery.visit.parent.speciesId)!,
      this.patches, stillNursing, this.log);
    for (const agent of this.agents) {
      if (!agent.alive || !needsProvisioning(agent, this.species.get(agent.speciesId)!)) continue;
      const cause = agent.drives.hunger >= 1 ? 'starvation' : agent.drives.thirst >= 1 ? 'dehydration' : null;
      if (cause) this.#kill(agent, cause, null, { at: this.#time + hours * 3600 });
    }

    // Both partners have completed this decision. Arrival at a stale location cannot conceive.
    const matingDensity = new Map<string, Map<number, number>>();
    if (courtshipVisits.length) for (const a of this.agents) if (a.alive) {
      let counts = matingDensity.get(a.speciesId);
      if (!counts) { counts = new Map(); matingDensity.set(a.speciesId, counts); }
      counts.set(a.patchId, (counts.get(a.patchId) ?? 0) + 1);
    }
    for (const visit of courtshipVisits) {
      const local = [visit.female.patchId, ...this.patches[visit.female.patchId]!.neighbours];
      const counts = matingDensity.get(visit.female.speciesId);
      const density = local.reduce((sum, id) => sum + (counts?.get(id) ?? 0), 0);
      const cfg = this.species.get(visit.female.speciesId)!;
      // Earlier completed visits may have conceived during this same tick. Recheck admission.
      finishCourtship(visit, cfg, this.#time, this.#time + hours * 3600, density, this.#rng, this.log,
        this.#packAllowsBreeding(visit.female, cfg));
    }
    this.#exchangeWithLandscape(hours);

    for (const [speciesId, floor] of Object.entries(this.#options.minPopulation)) {
      while (this.livingCount(speciesId) < floor) this.#spawn(speciesId, true);
    }

    if (this.community) stepCommunity(this.community, this.patches, this.waterBudget, this.#time, hours * WORLD_SECONDS_PER_HOUR,
      this.log, this.microEcology, this.community.version >= 6 ? {
        boundaryAt: this.#time + hours * WORLD_SECONDS_PER_HOUR,
        nearbyPrey: (person) => this.agents.filter(a => {
          const seen = familyStarts.get(a.id);
          return !!seen && ['hare', 'chital'].includes(a.speciesId) && landWalkable(this.patches[seen.patchId])
            && Math.hypot(seen.position.x - person.position.x, seen.position.z - person.position.z) <= 70;
        }).sort((a, b) => {
          const av = familyStarts.get(a.id)!.position, bv = familyStarts.get(b.id)!.position;
          return Math.hypot(av.x - person.position.x, av.z - person.position.z)
            - Math.hypot(bv.x - person.position.x, bv.z - person.position.z) || a.id.localeCompare(b.id);
        }).map(a => ({ ...a, alive: true, patchId: familyStarts.get(a.id)!.patchId,
          position: { ...familyStarts.get(a.id)!.position } }))[0] ?? null,
        preyById: (id) => this.#agentsById.get(id) ?? null,
        kill: (prey, hunter, at, taskEventId) => this.#kill(prey, 'predation', hunter.id,
          { at, causalParent: taskEventId }),
      } : undefined);
    // Settle illness only after every animal and community action in this decision. A meal
    // acquired at the end cannot incubate retroactively, and a human/predator kill wins over a
    // later disease hazard instead of creating a second death or carcass.
    const decisionEnd = this.#time + hours * WORLD_SECONDS_PER_HOUR;
    for (const agent of this.agents) {
      if (!agent.alive || !agent.illness) continue;
      const fatal = advanceIllness(agent, decisionEnd, this.log);
      if (fatal) this.#kill(agent, 'disease', null, { at: decisionEnd, causalParent: fatal.id });
    }
    for (const agent of this.agents) {
      if (!agent.alive || !agent.wound) continue;
      const fatal = advanceWound(agent, decisionEnd, this.log);
      if (fatal) this.#kill(agent, 'disease', null, { at: decisionEnd, causalParent: fatal.id });
    }
    for (const transition of fishTransitions) {
      this.log.append({
        type: transition.type, worldTime: decisionEnd, simVersion: SIM_VERSION,
        patchId: transition.patchId, actors: [],
        conditions: { stage: transition.type === 'fish_spawned' ? 'eggs'
          : transition.type === 'fish_hatched' ? 'larvae' : 'settled' },
        outcome: 'success', effects: { biomassKg: transition.biomassKg,
          recycledKg: transition.recycledKg }, causalParents: [], confidence: 'authoritative',
      });
    }
    for (const transition of floweringTransitions) {
      this.log.append({
        type: transition.type, worldTime: decisionEnd, simVersion: SIM_VERSION,
        patchId: transition.patchId, actors: [],
        conditions: { guildId: 'insect_visited_understorey_v1' }, outcome: transition.outcome,
        effects: { biomassKg: transition.biomassKg, recycledKg: transition.recycledKg },
        causalParents: [], confidence: 'authoritative',
      });
    }
    this.#time += hours * WORLD_SECONDS_PER_HOUR;
  }
}

export function createWorld(options: WorldOptions): World {
  return new World(options);
}
