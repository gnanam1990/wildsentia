import { warmDryGround } from './agents/navigation.js';
import {
  NUTRIENT_PER_KG_BIOMASS, gridForProfile, patchCentre, patchCount, type WorldGrid, WORLD_SECONDS_PER_DAY, WORLD_SECONDS_PER_HOUR,
  createRng, isClosedProfile, isCongoProfile, isFlooded, isIslandProfile, seasonAt, carcassMass, edibleMass, landWalkable, spatialHash, treeAnchorForPatch, patchAtPosition, positionInPatch, isWorldPosition, type TerrainProfile,
  type WorldPosition, type MovementTrace,
  type Agent, type Carcass, type DeathCause, type Patch, type Rng, type SkillId,
  type RngState, type SpeciesConfig, type WorldTime, type WaterBudget, type MicroEcologyState, type CommunityState, type CommunityProfile,
} from '@vana/shared';
import { buildGrid } from './grid.js';
import { loadSpeciesDir } from './config/loader.js';
import { growPlants } from './fields/plants.js';
import { establishRooting, growRooting } from './fields/rooting.js';
import { newWaterBudget, updateDrainage } from './fields/drainage.js';
import { decayCarcass, isSpent, makeCarcass } from './fields/decomposition.js';
import { totalNutrients, type NutrientLedger } from './fields/nutrients.js';
import { emptyMicroEcology, seedMicroEcology, stepMicroEcology } from './fields/microEcology.js';
import { establishFloweringGuild, stepFloweringGuild } from './fields/floweringGuild.js';
import { EventLog } from './events/log.js';
import { foundCommunity, stepCommunity } from './community.js';
import { updateDrives } from './agents/drives.js';
import { HUNGER_DESPERATION, canHunt, perceive, perceptionRadius, type WorldView } from './agents/perception.js';
import { activityAt, selectGoal } from './agents/goals.js';
import { controlledAction, controlledFeed, descendPerchedAnimal, executeGoal, type ControlledAction, type WorldServices } from './agents/behaviours.js';
import { foundingTraits } from './agents/genetics.js';
import { Pedigree } from './agents/pedigree.js';
import { adultMassFor, mortalityFor, stageFor, targetMass } from './agents/lifecycle.js';
import { isCarried, updateCondition, needsProvisioning, provisionYoung, canFollowParent, canGatherToParent, careRadius, digestGut, gutCapacityKg, inCareContact, mealRoom, needsOf } from './agents/needs.js';
import { availableForCare, chooseCareTarget, finishCare, idleRangeAnchor, travelToFamily, type FamilyLocation, type CareVisit } from './agents/family.js';
import { establishNursingSites, nursingEligible } from './agents/nursing.js';
import { choosePackRecipient, packDonorEligible, canWaitForPackFood, beginPackCollection, finishPackCollection,
  beginPackDelivery, finishPackDelivery, digestPackFood, type PackCollection, type PackDelivery } from './agents/packCare.js';
import { isFloater, territoryRadiusPatches } from './agents/territory.js';
import { decaySkills, experiencedSkills, recordOutcome, teach } from './agents/learning.js';
import { canHuntIndependently } from './agents/needs.js';
import { advanceIllness } from './agents/illness.js';
import { advanceWound } from './agents/wound.js';
import { edgePatchIds, expectedExchange } from './landscape.js';
import { surface } from './agents/aquatic.js';
import { locateAgent, locateCarcass, placeBeside } from './agents/spatial.js';
import { approachMate, finishCourtship, type CourtshipVisit } from './agents/courtship.js';
import {
  assessMate, birth, foundingBreedingState, isReadyToGiveBirth, isReceptive,
  packAllowsBreeding,
} from './agents/reproduction.js';

export const SIM_VERSION = 'sim_0.38.0';

/** Uncalibrated group-decision policy, not a claim of a species-specific thirst measurement.
 * An unweaned independent drinker need not leave a nearby caregiver every hour for a sip. */
const DEPENDENT_URGENT_THIRST = 0.5;
const DEPENDENT_URGENT_HUNGER = 0.65;
/** Phase B: a canopy dweller perched in its tree comes down to forage or drink at this hunger or thirst. */
const CANOPY_FORAGE_DRIVE = 0.5;

export interface WorldOptions {
  /** Isolated experiments only; ordinary worlds keep the exact existing rainfall policy. */
  rainfallScale?: number;
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
  /** The world's patch lattice, fixed by its terrain profile. */
  readonly grid: WorldGrid;
  readonly patches: Patch[];
  readonly #edgeIds: readonly number[];
  readonly #edges: ReadonlySet<number>;
  #landCache: Patch[] | null = null;
  #dryLandCache: Patch[] | null = null;
  #waterMarginCache: Patch[] | null = null;
  /** Congo 1B: single-member pair groups waiting for a mate, by `species:sex`, oldest first. Filled only by
   * founding (#spawn); not restored from checkpoints, which is safe because Congo is closed (no later founders). */
  readonly #openPairs = new Map<string, string[]>();
  /** Living animals only. The dead move to `deceased` so they leave every per-tick loop. */
  readonly agents: Agent[] = [];
  /** Permanent record. A death removes an animal from the world, never from its history. */
  readonly deceased: Agent[] = [];
  readonly carcasses: Carcass[] = [];
  readonly log: EventLog;
  readonly ledger: NutrientLedger = { imported: 0, exported: 0 };
  /** Island only (sim_0.33.0): when each species last arrived from outside, for rate limiting. */
  readonly islandArrivals: Record<string, WorldTime> = {};
  /** sim_0.37.0: arrivals an explicit upgrade scheduled (see upgradeV36Snapshot), due at the next day boundary. */
  readonly pendingArrivals: Array<{ speciesId: string; sex: 'female' | 'male'; trigger: string }> = [];
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
  /**
   * The patch each animal is filed under in #agentsByPatch. Animals move during the hour (routes,
   * chases, carried young); sim_0.38.0 re-files them before the next lookup, so one that moved is
   * seen where it is, not missing until the next hour. Between phases (a new view) every animal is
   * checked; between two animals' turns only the ones that turn could have moved: the animal itself
   * and the actors of the events it logged (its prey, its young, its packmates).
   */
  readonly #filedPatch = new Map<Agent, number>();
  #indexStale = false;
  /** Herds, troops, packs and families: the spec's group entity, kept light. */
  readonly #groups = new Map<string, { speciesId: string; memberIds: string[] }>();
  #groupSeq = 0;
  readonly #carcassesByPatch = new Map<number, Carcass[]>();

