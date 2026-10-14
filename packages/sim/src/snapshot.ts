import type { Agent, Carcass, Patch, RngState, WorldTime, WaterBudget, TerrainProfile, MicroEcologyState } from '@vana/shared';
import { ISLAND_GRID, fliesSpecies, gridForProfile, isCongoProfile, isIslandProfile, islandGeometrySeed, yearOf } from '@vana/shared';
import { positionInPatch, patchAtPosition, isCommunityState, type CommunityState } from '@vana/shared';
import { humanWalkable } from './communityNavigation.js';
import { validateIllness } from './agents/illness.js';
import { validateWound } from './agents/wound.js';
import { validateVerticalCheckpoint } from './agents/arboreal.js';
import { islandFreshwaterBasinIds } from './grid.js';
import { loadSpeciesDir } from './config/loader.js';
import { establishRooting, validateRooting } from './fields/rooting.js';
import { newWaterBudget } from './fields/drainage.js';
import { establishFloweringGuild, floweringEligible, validateFloweringGuild } from './fields/floweringGuild.js';
import { fishHabitat } from './fields/microEcology.js';
import type { NutrientLedger } from './fields/nutrients.js';
import { SIM_VERSION, World, type WorldOptions } from './world.js';

export interface Snapshot {
  community?: CommunityState;
  simVersion: string;
  terrainProfile?: TerrainProfile;
  worldTime: WorldTime;
  seed: number;
  patches: Patch[];
  agents: Agent[];
  ledger: NutrientLedger;
  waterBudget?: WaterBudget;
  microEcology?: MicroEcologyState;
  agentSeq: number;
  rngState: RngState;
  /** Optional only for migration from legacy random event IDs. */
  eventSequence?: number;
  carcasses: Carcass[];
  carcassSeq: number;
  deceased: Agent[];
  groupSeq: number;
  groups: Array<[string, { speciesId: string; memberIds: string[] }]>;
  pedigree: Array<[string, { mother: string | null; father: string | null }]>;
  /** sim_0.33.0 island only: last arrival time per species, present once any has arrived. */
  islandArrivals?: Record<string, WorldTime>;
  /**
   * sim_0.37.0: recorded arrivals an explicit upgrade scheduled (an upgraded island's leopard
   * pair). They come ashore at the next day boundary; absent once they have.
   */
  pendingArrivals?: Array<{ speciesId: string; sex: 'female' | 'male'; trigger: string }>;
}

export function takeSnapshot(world: World): Snapshot {
  const state = world.__exportState();
  return {
    ...(world.community ? { community: structuredClone(world.community) } : {}),
    simVersion: SIM_VERSION,
    terrainProfile: world.terrainProfile,
    worldTime: world.now(),
    seed: state.seed,
    patches: structuredClone(world.patches),
    agents: structuredClone(world.agents),
    ledger: { ...world.ledger },
    waterBudget: { ...world.waterBudget },
    microEcology: structuredClone(world.microEcology),
    agentSeq: state.agentSeq,
    rngState: state.rngState,
    eventSequence: world.log.exportSequence(),
    carcasses: structuredClone(world.carcasses),
    carcassSeq: state.carcassSeq,
    deceased: structuredClone(world.deceased),
    groupSeq: state.groupSeq,
    groups: structuredClone(state.groups),
    pedigree: structuredClone(state.pedigree),
    ...(Object.keys(world.islandArrivals).length ? { islandArrivals: { ...world.islandArrivals } } : {}),
    ...(world.pendingArrivals.length ? { pendingArrivals: structuredClone(world.pendingArrivals) } : {}),
  };
}

/** How many records a slice of checkpoint work handles before yielding (Congo 1A.3). */
const SNAPSHOT_SLICE = 1_000;
/** Copying is heavier than serializing: a quarter as many records per slice. */
const CLONE_SLICE = 250;

function* cloneInSlices<T>(items: readonly T[]): Generator<void, T[]> {
  const out = new Array<T>(items.length);
  for (let i = 0; i < items.length; i++) {
    out[i] = structuredClone(items[i]!);
    if ((i + 1) % CLONE_SLICE === 0) yield;
  }
  return out;
}