  constructor(options: WorldOptions) {
    if (options.rainfallScale !== undefined && (!Number.isFinite(options.rainfallScale) || options.rainfallScale < 0 || options.rainfallScale > 1))
      throw new Error('rainfall scale must be between zero and one');
    if (options.communityProfile !== undefined && !['none', 'household_v1'].includes(options.communityProfile))
      throw new Error('unknown community profile');
    if (options.initialCommunityRulesVersion !== undefined && ![2, 3, 4, 5, 6, 7, 8].includes(options.initialCommunityRulesVersion))
      throw new Error('unsupported initial community rules');
    this.terrainProfile = options.terrainProfile ?? 'mainland';
    if (this.terrainProfile !== 'mainland' && !isClosedProfile(this.terrainProfile)) throw new Error('unknown terrain profile');
    if (isClosedProfile(this.terrainProfile) && !Number.isSafeInteger(options.seed)) throw new Error('closed world seed must be a safe integer');
    if (isClosedProfile(this.terrainProfile) && (options.landscape || Object.values(options.minPopulation).some(n => n !== 0)))
      throw new Error('closed worlds require closed population policy: no floors or mainland exchange');
    this.#options = options;
    this.#rng = createRng(options.seed, 'world');
    this.grid = gridForProfile(this.terrainProfile);
    this.#edgeIds = edgePatchIds(this.grid);
    this.#edges = new Set(this.#edgeIds);
    this.patches = buildGrid(options.seed, this.terrainProfile, this.grid);
    // A land animal's dry footing beside each Congo river (navigation.ts), found once, not in an hour.
    warmDryGround(this.grid, this.patches);
    this.microEcology = seedMicroEcology(this.patches, 0);
    establishFloweringGuild(this.patches, 0);
    establishRooting(this.patches);
    this.waterBudget = newWaterBudget(this.patches, 0);
    this.species = loadSpeciesDir(options.speciesDir);
    this.log = new EventLog(options.seed, SIM_VERSION, { retain: options.retainEvents ?? 'all', grid: this.grid });

    for (const [speciesId, count] of Object.entries(options.initialAgents)) {
      const founders: Agent[] = [];
      for (let i = 0; i < count; i++) founders.push(this.#spawn(speciesId, false));
      // A closed island starts with a handful of big cats and has no immigration/rescue floor.
      // Preserve every random draw. On `island_v1` only the second founder is corrected, when
      // random sex assignment made a solitary cat's whole founding cohort unable to breed. On
      // `island_v2` (sim_0.37.0) the cohort is founded as these polygynous cats hold land: one
      // male, whose range spans several females' (tiger 60 against 20 km², leopard 48 against
      // 11 km²), and the rest females.
      const cfg = this.species.get(speciesId);
      // Congo 1B: solitary hunters are founded as their ranges hold them, one male to two females.
      if (isCongoProfile(this.terrainProfile) && cfg?.social.structure === 'solitary' && cfg.hunting !== undefined) {
        founders.forEach((agent, i) => { agent.sex = i % 3 === 0 ? 'male' : 'female'; agent.massKg = adultMassFor(agent, cfg); });
      } else if (this.terrainProfile === 'island_v2' && cfg?.social.structure === 'solitary' && cfg.hunting !== undefined) {
        founders.forEach((agent, i) => { agent.sex = i === 0 ? 'male' : 'female'; agent.massKg = adultMassFor(agent, cfg); });
      } else if (isIslandProfile(this.terrainProfile) && this.species.get(speciesId)?.social.structure === 'solitary'
        && this.species.get(speciesId)?.hunting !== undefined
        && founders.length >= 2 && founders.every(agent => agent.sex === founders[0]!.sex)) {
        const second = founders[1]!;
        second.sex = founders[0]!.sex === 'female' ? 'male' : 'female';
        second.massKg = adultMassFor(second, this.species.get(speciesId)!);
      }
      // Congo founders: each female somewhere in her breeding cycle, not all receptive at once
      // (drawn once every sex is settled).
      if (isCongoProfile(this.terrainProfile) && cfg) for (const agent of founders) {
        if (agent.sex !== 'female') continue;
        const state = foundingBreedingState(cfg, this.#rng.next(), this.#time);
        agent.pregnantSince = state.pregnantSince;
        if (state.pregnancyFatherId !== undefined) agent.pregnancyFatherId = state.pregnancyFatherId;
        if (state.nextOestrusAt !== undefined) agent.nextOestrusAt = state.nextOestrusAt;
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
      locateAgent(this.grid, agent);
      this.#agentsById.set(agent.id, agent);
      if (agent.alive) {
        this.#livingBySpecies.set(
          agent.speciesId, (this.#livingBySpecies.get(agent.speciesId) ?? 0) + 1,
        );
      }
    }
    for (const agent of this.deceased) { locateAgent(this.grid, agent); this.#agentsById.set(agent.id, agent); }
    for (const carcass of this.carcasses) locateCarcass(this.grid, carcass);
  }

  /** Files a living animal that has moved (or was born) since it was filed, under its patch now. */
  #refileOne(agent: Agent): void {
    const filed = this.#filedPatch.get(agent);
    if (!agent.alive || filed === agent.patchId) return;
    if (filed !== undefined) {
      const old = this.#agentsByPatch.get(filed), at = old?.indexOf(agent) ?? -1;
      if (at >= 0) old!.splice(at, 1);
    }
    const list = this.#agentsByPatch.get(agent.patchId);
    if (list) list.push(agent); else this.#agentsByPatch.set(agent.patchId, [agent]);
    this.#filedPatch.set(agent, agent.patchId);
  }

  /** After one animal's turn: it, and every animal its events name, may have moved. */
  #refileTurn(agent: Agent | null, logMark: number): void {
    if (agent) this.#refileOne(agent);
    const fresh = this.log.size() - logMark;
    if (fresh <= 0) return;
    for (const event of this.log.tail(fresh)) {
      for (const id of event.actors) { const other = this.#agentsById.get(id); if (other) this.#refileOne(other); }
    }
  }

  #view(): WorldView {
    // A view is taken between moves: anything that moved since the index was built is re-filed first.
    this.#indexStale = true;
    return {
      grid: this.grid,
      season: seasonAt(this.#time, this.terrainProfile),
      patches: this.patches,
      agentsInPatch: (patchId) => {
        if (this.#indexStale) { this.#indexStale = false; for (const agent of this.agents) this.#refileOne(agent); }
        return (this.#agentsByPatch.get(patchId) ?? []).filter((a) => a.alive && a.patchId === patchId);
      },
      agentById: (id) => this.#agentsById.get(id),
      carcassesInPatch: (patchId) => this.#carcassesByPatch.get(patchId) ?? [],
      speciesOf: (speciesId) => this.species.get(speciesId)!,
      groupPatch: (groupId) => this.#groupPatch(groupId),
      worldTime: this.#time,
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
      joinPackHunt: (hunter, cfg) => this.#joinPackHunt(hunter, cfg),
      packmatesNearby: (hunter, cfg) => this.#packCandidates(hunter, cfg).some(c => !c.follower),
      packRendezvous: (hunter, cfg) => this.#packRendezvous(hunter, cfg),
      carryYoung: (mother, from, trace, causalParent) => this.#carryYoung(mother, from, trace, causalParent),
    };
  }

  /**
   * sim_0.37.0: where a den mother's litter lies, if she is one: a mother of a species whose pack
   * feeds her at the den (lifecycle.denStayDays), with a dependent young younger than that. The
   * den is the start-of-hour place of the youngest such young.
   */
  #denSite(mother: Agent, cfg: SpeciesConfig, children: readonly Agent[], starts: ReadonlyMap<string, FamilyLocation>): FamilyLocation | null {
    const stay = cfg.lifecycle.denStayDays;
    if (stay === undefined || mother.sex !== 'female' || !cfg.social.cooperativeCare) return null;
    let youngest: Agent | null = null;
    for (const child of children) {
      if (!child.alive || child.dependentOn !== mother.id || child.ageDays >= stay || !needsProvisioning(child, cfg)) continue;
      if (!youngest || child.ageDays < youngest.ageDays || child.ageDays === youngest.ageDays && child.id < youngest.id) youngest = child;
    }
    const site = youngest ? starts.get(youngest.id) : undefined;
    return site ? { patchId: site.patchId, position: { ...site.position } } : null;
  }

  /**
   * sim_0.37.0: how hungry the young a cat mother feeds at her kills are: the hungriest of her
   * living dependants old enough to eat meat (lifecycle.meatFromDays) that cannot yet hunt.
   */
  #litterHunger(mother: Agent, cfg: SpeciesConfig, children: readonly Agent[]): number {
    const meatFrom = cfg.lifecycle.meatFromDays;
    if (meatFrom === undefined || !cfg.hunting || mother.sex !== 'female') return 0;
    let hunger = 0;
    for (const child of children) if (child.alive && child.dependentOn === mother.id && child.ageDays >= meatFrom
      && !canHuntIndependently(child, cfg)) hunger = Math.max(hunger, child.drives.hunger);
    return hunger;
  }

  /** Decisions already taken this step, and packmates whose decision a pack hunt has spent. */
  #stepProcessed: ReadonlySet<string> = new Set();
  readonly #packHunted = new Set<string>();
  /** sim_0.38.0: infants their mother carried this step; the ride was their move for the hour. */
  readonly #carried = new Set<string>();

  /**
   * sim_0.36.0: dholes hunt as a pack. Before, each dhole hunted alone and the pack met at a
   * carcass only by chance: on the island they made 10-11% of attempts, mostly at hares and
   * piglets (2.5-9 kg), and fell to one to three animals with starving pups. Packmates within
   * the configured radius of a hunter as it commits join it, relay the chase and feed at the
   * kill. A packmate joins only if it is a calm, independent hunter not already busy this hour
   * (it has not yet decided, or it only rested), is not carrying food to the den and
   * is not the mother of pups too young to follow (she stays at the den). Weaned young old enough
   * to follow come along as followers: they do not add to the chase but feed at the kill (pups
   * leave the den at 70-80 days and help kill only at about seven months, Johnsingh 1982).
   * Nothing is created: joiners spend their own decision and stamina and eat from the one carcass.
   */
  #joinPackHunt(hunter: Agent, cfg: SpeciesConfig): { hunters: Agent[]; followers: Agent[] } {
    const candidates = this.#packCandidates(hunter, cfg);
    if (cfg.hunting?.packHuntRadiusM === undefined || hunter.groupId == null) return { hunters: [], followers: [] };
    this.#packHunted.add(hunter.id);
    for (const c of candidates) this.#packHunted.add(c.mate.id);
    return { hunters: candidates.filter(c => !c.follower).map(c => c.mate),
      followers: candidates.filter(c => c.follower).map(c => c.mate) };
  }

  /**
   * sim_0.37.0: a langur infant clings to its mother and goes where she goes. On the larger
   * island a dhole den beside a langur troop kept mothers fleeing between two patches for two
   * days; each infant fled on its own to a different spot, ended 100-500 m from its mother, and
   * 19 died of thirst in two days (seed 1, days 230-232). An infant in contact with its mother
   * when she sets off is carried along her route, recorded as its own movement with her.
   */
  #carryYoung(mother: Agent, from: { patchId: number; position: WorldPosition }, trace: MovementTrace, causalParent: string): void {
    const cfg = this.species.get(mother.speciesId)!;
    if (cfg.lifecycle.carriedUntilDays === undefined || (mother.altitudeM ?? 0) > 0) return;
    const end = locateAgent(this.grid, mother);
    for (const id of mother.offspringIds) {
      const child = this.#agentsById.get(id);
      if (!child?.alive || child.dependentOn !== mother.id || !isCarried(child, cfg) || child.controller
        || (child.altitudeM ?? 0) > 0 || child.patchId !== from.patchId) continue;
      const at = locateAgent(this.grid, child);
      if (Math.hypot(at.x - from.position.x, at.z - from.position.z) > careRadius(cfg) + 1e-8) continue;
      if (child.patchId !== mother.patchId) child.previousPatchId = child.patchId;
      child.patchId = mother.patchId;
      child.position = { ...end };
      delete child.journey;
      child.state = mother.state === 'fleeing' ? 'fleeing' : 'travelling';
      this.#carried.add(child.id);
      this.log.append({ type: 'moved', worldTime: Math.floor(trace.startWorldTime + (trace.samples.at(-1)?.seconds ?? 0)),
        simVersion: SIM_VERSION, patchId: child.patchId, actors: [child.id, mother.id], goal: 'follow_parent',
        conditions: { reason: 'carried', carrierId: mother.id, from: from.patchId, destination: trace.destinationPatchId },
        outcome: trace.completed ? 'success' : 'interrupted',
        effects: { durationSeconds: trace.samples.at(-1)?.seconds ?? 0 },
        causalParents: [causalParent], confidence: 'authoritative',
        movement: { ...trace, actorId: child.id, goal: 'follow_parent', samples: trace.samples.map(s => ({ ...s, position: { ...s.position } })) } });
    }
  }

  /** sim_0.37.0: a den mother of pups younger than the species' denning days (read-only). */
  #keepsDen(mother: Agent, cfg: SpeciesConfig): boolean {
    const stay = cfg.lifecycle.denStayDays;
    return stay !== undefined && mother.sex === 'female' && mother.offspringIds.some(id => {
      const child = this.#agentsById.get(id);
      return child?.alive === true && child.dependentOn === mother.id && child.ageDays < stay;
    });
  }