/**
 * `takeSnapshot`, in slices: the large arrays are copied a slice at a time, so a host can let
 * other work run while a large world is checkpointed. The world must not change until it
 * returns (the host holds commands meanwhile). The result deep-equals `takeSnapshot(world)`.
 */
export function* takeSnapshotSlices(world: World): Generator<void, Snapshot> {
  const state = world.__exportState();
  const community = world.community ? structuredClone(world.community) : null;
  const patches = yield* cloneInSlices(world.patches);
  const agents = yield* cloneInSlices(world.agents);
  const microEcology = structuredClone(world.microEcology);
  yield;
  const carcasses = yield* cloneInSlices(world.carcasses);
  const deceased = yield* cloneInSlices(world.deceased);
  return {
    ...(community ? { community } : {}),
    simVersion: SIM_VERSION,
    terrainProfile: world.terrainProfile,
    worldTime: world.now(),
    seed: state.seed,
    patches,
    agents,
    ledger: { ...world.ledger },
    waterBudget: { ...world.waterBudget },
    microEcology,
    agentSeq: state.agentSeq,
    rngState: state.rngState,
    eventSequence: world.log.exportSequence(),
    carcasses,
    carcassSeq: state.carcassSeq,
    deceased,
    groupSeq: state.groupSeq,
    groups: structuredClone(state.groups),
    pedigree: structuredClone(state.pedigree),
    ...(Object.keys(world.islandArrivals).length ? { islandArrivals: { ...world.islandArrivals } } : {}),
    ...(world.pendingArrivals.length ? { pendingArrivals: structuredClone(world.pendingArrivals) } : {}),
  };
}

/**
 * A snapshot as JSON, in fragments: its large arrays one slice of records at a time. Joined, the
 * fragments are byte for byte `JSON.stringify(snapshot)`.
 */
export function* snapshotJson(snapshot: Snapshot): Generator<string> {
  let pending = '';
  // Fragments accumulate into `pending` and are handed out a slice of records at a time.
  function* value(v: unknown): Generator<string> {
    if (Array.isArray(v) && v.length > SNAPSHOT_SLICE) {
      pending += '[';
      for (let i = 0; i < v.length; i++) {
        if (i) pending += ',';
        yield* value(v[i]);
        if ((i + 1) % SNAPSHOT_SLICE === 0) { yield pending; pending = ''; }
      }
      pending += ']';
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
      && Object.values(v).some((x) => Array.isArray(x) && x.length > SNAPSHOT_SLICE || x !== null && typeof x === 'object' && !Array.isArray(x))) {
      pending += '{';
      let first = true, count = 0;
      for (const [key, x] of Object.entries(v)) {
        if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
        pending += (first ? '' : ',') + JSON.stringify(key) + ':';
        first = false;
        yield* value(x);
        if (++count % SNAPSHOT_SLICE === 0) { yield pending; pending = ''; }
      }
      pending += '}';
    } else {
      pending += JSON.stringify(v) ?? 'null';
    }
  }
  yield* value(snapshot);
  yield pending;
}

export function restoreSnapshot(snapshot: Snapshot, options: WorldOptions): World {
  if ((snapshot.community?.profile ?? 'none') !== (options.communityProfile ?? 'none'))
    throw new Error('community profile mismatch: use a new database; never add or remove a saved household silently');
  if (snapshot.community && (!isCommunityState(snapshot.community, gridForProfile(snapshot.terrainProfile ?? 'mainland')) || snapshot.community.updatedAt !== snapshot.worldTime))
    throw new Error('invalid community checkpoint');
  if ((snapshot.terrainProfile ?? 'mainland') !== (options.terrainProfile ?? 'mainland'))
    throw new Error('terrain profile mismatch: never reshape an existing world; use a separate database');
  if (snapshot.simVersion !== SIM_VERSION) {
    throw new Error(
      `snapshot sim version ${snapshot.simVersion} does not match runtime ${SIM_VERSION}`,
    );
  }
  if (snapshot.microEcology?.patches.some(patch => !Number.isFinite(patch.aquaticProducerBiomassKg)
    || patch.aquaticProducerBiomassKg < 0))
    throw new Error('invalid aquatic producer checkpoint');
  if (snapshot.microEcology?.patches.some(patch => !Number.isSafeInteger(patch.lastFishSpawnYear)
    || patch.lastFishSpawnYear < 0 || patch.lastFishSpawnYear > yearOf(snapshot.worldTime)
    || patch.fishCohort && (!Number.isFinite(patch.fishCohort.biomassKg)
      || patch.fishCohort.biomassKg < 0 || !Number.isFinite(patch.fishCohort.spawnedAt)
      || patch.fishCohort.spawnedAt < 0 || patch.fishCohort.spawnedAt > snapshot.worldTime
      || !Number.isFinite(patch.fishCohort.hatchAt) || !Number.isFinite(patch.fishCohort.recruitAt)
      || patch.fishCohort.hatchAt <= patch.fishCohort.spawnedAt
      || patch.fishCohort.recruitAt <= patch.fishCohort.hatchAt
      || patch.fishCohort.recruitAt <= snapshot.worldTime
      || patch.lastFishSpawnYear !== yearOf(patch.fishCohort.spawnedAt)
      || patch.fishCohort.stage === 'eggs' && patch.fishCohort.hatchAt <= snapshot.worldTime
      || patch.fishCohort.stage === 'larvae' && patch.fishCohort.hatchAt > snapshot.worldTime
      || !['eggs', 'larvae'].includes(patch.fishCohort.stage)
      || snapshot.patches[patch.patchId]?.surface === 'ocean'
      || snapshot.patches[patch.patchId]?.surface === 'coast'
      || !fishHabitat(snapshot.patches[patch.patchId]?.habitat ?? '')
      || (snapshot.patches[patch.patchId]?.waterVolume ?? 0) < 20)))
    throw new Error('invalid fish recruitment checkpoint');
  const configs = [...loadSpeciesDir(options.speciesDir)];
  const climbers = new Set(configs.filter(([, cfg]) => cfg.locomotion.climbsTrees).map(([id]) => id));
  const flyers = new Set(configs.filter(([, cfg]) => fliesSpecies(cfg)).map(([id]) => id));
  for (const agent of [...snapshot.agents, ...snapshot.deceased]) {
    validateIllness(agent.illness, snapshot.worldTime);
    validateWound(agent.wound, snapshot.worldTime);
    validateVerticalCheckpoint(gridForProfile(snapshot.terrainProfile ?? 'mainland'), agent, snapshot.patches[agent.patchId], climbers.has(agent.speciesId), flyers.has(agent.speciesId));
    if (agent.lastMaternalWaterAt !== undefined
      && (!Number.isFinite(agent.lastMaternalWaterAt) || agent.lastMaternalWaterAt < agent.bornAt
        || agent.lastMaternalWaterAt > snapshot.worldTime || agent.speciesId !== 'boar'))
      throw new Error('invalid maternal water-care checkpoint');
  }
  // A Congo checkpoint saved before its forest flowered has no guild anywhere: give it one, as the
  // island's rules upgrade did. A guild missing from only some forest is damage, and is refused.
  if (isCongoProfile(snapshot.terrainProfile) && snapshot.patches.every((p) => p.floweringGuild === undefined))
    establishFloweringGuild(snapshot.patches, snapshot.worldTime, true);
  for (const patch of snapshot.patches) {
    if (floweringEligible(patch) !== (patch.floweringGuild !== undefined))
      throw new Error('missing or misplaced flowering guild checkpoint');
    validateFloweringGuild(patch, snapshot.worldTime);
    // sim_0.37.0: rooting food only on eligible land, never negative or above its capacity.
    validateRooting(patch);
  }

  // Build an empty world, then overwrite its state from the snapshot.
  // Restore never re-founds a household or emits a second founding event.
  const world = new World({ ...options, seed: snapshot.seed, initialAgents: {}, communityProfile: 'none' });
  if (isIslandProfile(world.terrainProfile) && (snapshot.patches.length !== world.patches.length
    || snapshot.patches.some((p, i) => p.id !== i || p.islandSeed !== islandGeometrySeed(snapshot.seed, world.terrainProfile)
      || p.surface !== world.patches[i]!.surface || p.elevation !== world.patches[i]!.elevation
      || p.habitat !== world.patches[i]!.habitat)))
    throw new Error('island checkpoint geometry does not match its versioned seed');
  if (world.terrainProfile === 'mainland' && snapshot.patches.some(p => p.islandSeed !== undefined || p.surface !== undefined))
    throw new Error('mainland checkpoint contains island geometry');
  if (isCongoProfile(world.terrainProfile) && (snapshot.patches.length !== world.patches.length
    || snapshot.patches.some((p, i) => p.id !== i || p.congoSeed !== snapshot.seed || p.islandSeed !== undefined
      || p.elevation !== world.patches[i]!.elevation || p.habitat !== world.patches[i]!.habitat)))
    throw new Error('congo checkpoint geometry does not match its versioned seed');
  if (!isCongoProfile(world.terrainProfile) && snapshot.patches.some(p => p.congoSeed !== undefined))
    throw new Error('checkpoint contains Congo geometry for another profile');
  world.log.restoreSequence(snapshot.eventSequence ?? 0);
  world.community = snapshot.community ? structuredClone(snapshot.community) : null;

  world.patches.length = 0;
  world.patches.push(...structuredClone(snapshot.patches));
  if (world.community && !world.patches.some(p => p.id === world.community!.patchId
    && p.surface !== 'ocean' && p.surface !== 'coast' && !['water', 'marsh'].includes(p.habitat)))
    throw new Error('community checkpoint has no dry land site');
  if (world.community && world.community.version >= 5 && world.community.people.some(person =>
    !humanWalkable(world.patches[person.patchId]) || person.task?.journey?.waypoints.some(point =>
      !humanWalkable(world.patches[patchAtPosition(world.grid, point)]))))
    throw new Error('community checkpoint contains a non-walkable person route');
  world.waterBudget = snapshot.waterBudget ? structuredClone(snapshot.waterBudget) : newWaterBudget(world.patches, snapshot.worldTime);
  world.agents.length = 0;
  world.agents.push(...structuredClone(snapshot.agents));
  // Congo 1C: an owned animal names its asset, and only the Congo world holds owned animals.
  if (world.agents.some((a) => a.assetId !== undefined && (typeof a.assetId !== 'string' || !a.assetId || !isCongoProfile(world.terrainProfile))))
    throw new Error('invalid owned animal in checkpoint');
  world.carcasses.length = 0;
  world.carcasses.push(...structuredClone(snapshot.carcasses ?? []));
  if (world.carcasses.some(c => c.cachedBy !== undefined && (typeof c.cachedBy !== 'string' || !c.cachedBy || c.cause !== 'predation')))
    throw new Error('invalid cached kill checkpoint');
  world.deceased.length = 0;
  world.deceased.push(...structuredClone(snapshot.deceased ?? []));
  // Old snapshots overloaded the hunt target. Recover only an unambiguous same-species sire;
  // never turn a prey target into parentage. Already-lost history cannot be reconstructed.
  const ancestors = new Map([...world.agents, ...world.deceased].map((a) => [a.id, a]));
  for (const mother of world.agents) {
    if (mother.pregnantSince === null || mother.pregnancyFatherId !== undefined) continue;
    const candidate = ancestors.get(mother.targetId ?? '');
    mother.pregnancyFatherId = candidate?.sex === 'male' && candidate.speciesId === mother.speciesId
      ? candidate.id : null;
  }
  if (snapshot.islandArrivals !== undefined) {
    if (!isIslandProfile(world.terrainProfile) || Object.entries(snapshot.islandArrivals).some(([speciesId, at]) =>
      !world.species.get(speciesId)?.islandArrival || !Number.isFinite(at) || at < 0 || at > snapshot.worldTime))
      throw new Error('invalid island arrival checkpoint');
    Object.assign(world.islandArrivals, snapshot.islandArrivals);
  }
  if (snapshot.pendingArrivals !== undefined) {
    if (!isIslandProfile(world.terrainProfile) || !Array.isArray(snapshot.pendingArrivals)
      || snapshot.pendingArrivals.some(a => !world.species.has(a?.speciesId) || !['female', 'male'].includes(a.sex)
        || typeof a.trigger !== 'string' || !a.trigger))
      throw new Error('invalid pending arrival checkpoint');
    world.pendingArrivals.push(...structuredClone(snapshot.pendingArrivals));
  }
  for (const agent of [...world.agents, ...world.deceased]) {
    if (agent.condition === undefined) continue;
    if (!world.species.get(agent.speciesId)?.lifecycle.condition || !Number.isFinite(agent.condition)
      || agent.condition < 0 || agent.condition > 1) throw new Error('invalid body condition checkpoint');
  }
  for (const agent of [...world.agents, ...world.deceased]) {
    if (agent.gutFill === undefined) continue;
    if (world.species.get(agent.speciesId)?.diet.maxDailyIntakeKg === undefined || !Number.isSafeInteger(agent.gutFill.day)
      || agent.gutFill.day < 0 || agent.gutFill.day * 86400 > snapshot.worldTime || !Number.isFinite(agent.gutFill.kg)
      || agent.gutFill.kg < 0 || !Number.isFinite(agent.gutFill.naturalKg) || agent.gutFill.naturalKg < 0)
      throw new Error('invalid daily gut fill checkpoint');
  }
  for (const agent of world.agents) {
    if (agent.gutKg === undefined) continue;
    const cfg = world.species.get(agent.speciesId);
    const capacity = cfg?.diet.gutCapacityBodyFraction ? agent.massKg * cfg.diet.gutCapacityBodyFraction : 0;
    if (!Number.isFinite(agent.gutKg) || !(agent.gutKg > 0) || agent.gutKg > capacity + 1e-9)
      throw new Error('invalid stomach checkpoint');
  }
  world.ledger.imported = snapshot.ledger.imported;
  world.ledger.exported = snapshot.ledger.exported;
  world.__importState(
    snapshot.worldTime, snapshot.agentSeq, snapshot.rngState,
    snapshot.carcassSeq ?? 0, snapshot.groupSeq ?? 0,
    snapshot.groups ?? [], snapshot.pedigree ?? [], snapshot.microEcology,
  );

  return world;
}