  /** A rendezvous must advertise the same available members that can actually join the hunt. */
  #packAvailable(mate: Agent | undefined, hunter: Agent, cfg: SpeciesConfig): mate is Agent {
    if (!mate?.alive || mate.id === hunter.id || mate.speciesId !== hunter.speciesId || mate.controller
      || this.#packHunted.has(mate.id) || mate.lastEncounterAt === this.#time || (mate.altitudeM ?? 0) > 0
      || mate.packFood || mate.drives.fear >= 0.5 || mate.drives.thirst >= 0.65 || needsProvisioning(mate, cfg)
      || this.#keepsDen(mate, cfg) || this.#stepProcessed.has(mate.id) && mate.currentGoal !== 'rest') return false;
    return !mate.offspringIds.some(childId => {
      const child = this.#agentsById.get(childId);
      return child?.alive === true && child.dependentOn === mate.id && !canFollowParent(child, cfg);
    });
  }

  /** sim_0.37.0: where the nearest packmate that could hunt with this hunter stands (read-only). */
  #packRendezvous(hunter: Agent, cfg: SpeciesConfig): number | null {
    const group = hunter.groupId == null ? undefined : this.#groups.get(hunter.groupId);
    if (cfg.hunting?.packHuntRadiusM === undefined || !group) return null;
    const at = locateAgent(this.grid, hunter);
    let best: Agent | null = null, bestM = Infinity;
    for (const id of group.memberIds) {
      const mate = this.#agentsById.get(id);
      if (!this.#packAvailable(mate, hunter, cfg) || !canHuntIndependently(mate, cfg)) continue;
      const there = locateAgent(this.grid, mate), m = Math.hypot(there.x - at.x, there.z - at.z);
      if (m < bestM || m === bestM && best !== null && mate.id < best.id) { best = mate; bestM = m; }
    }
    return best ? best.patchId : null;
  }

  /** Packmates free to join this hunter now, and whether each would only follow (read-only). */
  #packCandidates(hunter: Agent, cfg: SpeciesConfig): Array<{ mate: Agent; follower: boolean }> {
    const radius = cfg.hunting?.packHuntRadiusM;
    const group = hunter.groupId == null ? undefined : this.#groups.get(hunter.groupId);
    if (radius === undefined || !group) return [];
    const at = locateAgent(this.grid, hunter), found: Array<{ mate: Agent; follower: boolean }> = [];
    for (const id of [...group.memberIds].sort()) {
      const mate = this.#agentsById.get(id);
      if (!this.#packAvailable(mate, hunter, cfg)) continue;
      // Weaned young that can keep up follow the hunt and feed at the kill; only adults hunt.
      const follower = !canHuntIndependently(mate, cfg);
      if (follower && !canFollowParent(mate, cfg)) continue;
      const there = locateAgent(this.grid, mate);
      if (Math.hypot(there.x - at.x, there.z - at.z) > radius) continue;
      found.push({ mate, follower });
    }
    return found;
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
      const parentPosition = locateAgent(this.grid, agent), childPosition = locateAgent(this.grid, child);
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

  /**
   * sim_0.38.0: a group lists its living members only, and a group with none is gone. Every
   * death stayed listed for good, and a group whose members had all died stayed open, so the
   * next founder or immigrant of its kind joined it as a group of one under the dead group's id.
   */
  #pruneGroups(): void {
    for (const [groupId, group] of this.#groups) {
      group.memberIds = group.memberIds.filter(id => this.#agentsById.get(id)?.alive === true);
      if (!group.memberIds.length) this.#groups.delete(groupId);
    }
  }

  #assignGroup(agent: Agent, cfg: SpeciesConfig): void {
    const structure = cfg.social.structure;
    if (structure === 'solitary') return;
    if (cfg.social.pairBond) { this.#assignPair(agent); return; }

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

  /**
   * Congo 1B: a bonded pair species pairs each newcomer with the longest-waiting unpaired animal
   * of the other sex that is not its kin (an index of open pairs, so founding stays linear).
   */
  #assignPair(agent: Agent): void {
    const other = agent.sex === 'female' ? 'male' : 'female';
    const waiting = this.#openPairs.get(`${agent.speciesId}:${other}`) ?? [];
    for (let i = 0; i < waiting.length; i++) {
      const groupId = waiting[i]!, group = this.#groups.get(groupId);
      const member = group?.memberIds.length === 1 ? this.#agentsById.get(group.memberIds[0]!) : undefined;
      if (!member?.alive) { waiting.splice(i--, 1); continue; }
      if (assessMate(agent, member, this.pedigree) === null) continue;
      waiting.splice(i, 1);
      group!.memberIds.push(agent.id);
      agent.groupId = groupId;
      agent.patchId = member.patchId;
      return;
    }
    const groupId = `${agent.speciesId}_grp_${(this.#groupSeq++).toString(16)}`;
    this.#groups.set(groupId, { speciesId: agent.speciesId, memberIds: [agent.id] });
    agent.groupId = groupId;
    const key = `${agent.speciesId}:${agent.sex}`, open = this.#openPairs.get(key);
    if (open) open.push(groupId); else this.#openPairs.set(key, [groupId]);
  }

  /** Leaves its group (a group left empty is gone). */
  #leaveGroup(agent: Agent): void {
    if (agent.groupId == null) return;
    const group = this.#groups.get(agent.groupId);
    if (group) {
      group.memberIds = group.memberIds.filter((id) => id !== agent.id);
      if (!group.memberIds.length) this.#groups.delete(agent.groupId);
    }
    agent.groupId = null;
  }

  /** Congo 1B: a female and male who conceived together and have no pair-mate of their own become a pair. */
  #bond(female: Agent, male: Agent, cfg: SpeciesConfig): void {
    if (!male.alive || female.id === male.id) return;
    const members = (a: Agent) => (a.groupId == null ? [] : this.#groups.get(a.groupId)?.memberIds ?? [])
      .map((id) => this.#agentsById.get(id)).filter((x): x is Agent => x !== undefined);
    const kin = (a: Agent, b: Agent) => assessMate(a, b, this.pedigree) === null;
    if (pairMateFor(female, cfg, members(female), kin) || pairMateFor(male, cfg, members(male), kin)) return;
    this.#leaveGroup(male);
    if (female.groupId == null) {
      const groupId = `${female.speciesId}_grp_${(this.#groupSeq++).toString(16)}`;
      this.#groups.set(groupId, { speciesId: female.speciesId, memberIds: [female.id] });
      female.groupId = groupId;
    }
    this.#groups.get(female.groupId)!.memberIds.push(male.id);
    male.groupId = female.groupId;
  }

  #reindex(): void {
    this.#agentsByPatch.clear();
    this.#filedPatch.clear();
    for (const agent of this.agents) {
      if (!agent.alive) continue;
      this.#filedPatch.set(agent, agent.patchId);
      const list = this.#agentsByPatch.get(agent.patchId);
      if (list) list.push(agent);
      else this.#agentsByPatch.set(agent.patchId, [agent]);
    }
    this.#indexStale = false;
    this.#carcassesByPatch.clear();
    for (const carcass of this.carcasses) {
      const list = this.#carcassesByPatch.get(carcass.patchId);
      if (list) list.push(carcass);
      else this.#carcassesByPatch.set(carcass.patchId, [carcass]);
    }
  }