/**
 * New island basins are a versioned habitat change, not retroactive rainfall. Promote the
 * deterministic land patches without adding any water. Move displaced vegetation into soil
 * so the saved nutrient ledger and the entire historical water budget stay unchanged.
 */
function upgradeIslandBasins(snapshot: Snapshot): void {
  if (snapshot.terrainProfile !== 'island_v1') return;
  for (const id of islandFreshwaterBasinIds(snapshot.patches)) {
    const patch = snapshot.patches[id]!;
    if (![patch.plant.grass, patch.plant.browse, patch.soilNutrients, patch.waterVolume]
      .every(n => Number.isFinite(n) && n >= 0)) throw new Error('invalid island basin source stock');
    patch.soilNutrients += patch.plant.grass + patch.plant.browse;
    patch.plant = { grass: 0, browse: 0 };
    patch.capacity = { grass: 0, browse: 0 };
    patch.canopyCover = 0;
    patch.habitat = 'water';
  }
}

/** No old save recorded the last maternal water transfer. Start that clock at the
 * acknowledged upgrade boundary, without creating water or altering past events. */
function initializeLegacyBoarCare(snapshot: Snapshot): void {
  for (const agent of snapshot.agents) {
    if (agent.alive && agent.speciesId === 'boar' && agent.dependentOn !== null
      && agent.ageDays < 10 && agent.lastMaternalWaterAt === undefined)
      agent.lastMaternalWaterAt = snapshot.worldTime;
  }
}

/** Old rules recorded no early-life fish; the next eligible spawn is in a later year. */
function initializeLegacyFishRecruitment(snapshot: Snapshot): void {
  if (!snapshot.microEcology) return;
  for (const patch of snapshot.microEcology.patches) {
    if (patch.fishCohort !== undefined) throw new Error('old snapshot contains future fish cohort state');
    patch.lastFishSpawnYear = yearOf(snapshot.worldTime);
  }
}

/** Split saved browse only at an explicitly authorized rules boundary. */
function finishFloweringUpgrade(snapshot: Snapshot): void {
  establishFloweringGuild(snapshot.patches, snapshot.worldTime, true);
  finishCurrentUpgrade(snapshot);
}

/**
 * sim_0.37.0: the pair of leopards an upgraded island receives. A closed island gains a species
 * only by a recorded arrival, so the upgrade schedules one male and one female to come ashore at
 * the first day boundary after the world restarts, each an authoritative, ledgered `immigration`
 * event (route `island_crossing`, trigger `rules_upgrade`). A mainland world gains its leopards
 * through its own recorded dispersal from the surrounding landscape.
 */
export const UPGRADE_ISLAND_ARRIVALS: ReadonlyArray<{ speciesId: string; sex: 'female' | 'male' }> = [
  { speciesId: 'leopard', sex: 'male' }, { speciesId: 'leopard', sex: 'female' },
];