  get #landPatches(): Patch[] { return this.#landCache ??= this.patches.filter(landWalkable); }
  get #dryLandPatches(): Patch[] { return this.#dryLandCache ??= this.patches.filter((p) => landWalkable(p) && p.habitat !== 'water'); }
  /** Congo 1B: where a swimmer lives, rarely 250 m from water: flooded forest, and dry ground beside a river. */
  get #waterMarginPatches(): Patch[] {
    return this.#waterMarginCache ??= this.#dryLandPatches.filter((p) => p.habitat === 'flooded_forest'
      || p.neighbours.some((n) => this.patches[n]!.habitat === 'water'));
  }

  #spawn(speciesId: string, immigrant: boolean, atEdge = false,
    arrival?: { patchId: number; at: WorldTime; conditions: Record<string, string | number> }, sexOverride?: 'female' | 'male', silent = false): Agent {
    const cfg = this.species.get(speciesId);
    if (!cfg) throw new Error(`unknown species: ${speciesId}`);

    // Island founders keep their recorded draw over all walkable patches; Congo founders stand on dry ground.
    const eligibleLand = arrival ? null : isIslandProfile(this.terrainProfile) ? this.#landPatches
      : isCongoProfile(this.terrainProfile) ? (cfg.locomotion.swims ? this.#waterMarginPatches : this.#dryLandPatches) : null;
    if (eligibleLand && !eligibleLand.length) throw new Error('island has no founding habitat');
    const patchId = arrival ? arrival.patchId : eligibleLand ? eligibleLand[this.#rng.int(eligibleLand.length)]!.id : atEdge
      ? this.#edgeIds[this.#rng.int(this.#edgeIds.length)]!
      : this.#rng.int(patchCount(this.grid));
    // Founders and immigrants arrive as adults of a spread of ages, so a population does not
    // reach sexual maturity in lockstep.
    const ageDays = cfg.lifecycle.sexualMaturityDays
      + this.#rng.range(0, cfg.lifecycle.maxAgeDays * 0.35);
    const drawnSex = this.#rng.bool(0.5) ? 'female' : 'male';
    const sex = sexOverride ?? drawnSex;
    const agent: Agent = {
      id: `${speciesId}_${(this.#agentSeq++).toString(16).padStart(4, '0')}`,
      speciesId, bornAt: arrival?.at ?? this.#time, massKg: adultMassFor({ sex }, cfg), patchId,
      state: 'resting', currentGoal: 'wander', alternativeGoal: null, goalScore: 0,
      targetId: null, stamina: 1,
      sex,
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
    // A swimmer comes ashore where it lands; it joins its kind's group by walking, not by a jump.
    // sim_0.38.0: so does an immigrant from the surrounding landscape, at the edge it crossed.
    if (arrival || atEdge) agent.patchId = patchId;
    locateAgent(this.grid, agent);
    if (immigrant) this.ledger.imported += agent.massKg * NUTRIENT_PER_KG_BIOMASS;
    if (silent) return agent;

    this.log.append({
      type: immigrant ? 'immigration' : 'agent_spawned',
      // Where it was placed: joining its group may have moved it from the patch drawn above.
      worldTime: arrival?.at ?? this.#time, simVersion: SIM_VERSION, patchId: agent.patchId,
      actors: [agent.id], conditions: { species: speciesId, ...arrival?.conditions },
      outcome: 'success', effects: { massKg: agent.massKg },
      causalParents: [], confidence: 'authoritative',
      ...(arrival ? { position: { ...locateAgent(this.grid, agent) } } : {}),
    });
    return agent;
  }

  /**
   * sim_0.33.0: the unfinished predation carcass this hunter has already fed from, within the
   * patches it perceives, that still holds meat it will eat. Island probes found tigers eating
   * 8% of a 127 kg kill and dholes 4% (12% with packmates) before wandering off and killing
   * again a day or three later, leaving three quarters to decay: three times the kills their
   * food needs. Tigers stay with a large kill for days, feeding repeatedly, and a dhole pack
   * finishes its kill where it falls, so an idle hunter now stays and feeds from what it killed.
   * Hunger, thirst, fear and every other goal still win; only aimless wandering is replaced.
   */
  #unfinishedKill(agent: Agent, cfg: SpeciesConfig): { carcass: Carcass; patchId: number } | null {
    if (!cfg.hunting || !cfg.diet.canScavenge || needsProvisioning(agent, cfg)) return null;
    const here = this.patches[agent.patchId]!, reach = perceptionRadius(this.grid, cfg);
    let best: Carcass | null = null;
    for (const carcass of this.carcasses) {
      const there = this.patches[carcass.patchId]!;
      if (carcass.cause !== 'predation' || Math.abs(there.x - here.x) + Math.abs(there.y - here.y) > reach
        || carcass.pathogenLoad > cfg.diet.carrionTolerance || !(edibleMass(carcass.biomass) > 0)
        || !carcass.consumers.some(c => c.agentId === agent.id)) continue;
      if (!best || edibleMass(carcass.biomass) > edibleMass(best.biomass)) best = carcass;
    }
    return best ? { carcass: best, patchId: best.patchId } : null;
  }

  #shore: number[] | null = null;
  /** Island land touching the sea, where a swimmer comes ashore. */
  #shorePatches(): number[] {
    this.#shore ??= this.patches.filter(p => landWalkable(p) && p.neighbours.some(id =>
      this.patches[id]?.surface === 'ocean' || this.patches[id]?.surface === 'coast')).map(p => p.id);
    return this.#shore;
  }

  /**
   * sim_0.33.0: rare arrivals onto the closed island, for species configured with
   * `islandArrival` (tiger, elephant and jackal swim channels; sim_0.37.0 leopards, a modelling
   * assumption with no documented crossing; see the ecology doc). Once per
   * world day, and only while no more than `whenLivingAtMost` of the species live here and the
   * last arrival is at least `minDaysBetween` old, a draw derived from the seed, species and day
   * (not the world's random stream, which an arrival never perturbs unless one happens) admits
   * one adult on a shore patch. Its body is recorded as imported nutrient, the arrival is an
   * authoritative `immigration` event with its trigger and draw, and nothing else changes.
   */
  #islandArrival(at: WorldTime): void {
    if (!isIslandProfile(this.terrainProfile)) return;
    const day = Math.floor(at / WORLD_SECONDS_PER_DAY);
    // sim_0.37.0: an upgraded island's scheduled arrivals (its leopard pair) come ashore first, each
    // a recorded, ledgered crossing like any other, on a shore patch chosen from seed, species and day.
    for (const [index, pending] of this.pendingArrivals.splice(0).entries()) {
      const cfg = this.species.get(pending.speciesId), shore = this.#shorePatches();
      if (!cfg || !shore.length) continue;
      const patchId = shore[spatialHash(`upgrade-arrival-shore:${this.#options.seed}:${pending.speciesId}:${day}:${index}`) % shore.length]!;
      const living = this.livingCount(pending.speciesId);
      this.#spawn(pending.speciesId, true, false, { patchId, at, conditions: {
        route: 'island_crossing', trigger: pending.trigger, livingBefore: living } }, pending.sex);
    }
    for (const [speciesId, cfg] of [...this.species].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const policy = cfg.islandArrival;
      if (!policy) continue;
      const living = this.livingCount(speciesId);
      if (living > policy.whenLivingAtMost) continue;
      const last = this.islandArrivals[speciesId];
      if (last !== undefined && at - last < policy.minDaysBetween * WORLD_SECONDS_PER_DAY) continue;
      const draw = spatialHash(`island-arrival:${this.#options.seed}:${speciesId}:${day}`) / 2 ** 32;
      if (draw >= policy.dailyProbability) continue;
      const shore = this.#shorePatches();
      if (!shore.length) return;
      const patchId = shore[spatialHash(`island-arrival-shore:${this.#options.seed}:${speciesId}:${day}`) % shore.length]!;
      this.islandArrivals[speciesId] = at;
      // sim_0.37.0: a species whose survivors are all of one sex receives the other (leopards).
      const sexes = new Set(this.agents.filter(a => a.alive && a.speciesId === speciesId).map(a => a.sex));
      const missing = policy.preferMissingSex && sexes.size === 1 ? (sexes.has('male') ? 'female' : 'male') : undefined;
      this.#spawn(speciesId, true, false, { patchId, at, conditions: {
        route: 'island_crossing', trigger: living === 0 ? 'locally_extinct' : 'small_population',
        livingBefore: living, whenLivingAtMost: policy.whenLivingAtMost, dailyProbability: policy.dailyProbability, draw,
        ...(missing ? { sexRule: 'missing_sex' } : {}) } }, missing);
    }
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
    // sim_0.38.0: likewise a bird that dies on the wing; its carcass is on the ground.
    if (agent.locomotionMode === 'flight') { delete agent.altitudeM; delete agent.locomotionMode; delete agent.journey; }
    if (agent.locomotionMode === 'submerged') surface(agent);
    agent.alive = false;
    agent.state = 'dead';
    agent.departedAt = at;
    if (agent.assetId !== undefined) agent.ownedDeath = { cause, killerId, at };
    this.#livingBySpecies.set(
      agent.speciesId, Math.max(0, (this.#livingBySpecies.get(agent.speciesId) ?? 1) - 1),
    );

    const carcass = makeCarcass(
      `carc_${(this.#carcassSeq++).toString(16).padStart(4, '0')}`,
      agent.id, agent.speciesId, agent.patchId, at,
      cause, cause === 'predation' ? 'authoritative' : 'high',
      agent.massKg,
    );
    carcass.position = { ...locateAgent(this.grid, agent) };
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
    const pairMate = pairMateFor(agent, cfg, (agent.groupId == null ? [] : this.#groups.get(agent.groupId)?.memberIds ?? [])
      .map((id) => this.#agentsById.get(id)).filter((a): a is Agent => a !== undefined),
      (a, b) => assessMate(a, b, this.pedigree) === null);
    const here = locateAgent(this.grid, agent), senseRange = Math.max(cfg.senses.sightRangeM, cfg.senses.hearingRangeM, cfg.senses.smellRangeM);
    for (const patchId of [agent.patchId, ...this.patches[agent.patchId]!.neighbours]) {
      for (const other of view.agentsInPatch(patchId)) {
        if (!other.alive || other.speciesId !== agent.speciesId || (other.altitudeM ?? 0) > 0) continue;
        // Congo 1B: nothing courts an animal under water.
        if (other.locomotionMode === 'submerged') continue;
        // Congo 1B: a paired animal courts only its pair-mate while that mate lives.
        if (pairMate && other.id !== pairMate.id) continue;
        // An agent-steered animal is not led off by a wild suitor's plan.
        if (other.controller) continue;
        if (!isReceptive(other, cfg, this.#time)) continue;
        const target = starts.get(other.id);
        if (!target || !landWalkable(this.patches[target.patchId])
          || Math.hypot(here.x - target.position.x, here.z - target.position.z) > senseRange) continue;
        // A partner who already used this hour cannot be pursued at a stale start location.
        // A stationary resting male is still available; a moving/feeding male is not.
        if (processed.has(other.id) && (other.currentGoal !== 'rest'
          || other.patchId !== target.patchId
          || Math.hypot(locateAgent(this.grid, other).x - target.position.x,
            locateAgent(this.grid, other).z - target.position.z) > 1e-6)) continue;
        const assessment = assessMate(agent, other, this.pedigree);
        if (assessment !== null && (best === null || assessment.score > best.score)) {
          best = assessment;
        }
      }
    }
    // sim_0.37.0: a solitary cat in oestrus that perceives no mate seeks the male whose range she
    // lives in. Female tigers and leopards advertise oestrus by calling and scent marking, and the
    // resident male finds them (Sunquist & Sunquist 2002). On island_v2, twice the land of
    // island_v1, a leopard pair met twice in three years and never bred, and tigers in one seed
    // never bred: mates were sought only in the patches each animal stood beside.
    const territory = cfg.social.territory;
    if (best === null && cfg.social.structure === 'solitary' && territory) {
      const reach = territoryRadiusPatches(territory.maleKm2), here = this.patches[agent.patchId]!;
      let nearest: Agent | null = null, steps = Infinity;
      for (const other of this.agents) {
        if (!other.alive || other.speciesId !== agent.speciesId || other.sex === agent.sex || other.controller
          || (other.altitudeM ?? 0) > 0 || !isReceptive(other, cfg, this.#time)) continue;
        const start = starts.get(other.id), there = start && this.patches[start.patchId];
        if (!start || !there || !landWalkable(there)) continue;
        const d = Math.abs(there.x - here.x) + Math.abs(there.y - here.y);
        if (d > reach || d >= steps || assessMate(agent, other, this.pedigree) === null) continue;
        nearest = other; steps = d;
      }
      if (nearest) best = assessMate(agent, nearest, this.pedigree);
    }
    if (best === null) return false;
    const visit = approachMate(this.grid, agent, best.candidate, starts.get(best.candidate.id)!, cfg, this.patches,
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
    // A mother raises her young in the wild: an agent steering her lets go at the birth.
    delete mother.controller;
    const fatherId = mother.pregnancyFatherId;
    const father = fatherId == null ? null : this.#agentsById.get(fatherId) ?? null;

    // A Congo founder's young were sired before the record began: by a sire like any founder.
    const outsideSire = father === null && isCongoProfile(this.terrainProfile) ? foundingTraits(this.#rng) : undefined;
    const result = birth(
      mother, father, cfg, this.patches[mother.patchId]!, this.pedigree, this.#rng, this.#time,
      () => `${mother.speciesId}_${(this.#agentSeq++).toString(16).padStart(4, '0')}`, outsideSire,
    );

    for (const child of result.newborns) {
      // Spawn one compact litter within nursing reach. The former minimum one-metre ring
      // spread tiny leverets/pups beyond contact, forcing mutually exclusive all-hour visits.
      // This is an initial birth anchor, never a recurring dependent-position correction.
      placeBeside(this.grid, child, locateAgent(this.grid, mother), careRadius(cfg) * 0.25);
      if (cfg.lifecycle.nursing) child.nursingSite = { patchId: mother.patchId,
        position: { ...locateAgent(this.grid, mother) }, establishedAt: this.#time, origin: 'birth' };
      // sim_0.36.0: young on a once-daily schedule suckle at birth, from the mother's own
      // reserves, before she leaves them (leverets are nursed post partum, then once a day at
      // dusk: Broekhuizen & Maaskamp 1980). Born after dusk, a litter otherwise waited up to a
      // day for its first milk and died if the doe missed the next evening.
      const firstFeed = cfg.lifecycle.nursing && provisionYoung(this.grid, mother, child, cfg,
        cfg.lifecycle.nursing.dailyContactSeconds / 3600, undefined, this.#time);
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
        position: { ...locateAgent(this.grid, child) },
        actors: [child.id, mother.id, ...(father === null ? [] : [father.id])],
        conditions: {
          species: child.speciesId, sex: child.sex, generation: child.generation,
          coatVariant: child.traits.coatVariant,
        },
        outcome: 'success', effects: { massKg: child.massKg,
          ...(firstFeed ? { firstFeedFoodKg: firstFeed.foodEquivalentKg, firstFeedWaterL: firstFeed.waterEquivalentL } : {}) },
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
      agent.alive && agent.speciesId === speciesId && this.#edges.has(agent.patchId)
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

  // ---- Agent-steered animals (docs/2026-09-26-live-agents-design.md) ----------------------

  /** A living or recently departed animal by id: the record itself, for read-only adapters. */
  animal(id: string): Agent | undefined { return this.#agentsById.get(id); }

  /** Why this animal cannot be taken over now, or null if it can. `owner`: its owner's side is asking. */
  possessionBlock(id: string, opts: { owner?: boolean; ignoreController?: boolean } = {}): string | null {
    const agent = this.#agentsById.get(id);
    return agent ? this.#blockFor(agent, this.#possessionFacts(), opts.owner === true, opts.ignoreController === true) : 'not_alive';
  }

  /**
   * Congo 1C: patches where an owned animal of this species may be placed: ground its kind founds
   * on (dry land, or the water margin for a swimmer), with no living animal that hunts it within
   * `minPredatorDistanceM` of the patch centre.
   */
  safeSpawnPatches(speciesId: string, minPredatorDistanceM: number): number[] {
    const cfg = this.species.get(speciesId);
    if (!cfg || !isCongoProfile(this.terrainProfile)) return [];
    const prey = { massKg: cfg.body.adultMassKg, lifeStage: 'adult' as const, altitudeM: 0, locomotionMode: 'ground' as const };
    const hunters = this.agents.filter((a) => a.alive && a.position && canHunt(this.species.get(a.speciesId)!, cfg, prey))
      .map((a) => a.position!);
    const eligible = cfg.locomotion.swims ? this.#waterMarginPatches : this.#dryLandPatches;
    // An animal is placed up to 0.4 of a patch from its centre on each axis: keep the distance from there too.
    const reach = minPredatorDistanceM + this.grid.patchM * 0.4 * Math.SQRT2;
    return eligible.filter((p) => {
      const c = patchCentre(this.grid, p.id);
      return hunters.every((h) => Math.hypot(h.x - c.x, h.z - c.z) > reach);
    }).map((p) => p.id);
  }

  /**
   * Congo 1C: a new life of an owned asset, an adult placed in `patchId` (ground its kind may
   * found on), logged as spawned with `owned: 1`. It then lives as any animal of its kind.
   */
  spawnOwned(speciesId: string, patchId: number, assetId: string): Agent {
    if (!isCongoProfile(this.terrainProfile)) throw new Error('owned animals live only in the Congo world');
    const cfg = this.species.get(speciesId);
    if (!cfg) throw new Error(`unknown species: ${speciesId}`);
    if (!assetId) throw new Error('asset id required');
    const eligible = cfg.locomotion.swims ? this.#waterMarginPatches : this.#dryLandPatches;
    if (!eligible.some((p) => p.id === patchId)) throw new Error(`${speciesId} cannot be placed on patch ${patchId}`);
    // Not logged: after founding, any spawn in the public log would mark an owned animal (Congo 1D).
    // Its life is recorded by the server (animal_lives), which no public route shows.
    const agent = this.#spawn(speciesId, false, false, { patchId, at: this.#time, conditions: {} }, undefined, true);
    agent.assetId = assetId;
    return agent;
  }

  /** Up to `limit` animals an agent could take now, in one pass over the population. */
  possessionCandidates(speciesId: string | null, limit: number): Agent[] {
    const facts = this.#possessionFacts(), result: Agent[] = [];
    for (const agent of this.agents) {
      if (result.length >= limit) break;
      if ((speciesId === null || agent.speciesId === speciesId) && this.#blockFor(agent, facts) === null) result.push(agent);
    }
    return result;
  }

  #possessionFacts(): { parents: Set<string>; held: Map<string, number> } {
    const parents = new Set<string>(), held = new Map<string, number>();
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (a.dependentOn !== null) parents.add(a.dependentOn);
      if (a.controller) held.set(a.speciesId, (held.get(a.speciesId) ?? 0) + 1);
    }
    return { parents, held };
  }

  #blockFor(agent: Agent, facts: { parents: Set<string>; held: Map<string, number> }, owner = false, ignoreController = false): string | null {
    if (!agent.alive) return 'not_alive';
    if (agent.assetId !== undefined && !owner) return 'owned';
    if (agent.controller && !ignoreController) return 'already_controlled';
    const cfg = this.species.get(agent.speciesId)!;
    if (agent.lifeStage !== 'adult' && agent.lifeStage !== 'elder') return 'not_adult';
    if (agent.dependentOn !== null) return 'dependent';
    if (facts.parents.has(agent.id)) return 'raising_young';
    if ((agent.altitudeM ?? 0) > 0) return 'off_the_ground';
    if (agent.locomotionMode === 'submerged') return 'under_water';
    // Most of every species stays wild: a fifth at most, and one once there are two (so of
    // the island's two tigers one may be steered and one always stays wild).
    // An owner steering their own animal is not taking one of the wild.
    if (owner) return null;
    const living = this.livingCount(agent.speciesId);
    const cap = living >= 2 ? Math.max(1, Math.floor(living * 0.2)) : 0;
    if ((facts.held.get(agent.speciesId) ?? 0) >= cap) return 'species_cap';
    return null;
  }

  /** Hands the animal to an outside agent. Its body stays in the ecology; its choices do not. */
  possess(id: string, controller: string, opts: { owner?: boolean } = {}): string | null {
    if (!controller) throw new Error('controller required');
    const block = this.possessionBlock(id, opts);
    if (block) return block;
    const agent = this.#agentsById.get(id)!;
    agent.controller = controller;
    agent.currentGoal = 'rest'; agent.alternativeGoal = null; agent.goalScore = 1;
    agent.targetId = null; agent.state = 'resting'; delete agent.journey;
    locateAgent(this.grid, agent);
    return null;
  }

  /** Congo 1C: an owned animal whose life has ended elsewhere (a restart's rollback) lives on as wild. */
  disown(id: string): void {
    const agent = this.#agentsById.get(id);
    if (agent) { delete agent.assetId; delete agent.controller; }
  }

  /** Returns the animal to the wild where it stands. */
  release(id: string): void {
    const agent = this.#agentsById.get(id);
    if (agent) delete agent.controller;
  }

  /**
   * Where the live layer has taken an agent-steered animal. Only on walkable land; the live
   * layer is responsible for speed, so a move here is never a teleport it did not pay for.
   */
  placeControlled(id: string, position: WorldPosition): boolean {
    const agent = this.#agentsById.get(id);
    if (!agent?.alive || !agent.controller) return false;
    if (!isWorldPosition(this.grid, position)) return false;
    const patchId = patchAtPosition(this.grid, position);
    if (patchId < 0 || !landWalkable(this.patches[patchId]) || !positionInPatch(this.grid, position, patchId)) return false;
    agent.position = { x: position.x, z: position.z, heading: position.heading };
    agent.patchId = patchId;
    return true;
  }

  /**
   * An agent-steered animal grazed, drank or rested for `seconds`. The same finite rules as
   * a wild animal, from the patch it stands in; nothing is created.
   */
  applyControlledAction(id: string, action: ControlledAction, seconds: number): boolean {
    const agent = this.#agentsById.get(id);
    if (!agent?.alive || !agent.controller) return false;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error('invalid action seconds');
    const cfg = this.species.get(agent.speciesId)!;
    const view = this.#view();
    const goal = action === 'graze' ? 'find_food' : action === 'drink' ? 'find_water' : 'rest';
    controlledAction({ agent, species: cfg, patches: this.patches, view, percept: perceive(agent, cfg, view),
      choice: { goal, score: 1, alternative: null }, hours: seconds / 3600, worldTime: this.#time,
      log: this.log, rng: this.#rng, services: this.#services() }, action);
    agent.currentGoal = goal;
    return true;
  }

  /**
   * A hunt the live layer resolved in real time: the predator physically reached its prey at
   * `position`, at world time `at` (the moment being played, which trails the saved hour).
   * On success the prey dies there as predation and leaves a carcass, exactly as a wild kill;
   * either way the hunt is recorded. Returns the carcass, or null if the attempt failed or
   * either animal can no longer take part. (docs/2026-09-26-live-agents-design.md, Phase 2)
   */
  resolveLiveHunt(predatorId: string, preyId: string, position: WorldPosition, at: number, killed: boolean): Carcass | null {
    const predator = this.#agentsById.get(predatorId), prey = this.#agentsById.get(preyId);
    if (!predator?.alive || !prey?.alive || predator.id === prey.id) return null;
    const cfg = this.species.get(predator.speciesId)!, preyCfg = this.species.get(prey.speciesId);
    // The authority for a live kill: the same rule every hunt follows (Congo 1B).
    if (!preyCfg || !canHunt(cfg, preyCfg, prey)) return null;
    const patchId = patchAtPosition(this.grid, position);
    if (!landWalkable(this.patches[patchId]) || !positionInPatch(this.grid, position, patchId)) return null;
    const when = Math.min(this.#time, Math.max(0, Math.floor(at)));
    prey.position = { ...position }; prey.patchId = patchId;
    predator.stamina = Math.max(0, (predator.stamina ?? 1) - 0.3);
    const hunt = this.log.append({ type: 'hunt', worldTime: when, simVersion: SIM_VERSION, patchId,
      position: { ...position }, actors: [predator.id, prey.id], goal: 'hunt',
      conditions: { source: 'live', predatorSpecies: predator.speciesId, preySpecies: prey.speciesId,
        ...(predator.controller ? { predatorSteered: 1 } : {}), ...(prey.controller ? { preySteered: 1 } : {}) },
      outcome: killed ? 'success' : 'failure', effects: killed ? { preyMassKg: prey.massKg } : {},
      causalParents: [], confidence: 'authoritative' });
    if (!killed) return null;
    return this.#kill(prey, 'predation', predator.id, { at: when, causalParent: hunt.id });
  }

  /**
   * Where the live layer has taken a wild animal during a real-time chase (fleeing from, or
   * chasing, an agent's animal). Only onto walkable land; the next hourly step starts from here.
   */
  placeWild(id: string, position: WorldPosition): boolean {
    const agent = this.#agentsById.get(id);
    if (!agent?.alive || agent.controller) return false;
    if (!isWorldPosition(this.grid, position)) return false;
    const patchId = patchAtPosition(this.grid, position);
    if (patchId < 0 || !landWalkable(this.patches[patchId]) || !positionInPatch(this.grid, position, patchId)) return false;
    agent.position = { x: position.x, z: position.z, heading: position.heading };
    agent.patchId = patchId; delete agent.journey;
    return true;
  }

  /**
   * An agent-steered predator eats from a carcass it stands at, for `seconds`, by the same
   * finite rules as a wild one. False if there is no carcass within reach.
   */
  feedControlled(id: string, seconds: number): boolean {
    const agent = this.#agentsById.get(id);
    if (!agent?.alive || !agent.controller || !(seconds > 0) || seconds > 3600) return false;
    const cfg = this.species.get(agent.speciesId)!;
    if (!cfg.diet.eats.some((e) => e.target === 'meat')) return false;
    const here = locateAgent(this.grid, agent);
    const carcass = this.carcasses.find((c) => c.position && Math.hypot(c.position.x - here.x, c.position.z - here.z) <= 3);
    if (!carcass) return false;
    const view = this.#view();
    controlledFeed({ agent, species: cfg, patches: this.patches, view, percept: perceive(agent, cfg, view),
      choice: { goal: 'scavenge', score: 1, alternative: null }, hours: seconds / 3600, worldTime: this.#time,
      log: this.log, rng: this.#rng, services: this.#services() }, carcass);
    agent.currentGoal = 'scavenge';
    return true;
  }

  /** @internal — lets the breed helper share the world view type. */
  __viewForTest(): WorldView { return this.#view(); }
  /** @internal Tests that move animals between steps rebuild the per-patch index. */
  __reindexForTest(): void { this.#reindex(); }

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
    for (const _ of this.stepSlices(hours)) { /* run the whole step at once */ }
  }

  /**
   * The step, in slices: it yields between phases and between animals, so a host can let other
   * work run during a long hour. Nothing outside the world may change it between slices (the
   * host holds commands while a step is in progress); drained at once, it is exactly `step`.
   */
  *stepSlices(hours: number): Generator<void> {
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('step hours must be finite and positive');
    // sim_0.38.0: the clock moves in whole seconds, as every recorded trace starts on one. A
    // part-hour step such as 0.1 + 0.2 h (1080.0000000000002 s) left it between seconds, and a
    // later tree descent refused its start time and stopped the world mid-step.
    const seconds = Math.round(hours * WORLD_SECONDS_PER_HOUR);
    if (seconds === 0 || Math.abs(hours * WORLD_SECONDS_PER_HOUR - seconds) > 1e-6)
      throw new Error('step hours must be whole seconds');
    // All ecological cohorts and encounters use the same hourly decision boundary. Long
    // calls cannot skip a fish or contact gate or count an hour twice.
    if (hours > 1) {
      let remaining = seconds;
      while (remaining > WORLD_SECONDS_PER_HOUR) { yield* this.stepSlices(1); remaining -= WORLD_SECONDS_PER_HOUR; }
      if (remaining > 0) yield* this.stepSlices(remaining / WORLD_SECONDS_PER_HOUR);
      return;
    }
    for (const agent of this.agents) locateAgent(this.grid, agent);
    const season = seasonAt(this.#time, this.terrainProfile);
    // Congo 1B: the flooded forest floods in the rains and drains in the drier spells.
    if (isCongoProfile(this.terrainProfile)) for (const patch of this.patches)
      if (patch.habitat === 'flooded_forest') patch.flooded = isFlooded(patch, season);
    yield;

    updateDrainage(this.grid, this.patches, hours, season, this.waterBudget, this.#options.rainfallScale ?? 1);
    yield;
    for (let i = 0; i < this.patches.length; i++) {
      const patch = this.patches[i]!;
      growPlants(patch, hours, season);
      growRooting(patch, hours, season);
      if ((i & 4095) === 4095) yield;
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

    yield;
    const fishTransitions = stepMicroEcology(this.microEcology, this.patches, this.carcasses, hours, season, this.#time, this.terrainProfile);
    yield;
    const floweringTransitions = stepFloweringGuild(this.patches, this.microEcology,
      hours, this.#time + hours * WORLD_SECONDS_PER_HOUR);
    yield;

    // Move the tick's dead into the permanent record and out of every loop that follows.
    if (this.agents.some((a) => !a.alive)) {
      for (let i = this.agents.length - 1; i >= 0; i--) {
        const agent = this.agents[i]!;
        if (agent.alive) continue;
        this.deceased.push(agent);
        this.agents.splice(i, 1);
      }
    }

    yield;
    this.#reindex();
    const view = this.#view();
    const services = this.#services();
    const familyStarts = new Map<string, FamilyLocation>(this.agents.map((a) =>
      [a.id, { patchId: a.patchId, position: { ...locateAgent(this.grid, a) } }]));
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
      establishNursingSites(this.grid, parent, children, cfg, this.#time, this.log);
      const target = chooseCareTarget(parent, children, cfg, this.#time, hours);
      if (target) careTargets.set(id, target);
    }
    const careVisits: CareVisit[] = [];
    const deferredYoungNeeds: Array<{ agent: Agent; cfg: SpeciesConfig; choice: ReturnType<typeof selectGoal> }> = [];
    const courtshipVisits: CourtshipVisit[] = [];
    const maleCourtshipVisits = new Map<string, CourtshipVisit>();
    const processedAgents = new Set<string>();
    this.#stepProcessed = processedAgents;
    this.#packHunted.clear();
    this.#carried.clear();
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
      if (canWaitForPackFood(this.grid, donor, familyStarts.get(recipient.id)!, cfg, this.patches, this.#time, hours)) packWaiters.add(recipient.id);
    }

    // Rivals for range, gathered once a tick for the species that hold territories.
    const rangeHolders = new Map<string, Agent[]>();
    for (const agent of this.agents) {
      if (!agent.alive || this.species.get(agent.speciesId)!.social.territory === undefined) continue;
      const list = rangeHolders.get(agent.speciesId);
      if (list === undefined) rangeHolders.set(agent.speciesId, [agent]);
      else list.push(agent);
    }

    // A pack decides together before its sated members range away. Reorder only slots within
    // each pack; other species keep their turn. Joiners consume the same #packHunted budget,
    // so no animal wanders and then takes a second journey to a kill in this hour.
    const packOrder = new Map<string, Agent[]>();
    for (const agent of this.agents) {
      const cfg = this.species.get(agent.speciesId)!;
      if (agent.groupId && cfg.hunting?.packHuntRadiusM !== undefined) {
        const members = packOrder.get(agent.groupId) ?? [];
        members.push(agent); packOrder.set(agent.groupId, members);
      }
    }
    const priority = (a: Agent): number => {
      const cfg = this.species.get(a.speciesId)!;
      return !a.controller && canHuntIndependently(a, cfg) && !this.#keepsDen(a, cfg)
        && !a.packFood && a.drives.thirst < 0.65 && a.drives.fear < 0.5 ? a.drives.hunger : -1;
    };
    for (const members of packOrder.values()) {
      const leader = members.findIndex(a => priority(a) >= (this.species.get(a.speciesId)!.hunting!.huntFromHunger ?? 0));
      if (leader > 0) members.unshift(...members.splice(leader, 1));
    }
    const packIndex = new Map<string, number>();
    let previous: Agent | null = null, logMark = this.log.size();
    for (let turn = 0; turn < this.agents.length; turn++) {
      if (turn > 0 && (turn & 63) === 0) yield;
      const original = this.agents[turn]!;
      const members = original.groupId ? packOrder.get(original.groupId) : undefined;
      const index = packIndex.get(original.groupId ?? '') ?? 0;
      // Births append to the live array during the step and retain their original same-hour turn.
      const agent = members?.[index] ?? original;
      if (members) packIndex.set(original.groupId!, index + 1);
      // The previous animal's turn may have moved it, its prey, its young or its packmates.
      this.#refileTurn(previous, logMark);
      previous = agent; logMark = this.log.size();
      if (!agent.alive) continue;
      processedAgents.add(agent.id);
      const cfg = this.species.get(agent.speciesId)!;

      updateDrives(agent, cfg, hours);
      digestGut(agent, cfg, hours);
      updateCondition(agent, cfg, Math.floor(this.#time / WORLD_SECONDS_PER_DAY));
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
          // Congo 1B: a bonded pair's young leaves its parents' group, free to find its own mate.
          if (cfg.social.pairBond) this.#leaveGroup(agent);
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

      // Congo 1B: a diver stays under until its dive ends, then surfaces and decides as usual.
      if (agent.locomotionMode === 'submerged') {
        if ((agent.submergedUntil ?? 0) > this.#time) { agent.state = 'resting'; continue; }
        surface(agent, this.grid, this.patches);
      }

      // A perched animal cannot take a ground-only action. Stay at the fixed trunk while
      // a local threat remains, then spend real time descending; depleted canopy keeps a
      // stable remnant for that descent. Urgent needs compel descent despite the threat.
      if ((agent.altitudeM ?? 0) > 0 && agent.locomotionMode === 'climb') {
        const patch = this.patches[agent.patchId]!;
        const canopyLost = treeAnchorForPatch(this.grid, patch) === null;
        // Stays up while the threat frightens it (sim_0.34.0: a predator merely in sight no longer holds it there).
        const threatened = (perceive(agent, cfg, view).threat?.fear ?? 0) >= 0.5;
        const urgentNeed = agent.drives.thirst >= 0.72 || agent.drives.hunger >= 0.8;
        // A canopy dweller lives up there: it comes down to forage or drink, not because it is safe.
        const dweller = cfg.locomotion.canopyDweller === true;
        const forage = agent.drives.hunger >= CANOPY_FORAGE_DRIVE || agent.drives.thirst >= CANOPY_FORAGE_DRIVE;
        if (canopyLost || urgentNeed || !threatened && (!dweller || forage)) {
          descendPerchedAnimal(this.grid, agent, patch, this.#time, hours,
            canopyLost ? 'canopy_lost' : threatened ? 'urgent_need' : dweller ? 'forage' : 'threat_gone',
            this.log, cfg.locomotion.climbsTrees === true);
        } else {
          agent.currentGoal = 'rest'; agent.alternativeGoal = null; agent.goalScore = 1;
          agent.state = 'resting';
        }
        continue;
      }

      if (isReadyToGiveBirth(agent, cfg, this.#time)) { this.#giveBirth(agent, cfg); continue; }
      // The joint encounter already consumed this prey's action; physiology above still runs.
      if (agent.lastEncounterAt === this.#time) continue;
      // A packmate that joined a pack hunt this hour has spent its decision (sim_0.36.0).
      if (this.#packHunted.has(agent.id)) continue;
      // sim_0.38.0: so has an infant its mother carried this hour. Deciding afterwards, a calm one
      // walked straight back to where she set off and lay there alone.
      if (this.#carried.has(agent.id)) continue;
      // An outside agent steers this animal: the live layer decides where it goes and what
      // it does. Its body has aged, hungered and faced every hazard above like any other.
      if (agent.controller) continue;
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
          confidence: 'authoritative', position: { ...locateAgent(this.grid, agent) } });
        continue;
      }
      if (!careTargets.has(agent.id) && !packTargets.has(agent.id) && !packWaiters.has(agent.id)
        && !floater && this.#tryBreed(agent, cfg, view, familyStarts, processedAgents, hours,
          courtshipVisits, maleCourtshipVisits)) continue;

      const percept = perceive(agent, cfg, view);

      // An animal that detects a predator that hunts it is afraid at once, by how close the
      // predator is and what it is visibly doing (perceive, sim_0.34.0); fear no longer creeps
      // up 0.3 an hour against its own decay. Where the species shares alarm, so does every
      // other of its kind standing with it, and species that heed its alarm call (chital and
      // langur heed each other's, Newton 1989) take it up too.
      if (percept.threat !== null) {
        agent.drives.fear = Math.min(1, Math.max(agent.drives.fear, percept.threat.fear));
        if (cfg.social.alarmSharing) {
          for (const other of view.agentsInPatch(agent.patchId)) {
            if (!other.alive || other.id === agent.id) continue;
            const heeds = other.speciesId === agent.speciesId
              || (this.species.get(other.speciesId)?.social.heedsAlarmOf ?? []).includes(agent.speciesId);
            if (heeds) other.drives.fear = Math.min(1, Math.max(other.drives.fear, agent.drives.fear * 0.7));
          }
        }
      }

      const choice = selectGoal(agent, cfg, percept, this.#rng, this.#litterHunger(agent, cfg, childrenByParent.get(agent.id) ?? []), this.#time);
      // sim_0.34.0: family and pack routines yield to fear, not to the mere detection of a
      // predator. With prey now sensing predators hundreds of metres off, the old "no threat
      // in view" gate stopped piglets regrouping with the sow and left whole litters to die
      // of thirst within sight of a resting tiger. A frightened animal still breaks off.
      const calm = agent.drives.fear < 0.5;
      const careTarget = careTargets.get(agent.id);
      const careStart = careTarget && (cfg.lifecycle.nursing ? careTarget.nursingSite : familyStarts.get(careTarget.id));
      // Hold only for an already loaded, route-reachable pack member, not for an empty promise.
      // A local mother may keep caring; a remote mother cannot walk away and receive at her old point.
      if (packWaiters.has(agent.id) && calm && agent.drives.thirst < 0.8
        && !(careTarget && availableForCare(agent, careTarget) && inCareContact(this.grid, agent, careTarget, cfg))) {
        agent.currentGoal = 'wait_for_pack_food'; agent.state = 'resting'; agent.alternativeGoal = null;
        agent.goalScore = 1; agent.targetId = null; delete agent.journey; continue;
      }
      // sim_0.32.0: danger stops care through fear (availableForCare), as it stops everything
      // else. A predator merely sharing the parent's 300 m patch no longer vetoes care while the
      // same parent goes on grazing and wandering beside it: with dholes and tigers in a third of
      // the island's patches, chital and squirrel mothers were blocked from 31-36 hours in 48
      // and their young died of thirst a day short of weaning.
      if (careStart && careTarget?.alive && availableForCare(agent, careTarget)) {
        careVisits.push(travelToFamily(this.grid, agent, cfg, this.patches, careStart, 'care_for_young', this.#time, hours, this.log));
        continue;
      }
      const packRecipient = packTargets.get(agent.id);
      if (packRecipient?.alive && calm && packDonorEligible(agent, cfg, nursingParents)) {
        if (agent.packFood) {
          const delivery = beginPackDelivery(this.grid, agent, packRecipient, familyStarts.get(packRecipient.id)!, cfg,
            this.patches, this.#time, hours, this.log);
          if (delivery) { packDeliveries.push(delivery); continue; }
        } else if (percept.carrion) {
          const collection = beginPackCollection(this.grid, agent, packRecipient, percept.carrion.carcass, cfg,
            this.patches, this.#time, hours, this.log);
          if (collection) { packCollections.push(collection); continue; }
        } else if (percept.prey.length && (activityAt(cfg, this.#time) >= 0.5 || agent.drives.hunger >= HUNGER_DESPERATION)) {
          // Pack demand can motivate a real hunt; no bonus success or newborn hunting ability.
          // sim_0.37.0: only in the pack's active hours, as any hunt.
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
        && calm;
      // sim_0.36.0: a litter gathers to its parent's care point. Island traces found boar
      // piglets and jackal pups scattered 6-45 m apart within one patch (a chase displaces the
      // young it fails to catch) while their mother, beside them all day, could reach only one
      // spot an hour: each young got one visit in six and died of thirst. Piglets gather to the
      // sow at every nursing and pups come to the adult returning to the den, so young old enough
      // to walk (gatherFromDays) now walk to the sibling she is visiting and are fed together.
      const gathering = !mobileDependent && !!careSite && !cfg.lifecycle.nursing && needsProvisioning(agent, cfg)
        && canGatherToParent(agent, cfg) && !!parent?.alive && calm;
      const independentNeed = choice.goal === 'find_food' || choice.goal === 'find_water';
      const urgentNeed = choice.goal === 'find_water' && agent.drives.thirst >= DEPENDENT_URGENT_THIRST
        || choice.goal === 'find_food' && agent.drives.hunger >= DEPENDENT_URGENT_HUNGER;
      if ((mobileDependent || gathering) && !urgentNeed) {
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
            nursingArrivals.set(agent.id, travelToFamily(this.grid, agent, cfg, this.patches, rendezvous,
              'follow_parent', this.#time, hours, this.log));
            continue;
          }
        }
      }
      if (parent?.alive && cfg.lifecycle.nursing && needsProvisioning(agent, cfg) && agent.nursingSite
        && agent.ageDays >= cfg.lifecycle.nursing.locomotionFromDays && calm
        && nursingEligible(agent, cfg, this.#time, this.#time + hours * 3600)) {
        nursingArrivals.set(agent.id, travelToFamily(this.grid, agent, cfg, this.patches, agent.nursingSite,
          'seek_nursing', this.#time, hours, this.log));
        continue;
      }
      if (parent?.alive && parentStart && canFollowParent(agent, cfg)
        && !careTargets.has(parent.id) && calm && ['rest', 'wander'].includes(choice.goal)
        && (needsProvisioning(agent, cfg) || agent.drives.fatigue < 0.6)
        && Math.hypot(agent.position!.x - parentStart.position.x, agent.position!.z - parentStart.position.z)
          <= Math.max(cfg.senses.sightRangeM, cfg.senses.hearingRangeM)) {
        travelToFamily(this.grid, agent, cfg, this.patches, parentStart, 'follow_parent', this.#time, hours, this.log);
        continue;
      }
      // sim_0.37.0: a den mother stays at the den. For the first two months a dhole mother stays
      // with her pups almost full-time and the pack feeds her there (Johnsingh 1982; pack members
      // carry meat in their stomachs and bring it up for her and the pups). Island traces of the
      // sim_0.36 collapses found the mother out hunting alone two weeks after the birth, seen at
      // 100 m by the deer she stalked; she starved, then her pups. She still drinks, answers fear,
      // takes what carriers bring her (above), and hunts again once her hunger is desperate.
      const den = calm && agent.drives.hunger < HUNGER_DESPERATION && ['hunt', 'wander', 'scavenge', 'rest'].includes(choice.goal)
        ? this.#denSite(agent, cfg, childrenByParent.get(agent.id) ?? [], familyStarts) : null;
      if (den) {
        const here = locateAgent(this.grid, agent);
        if (den.patchId !== agent.patchId || Math.hypot(here.x - den.position.x, here.z - den.position.z) > careRadius(cfg)) {
          travelToFamily(this.grid, agent, cfg, this.patches, den, 'care_for_young', this.#time, hours, this.log);
        } else {
          executeGoal({ agent, species: cfg, patches: this.patches, view, percept,
            choice: { goal: 'rest', score: choice.score, alternative: choice.goal }, hours, worldTime: this.#time,
            log: this.log, rng: this.#rng, services });
        }
        continue;
      }
      // A parent of young that cannot follow wanders only within reach of them (sim_0.32.0).
      const tether = choice.goal === 'wander' && calm
        ? idleRangeAnchor(this.grid, agent, cfg, childrenByParent.get(agent.id) ?? [], familyStarts, this.patches) : null;
      if (tether) {
        travelToFamily(this.grid, agent, cfg, this.patches, tether, 'care_for_young', this.#time, hours, this.log);
        continue;
      }
      // A hunter stays with an unfinished kill instead of wandering off from it (sim_0.33.0).
      // A predator with stomach room also feeds at its kill rather than resting away from it
      // (sim_0.35.0); a full one rests where it is.
      const kill = calm && (choice.goal === 'wander' || choice.goal === 'rest' && gutCapacityKg(agent, cfg) > 0
        && mealRoom(agent, cfg) >= needsOf(agent, cfg).foodKg / 8) ? this.#unfinishedKill(agent, cfg) : null;
      if (kill) {
        executeGoal({ agent, species: cfg, patches: this.patches, view, percept: { ...percept, carrion: kill },
          choice: { goal: 'scavenge', score: choice.score, alternative: choice.goal }, hours, worldTime: this.#time,
          log: this.log, rng: this.#rng, services });
        continue;
      }
      executeGoal({
        agent, species: cfg, patches: this.patches, view, percept, choice,
        hours, worldTime: this.#time, log: this.log, rng: this.#rng, services,
      });
    }

    yield;
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
    for (const collection of packCollections) finishPackCollection(this.grid, collection, this.species.get(collection.visit.parent.speciesId)!,
      this.carcasses, stillNursing, this.log);
    // Delivery is after maternal provisioning: reserves received at this hour's end cannot
    // retroactively fund milk earlier in the same decision. They are available next decision.
    for (const delivery of packDeliveries) finishPackDelivery(this.grid, delivery, this.species.get(delivery.visit.parent.speciesId)!,
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
      const wasPregnant = visit.female.pregnantSince !== null;
      finishCourtship(this.grid, visit, cfg, this.#time, this.#time + hours * 3600, density, this.#rng, this.log,
        this.#packAllowsBreeding(visit.female, cfg));
      // Congo 1B: a bonded pair forms when an unpaired female conceives with an unpaired male.
      if (cfg.social.pairBond && !wasPregnant && visit.female.pregnantSince !== null) this.#bond(visit.female, visit.male, cfg);
    }
    yield;
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
            - Math.hypot(bv.x - person.position.x, bv.z - person.position.z) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        }).map(a => ({ ...a, alive: true, patchId: familyStarts.get(a.id)!.patchId,
          position: { ...familyStarts.get(a.id)!.position } }))[0] ?? null,
        preyById: (id) => this.#agentsById.get(id) ?? null,
        kill: (prey, hunter, at, taskEventId) => this.#kill(prey, 'predation', hunter.id,
          { at, causalParent: taskEventId }),
      } : undefined);
    // Settle illness only after every animal and community action in this decision. A meal
    // acquired at the end cannot incubate retroactively, and a human/predator kill wins over a
    // later disease hazard instead of creating a second death or carcass.
    yield;
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
    if (Math.floor(decisionEnd / WORLD_SECONDS_PER_DAY) > Math.floor(this.#time / WORLD_SECONDS_PER_DAY))
      this.#islandArrival(decisionEnd);
    this.#pruneGroups();
    this.#time += seconds;
  }
}

/**
 * Congo 1B: a pair species' living, grown pair-mate (the other sex in its group), or null: a
 * paired animal courts only it; a widow, or one never paired, may court any.
 */
export function pairMateFor(agent: Agent, cfg: SpeciesConfig, members: readonly Agent[],
  kin: (a: Agent, b: Agent) => boolean = () => false): Agent | null {
  if (!cfg.social.pairBond || agent.groupId == null) return null;
  return members.find((a) => a.alive && a.groupId === agent.groupId && a.id !== agent.id && a.sex !== agent.sex
    && a.lifeStage !== 'newborn' && a.lifeStage !== 'juvenile' && !kin(agent, a)) ?? null;
}

export function createWorld(options: WorldOptions): World {
  return new World(options);
}