/**
 * Every explicit upgrade lands on the current rules through here. sim_0.37.0 establishes each
 * land patch's rooting food out of its own soil nutrients (the world's nutrient total is
 * unchanged), and schedules the leopard pair's arrival on an island that has none.
 */
function finishCurrentUpgrade(snapshot: Snapshot): void {
  establishRooting(snapshot.patches);
  if (snapshot.terrainProfile === 'island_v1' && !snapshot.agents.some(a => a.alive && a.speciesId === 'leopard')
    && !snapshot.pendingArrivals?.length)
    snapshot.pendingArrivals = UPGRADE_ISLAND_ARRIVALS.map(a => ({ ...a, trigger: 'rules_upgrade' }));
  snapshot.simVersion = SIM_VERSION;
}

/** Explicit operator-controlled rules upgrade; never mutates or rewrites the old checkpoint. */
function upgradeLegacyMicroFields(snapshot: Snapshot): Snapshot {
  const upgraded = structuredClone(snapshot);
  if (upgraded.microEcology) upgraded.microEcology.patches = upgraded.microEcology.patches.map(patch => ({
    ...patch, aquaticProducerBiomassKg: patch.aquaticProducerBiomassKg ?? 0,
  }));
  upgradeIslandBasins(upgraded);
  initializeLegacyBoarCare(upgraded);
  initializeLegacyFishRecruitment(upgraded);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

export function upgradeV5Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.5.0') throw new Error('only sim_0.5.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** Explicit acknowledgement of the young-animal rules change; never silently rewrites history. */
export function upgradeV6Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.6.0') throw new Error('only sim_0.6.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** Explicit acknowledgement of contact/time-budget rules; previous history stays untouched. */
export function upgradeV7Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.7.0') throw new Error('only sim_0.7.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** Explicit acknowledgement of continuous terrain-weighted ordinary locomotion. */
export function upgradeV8Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.8.0') throw new Error('only sim_0.8.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** Explicit acknowledgement of local water-contact/time-budget rules. */
export function upgradeV9Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.9.0') throw new Error('only sim_0.9.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** Explicit acknowledgement of contact-based parental care and non-teleporting dependants. */
export function upgradeV10Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.10.0') throw new Error('only sim_0.10.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** Scheduled nursing/rendezvous changes; missing historical sites are explicitly established on the next tick. */
export function upgradeV11Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.11.0') throw new Error('only sim_0.11.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** Explicit cooperative-food rules upgrade. Existing animals acquire no fabricated food. */
export function upgradeV12Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.12.0') throw new Error('only sim_0.12.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** No historical rainfall or outflow is invented; accounting starts at the upgraded checkpoint. */
export function upgradeV13Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.13.0') throw new Error('only sim_0.13.0 snapshots can use this upgrade');
  return { ...upgradeLegacyMicroFields(snapshot),
    waterBudget: newWaterBudget(snapshot.patches, snapshot.worldTime) };
}

/** Island support does not turn an existing mainland into an island. */
export function upgradeV14Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.14.0') throw new Error('only sim_0.14.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** Courtship rules change only with explicit acknowledgement. Do not guess repairs to a
 * legacy checkpoint whose patch-only breeding move disagrees with its recorded position. */
export function upgradeV15Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.15.0') throw new Error('only sim_0.15.0 snapshots can use this upgrade');
  if (snapshot.agents.some(a => a.alive && !positionInPatch(ISLAND_GRID, a.position, a.patchId)))
    throw new Error('inconsistent v0.15 spatial checkpoint; explicit recovery review required');
  return upgradeLegacyMicroFields(snapshot);
}

/** Explicit stored-water routing fix. Preserve inventory, time and in-flight tasks;
 * never rewrite historical deaths/actions or create water on upgrade. */
export function upgradeV16Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.16.0') throw new Error('only sim_0.16.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** Explicit source-backed boar young-care rule change. Existing state and history stay intact. */
export function upgradeV17Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.17.0') throw new Error('only sim_0.17.0 snapshots can use this upgrade');
  return upgradeLegacyMicroFields(snapshot);
}

/** Add no historical producer biomass. It can grow only from the finite soil pool on future ticks. */
export function upgradeV18Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.18.0') throw new Error('only sim_0.18.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  if (upgraded.microEcology) {
    upgraded.microEcology.patches = upgraded.microEcology.patches.map(patch => ({
      ...patch, aquaticProducerBiomassKg: 0,
    }));
  }
  upgradeIslandBasins(upgraded);
  initializeLegacyBoarCare(upgraded);
  initializeLegacyFishRecruitment(upgraded);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

/** Explicit v0.19 island-basin upgrade: no historical water is invented or withdrawn. */
export function upgradeV19Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.19.0') throw new Error('only sim_0.19.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  upgradeIslandBasins(upgraded);
  initializeLegacyBoarCare(upgraded);
  initializeLegacyFishRecruitment(upgraded);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

/** A v0.20 save had no active illness episodes; do not fabricate disease on upgrade. */
export function upgradeV20Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.20.0') throw new Error('only sim_0.20.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  initializeLegacyBoarCare(upgraded);
  initializeLegacyFishRecruitment(upgraded);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

/** Opt in to viable closed-island founding and contact-bounded early boar hydration.
 * Existing young do not receive water or retroactive care at migration time. */
export function upgradeV21Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.21.0') throw new Error('only sim_0.21.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  initializeLegacyBoarCare(upgraded);
  initializeLegacyFishRecruitment(upgraded);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

/** A mobile tiger cub may seek real freshwater before full weaning under the new
 * policy. Migration adds no water, moves no animal and rewrites no past event. */
export function upgradeV22Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.22.0') throw new Error('only sim_0.22.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  initializeLegacyFishRecruitment(upgraded);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

/** Opt in to parent-opened finite carcass meals for tiger cubs. This changes only
 * future decisions: migration creates no meat, movement, consumption or event. */
export function upgradeV23Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.23.0') throw new Error('only sim_0.23.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  initializeLegacyFishRecruitment(upgraded);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

/** Opt in to recorded arboreal motion for langurs and squirrels. A ground-only
 * v0.24 save gains no altitude, anchor, movement event or retroactive protection. */
export function upgradeV24Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.24.0') throw new Error('only sim_0.24.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  initializeLegacyFishRecruitment(upgraded);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

/** Opt in to contact-grounded survivor wounds. No historical wound or event is invented. */
export function upgradeV25Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.25.0') throw new Error('only sim_0.25.0 snapshots can use this upgrade');
  if (snapshot.agents.some(agent => agent.wound !== undefined))
    throw new Error('v0.25 snapshot cannot contain a wound from future rules');
  const upgraded = structuredClone(snapshot);
  initializeLegacyFishRecruitment(upgraded);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

/** Opt in to early-life freshwater fish cohorts; migration invents no historical spawn. */
export function upgradeV26Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.26.0') throw new Error('only sim_0.26.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  initializeLegacyFishRecruitment(upgraded);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

/** A genuine v0.27 save may contain an in-flight fish cohort. Preserve it exactly. */
export function upgradeV27Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.27.0') throw new Error('only sim_0.27.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  finishFloweringUpgrade(upgraded);
  return upgraded;
}

/**
 * v0.38 corrects decisions the audit of v0.37 found wrong; see each rule's own comment. Future
 * decisions only: no state is added or reshaped, so every v0.37 state byte is kept and nothing
 * is scheduled. The upgrade exists so a saved v0.37 world, whose recorded history was made by the
 * old rules, moves to these only by explicit operator choice.
 */
export function upgradeV37Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.37.0') throw new Error('only sim_0.37.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  upgraded.simVersion = SIM_VERSION;
  return upgraded;
}

/**
 * v0.37 adds the leopard, a den mother fed by a larger dhole pack, and a food limit on wild boar:
 * each land patch gets its rooting and mast food (paid out of its own soil nutrients), and an
 * island with no leopards receives a recorded male and female at the next day boundary. Saved
 * dholes, boar and every other animal are kept as they are; body condition starts from each
 * boar's current hunger when it is first needed.
 */
export function upgradeV36Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.36.0') throw new Error('only sim_0.36.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  finishCurrentUpgrade(upgraded);
  return upgraded;
}

/**
 * v0.36 gathers litters to their parent's care point, feeds a once-daily nursing to repletion,
 * hunts dholes as a pack with field prey selection and calibrates boar piglet survival. Future
 * decisions only; every v0.35 state byte is kept and nothing new is persisted.
 */
export function upgradeV35Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.35.0') throw new Error('only sim_0.35.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  finishCurrentUpgrade(upgraded);
  return upgraded;
}

/**
 * v0.35 calibrates predator feeding to field intake: meat beyond the day's hunger fills a
 * stomach (tiger 14%, dhole 20% of body mass) digested at the daily rate, and a predator with
 * food in its stomach does not start a hunt. Future decisions only; every v0.34 state byte is
 * kept (no saved animal has a stomach until it next eats).
 */
export function upgradeV34Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.34.0') throw new Error('only sim_0.34.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  finishCurrentUpgrade(upgraded);
  return upgraded;
}

/**
 * v0.34 gives prey a landscape of fear: they detect predators that hunt them within their own
 * senses (concealment hides a stalker), fear at once by distance and posture, flee from the
 * seen predator, keep out of patches where one stands unless desperate, and chital and langur
 * heed each other's alarms. Future decisions only; every v0.33 state byte is kept.
 */
export function upgradeV33Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.33.0') throw new Error('only sim_0.33.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  finishCurrentUpgrade(upgraded);
  return upgraded;
}

/**
 * v0.33 calibrates the island's predators and admits rare recorded arrivals: a pack's range
 * holds only the land inside it (packCapacity), and tigers, elephants and jackals may swim ashore
 * when locally scarce (World islandArrival). The founding cohort change applies to new worlds
 * only; a saved world keeps every animal it has. Future decisions only; every v0.32 state byte
 * is kept, and no animal, arrival or event is granted retroactively.
 */
export function upgradeV32Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.32.0') throw new Error('only sim_0.32.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  finishCurrentUpgrade(upgraded);
  return upgraded;
}

/**
 * v0.32 changes three care decisions: hunger alone no longer stops a parent answering a
 * dependent's hydration emergency (availableForCare); a predator sharing the parent's patch
 * stops care only through the parent's fear, as it stops everything else; and a parent of
 * young that cannot yet follow wanders only within perceiving range of them (idleRangeAnchor).
 * Future decisions only; every v0.31 state byte is kept, and no care, water, movement or event
 * is granted retroactively.
 */
export function upgradeV31Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.31.0') throw new Error('only sim_0.31.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  finishCurrentUpgrade(upgraded);
  return upgraded;
}

/**
 * v0.31: nothing feeds at a carcass a predator of its kind fed from in the past hour, and
 * an outside agent may steer an animal (the optional `controller` field). Future decisions
 * only; every v0.30 state byte is kept.
 */
export function upgradeV30Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.30.0') throw new Error('only sim_0.30.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  finishCurrentUpgrade(upgraded);
  return upgraded;
}

/**
 * v0.30 moves each patch's water access point off its centre. Every state byte is kept; an
 * animal or person standing at an old centre simply walks to the new point when it next
 * drinks or fishes. Recorded history keeps its old positions and still validates.
 */
export function upgradeV29Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.29.0') throw new Error('only sim_0.29.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  finishCurrentUpgrade(upgraded);
  return upgraded;
}

/** Mate-response rules affect future decisions only; preserve every v0.28 state byte. */
export function upgradeV28Snapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.simVersion !== 'sim_0.28.0') throw new Error('only sim_0.28.0 snapshots can use this upgrade');
  const upgraded = structuredClone(snapshot);
  finishCurrentUpgrade(upgraded);
  return upgraded;
}
