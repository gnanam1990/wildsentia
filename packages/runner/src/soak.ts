import { carcassMass, landWalkable, islandHeightAt, isIslandProfile, islandGeometrySeed, positionInPatch, isCommunityState, homeCondition, type CommunityProfile, type TerrainProfile, type WorldEvent } from '@vana/shared';
import { writeFileSync } from 'node:fs';
import { FOREST_FLOOR, FOREST_LANDSCAPE, FOREST_POPULATION, SIM_VERSION, islandPopulation, careRadius, createWorld, waterBudgetResidual, surfaceWaterL } from '@vana/sim';
import type { WaterBudget } from '@vana/shared';
import { recordPopulationPeaks } from './populationMetrics.js';
import { emptySoakYear, foragePercent, recordYearEvent, sampleYearForage, unreconciledPopulations, type ParentLookup, type SoakYear, type YoungDeprivationRecord } from './yearMetrics.js';
import { recordHunt, type HuntMetrics } from './huntMetrics.js';
import { emptyHumanFamilyMetrics, recordHumanFamily, validHumanFamilyMetrics } from './communityMetrics.js';
import { emptyIllnessEventMetrics, recordIllnessEvent, type IllnessEventMetrics } from './illnessMetrics.js';
import { emptyWoundEventMetrics, recordWoundEvent, validWoundEventMetrics, type WoundEventMetrics } from './woundMetrics.js';
import { emptyFishEventMetrics, recordFishEvent, validFishEventMetrics, type FishEventMetrics } from './fishMetrics.js';
import { emptyFloweringEventMetrics, recordFloweringEvent, validFloweringEventMetrics,
  type FloweringEventMetrics } from './floweringMetrics.js';

/**
 * The soak runs the canonical forest from `@vana/sim` — the same seed counts, floors and
 * landscape the live server boots — so a passing soak speaks for the world people watch.
 */
export const SOAK_POPULATION = FOREST_POPULATION;
export const SOAK_FLOOR = FOREST_FLOOR;
export const SOAK_LANDSCAPE = FOREST_LANDSCAPE;

/**
 * Intended carrying capacity for a 36 km² world, from published field densities: hares at
 * tens per km², chital at twenty-odd in good habitat, sambar nearer five, gaur two to five,
 * tigers around 0.12, dhole in packs at roughly 0.2.
 *
 * This is deliberately separate from the seed count. Once animals breed, the number a
 * population settles at is set by the land, not by how many were placed at the start, and
 * measuring "too many" against the seed count would flag a healthy recovery as a failure.
 */
export const SOAK_CEILING: Record<string, number> = {
  chital: 3000, sambar: 1100, hare: 2500, langur: 800, squirrel: 700, boar: 1200,
  gaur: 500, elephant: 40,
  tiger: 14, dhole: 40, leopard: 12,
  jackal: 200, vulture: 90,
};

export interface SoakResult {
  simVersion: string;
  terrainProfile: TerrainProfile;
  navigableLandKm2: number;
  seed: number;
  days: number;
  /** Requested duration is not proof that all days ran. */
  completedDays: number;
  completedWorldTime: number;
  stoppedEarly: boolean;
  community: { profile: CommunityProfile; rulesVersion: number | null; alive: number; deaths: number;
    deathRecords: Array<{ personId: string; worldTime: number; cause: string }>;
    repairs: number; homeCondition: number | null;
    conceptions: number; births: number; pregnancyLosses: number; careEvents: number;
    careFoodKg: number; careWaterL: number; childrenAlive: number; childrenDead: number;
    storms: number; floods: number; collapses: number; rebuilds: number };
  finalPopulation: Record<string, number>;
  peakPopulation: Record<string, number>;
  events: number;
  nutrientDrift: number;
  hydrology: { budget: WaterBudget; storedL: number; residualL: number; maximumPatchL: number };
  huntAttempts: number;
  huntSuccessRate: number;
  huntsBySpecies: Record<string, HuntMetrics>;
  starvationByLifeStage: Record<string, number>;
  dehydrationByLifeStage: Record<string, number>;
  deprivationByCare: Record<string, number>;
  diseaseEvents: IllnessEventMetrics;
  woundEvents: WoundEventMetrics;
  fishEvents: FishEventMetrics;
  floweringEvents: FloweringEventMetrics;
  /** species/cause/careState; retains the overlap hidden by the aggregate care tally. */
  deprivationBySpeciesCare: Record<string, number>;
  packFood: {
    collections: number; deliveries: number; digestions: number;
    collectedKg: number; deliveredKg: number; digestedKg: number;
    releasedOnDeathKg: number; exportedKg: number; outstandingKg: number;
    nursingParentDeliveries: number; youngDeliveries: number;
  };
  births: number;
  birthsBySpecies: Record<string, number>;
  deathsBySpecies: Record<string, number>;
  courtshipAttempts: number;
  courtshipBySpecies: Record<string, number>;
  /** Exact authoritative event outcome/reason, so contact loss is not mistaken for chance. */
  courtshipBySpeciesOutcomeReason: Record<string, number>;
  courtshipSuccessRate: number;
  generationsReached: number;
  meanInbreeding: number;
  immigrationEvents: number;
  /** Immigration events by recorded route (`island_crossing` for sim_0.33.0 island arrivals). */
  immigrationByRoute: Record<string, number>;
  /** Every recorded island arrival (first 200), with its trigger and the body it brought. */
  islandArrivals: Array<{ worldTime: number; species: string; actorId: string; patchId: number;
    trigger: string; livingBefore: number; massKg: number; positioned: boolean }>;
  /** Nutrient imported with arrivals, as recorded by the world's ledger. */
  importedNutrient: number;
  carcassesCreated: number;
  carcassesCompleted: number;
  carcassesOutstanding: number;
  scavengeEvents: number;
  deathsByCause: Record<string, number>;
  /** Per world-year windows of `yearDays` (default 360); the last may be partial. */
  yearDays: number;
  years: SoakYear[];
  /** Unweaned starvation/dehydration deaths with a living parent (first 500 kept). */
  youngDeprivationWithParent: YoungDeprivationRecord[];
  failures: string[];
  /** Balance observations requiring review, separate from hard invariant failures. */
  warnings: string[];
  wallClockMs: number;
}

const MAX_RECORDED_FAILURES = 40;

/** One authoritative death event contributes to exactly one species/cause/care-state cell. */
export function recordDeprivationBySpeciesCare(tally: Record<string, number>, event: WorldEvent): void {
  if (event.type !== 'died') return;
  const cause = event.conditions.cause;
  if (cause !== 'starvation' && cause !== 'dehydration') return;
  const species = String(event.conditions.species ?? event.actors[0]?.split('_')[0] ?? 'unknown');
  const careState = String(event.conditions.careState ?? 'unknown');
  const key = `${species}/${cause}/${careState}`;
  tally[key] = (tally[key] ?? 0) + 1;
}

export function recordCourtshipByOutcomeReason(tally: Record<string, number>, event: WorldEvent): void {
  if (event.type !== 'courtship') return;
  const species = String(event.conditions.species ?? event.actors[0]?.split('_')[0] ?? 'unknown');
  const reason = String(event.conditions.reason ?? 'unknown');
  const key = `${species}/${event.outcome}/${reason}`;
  tally[key] = (tally[key] ?? 0) + 1;
}

export interface SoakOptions {
  terrainProfile?: TerrainProfile;
  communityProfile?: CommunityProfile;
  seed: number;
  days: number;
  speciesDir: string;
  /** Length of the per-year reporting window in days. Reporting only; never changes the world. */
  yearDays?: number;
  onProgress?: (progress: { completedDays: number; requestedDays: number; livingAnimals: number; failures: number }) => void;
}

export function runSoak({ seed, days, speciesDir, terrainProfile = 'mainland', communityProfile = 'none', yearDays = 360, onProgress }: SoakOptions): SoakResult {
  if (!Number.isSafeInteger(days) || days <= 0) throw new Error('soak days must be a positive safe integer');
  if (!Number.isSafeInteger(yearDays) || yearDays <= 0) throw new Error('soak yearDays must be a positive safe integer');
  if (!Number.isSafeInteger(seed)) throw new Error('soak seed must be a safe integer');
  if (terrainProfile !== 'mainland' && !isIslandProfile(terrainProfile)) throw new Error('invalid soak terrain profile');
  const island = isIslandProfile(terrainProfile);
  const started = Date.now();
  const world = createWorld({
    seed, speciesDir, terrainProfile, communityProfile,
    initialAgents: island ? islandPopulation(terrainProfile as 'island_v1' | 'island_v2') : SOAK_POPULATION,
    minPopulation: island ? {} : SOAK_FLOOR,
    ...(island ? {} : { landscape: SOAK_LANDSCAPE }),
    // A fifty-year run emits hundreds of millions of events. Keep a small window and tally
    // as we go; the numbers below are counted, never reconstructed from a retained array.
    retainEvents: 200_000,
  });

  let huntAttempts = 0;
  let huntKills = 0;
  let carcassesCreated = 0;
  let carcassesCompleted = 0;
  let scavengeEvents = 0;
  let immigrationEvents = 0;
  const immigrationByRoute: Record<string, number> = {};
  const arrivalRecords: SoakResult['islandArrivals'] = [];
  const deathsByCause: Record<string, number> = {};
  const humanDeaths: SoakResult['community']['deathRecords'] = [];
  const humanFamily = emptyHumanFamilyMetrics();
  const structures = { storms: 0, floods: 0, collapses: 0, rebuilds: 0 };
  const birthsBySpecies: Record<string, number> = {};
  const deathsBySpecies: Record<string, number> = {};
  const courtship = { attempts: 0, successes: 0 };
  const courtshipBySpecies: Record<string, number> = {};
  const courtshipBySpeciesOutcomeReason: Record<string, number> = {};
  const huntsBySpecies: Record<string, HuntMetrics> = {};
  const starvationByLifeStage: Record<string, number> = {};
  const dehydrationByLifeStage: Record<string, number> = {};
  const deprivationByCare: Record<string, number> = {};
  const diseaseEvents = emptyIllnessEventMetrics();
  const woundEvents = emptyWoundEventMetrics();
  const fishEvents = emptyFishEventMetrics();
  const floweringEvents = emptyFloweringEventMetrics();
  const deprivationBySpeciesCare: Record<string, number> = {};
  const packFood = { collections: 0, deliveries: 0, digestions: 0,
    collectedKg: 0, deliveredKg: 0, digestedKg: 0, releasedOnDeathKg: 0,
    exportedKg: 0, outstandingKg: 0, nursingParentDeliveries: 0, youngDeliveries: 0 };

  const years: SoakYear[] = [];
  let year = emptySoakYear(1, 0);
  for (const speciesId of world.species.keys()) year.populationStart[speciesId] = world.livingCount(speciesId);
  const youngWithParent: YoungDeprivationRecord[] = [];
  const parents: ParentLookup = {
    dependentOn: (id) => world.agents.find(agent => agent.id === id)?.dependentOn ?? null,
    locate: (id) => {
      const parent = world.agents.find(agent => agent.id === id);
      return parent?.alive && parent.position ? { patchId: parent.patchId, position: { ...parent.position } } : null;
    },
    careRadiusM: (id) => { const cfg = world.species.get(id); return cfg ? careRadius(cfg) : NaN; },
  };

  const tally = (): void => {
    for (const event of world.log.take()) {
      const withParent = recordYearEvent(year, event, parents);
      if (withParent && youngWithParent.length < 500) youngWithParent.push(withParent);
      recordHumanFamily(humanFamily, event);
      recordIllnessEvent(diseaseEvents, event);
      recordWoundEvent(woundEvents, event);
      recordFishEvent(fishEvents, event);
      recordFloweringEvent(floweringEvents, event);
      switch (event.type) {
        case 'human_died':
          humanDeaths.push({ personId: event.actors[0]!, worldTime: event.worldTime, cause: String(event.conditions.cause ?? 'unknown') }); break;
        case 'building_storm': structures.storms++; break;
        case 'building_flooded': structures.floods++; break;
        case 'building_collapsed': structures.collapses++; break;
        case 'building_rebuilt': structures.rebuilds++; break;
        case 'hunt':
          recordHunt(huntsBySpecies, event);
          huntAttempts++;
          if (event.outcome === 'success') huntKills++;
          break;
        case 'carcass_created':
          carcassesCreated++;
          packFood.releasedOnDeathKg += Number(event.effects.ingestaKg ?? 0);
          break;
        case 'pack_food_collected':
          packFood.collections++; packFood.collectedKg += Number(event.effects.kg); break;
        case 'pack_food_delivered':
          packFood.deliveries++; packFood.deliveredKg += Number(event.effects.kg);
          if (event.conditions.role === 'nursing_parent') packFood.nursingParentDeliveries++;
          if (event.conditions.role === 'young') packFood.youngDeliveries++;
          break;
        case 'pack_food_digested':
          packFood.digestions++; packFood.digestedKg += Number(event.effects.kg); break;
        case 'emigration': packFood.exportedKg += Number(event.effects.carriedFoodKg ?? 0); break;
        case 'nutrients_returned': carcassesCompleted++; break;
        case 'scavenged': if (event.outcome === 'success') scavengeEvents++; break;
        case 'immigration': {
          immigrationEvents++;
          const route = String(event.conditions.route ?? 'landscape_exchange');
          immigrationByRoute[route] = (immigrationByRoute[route] ?? 0) + 1;
          if (route === 'island_crossing' && arrivalRecords.length < 200) arrivalRecords.push({ worldTime: event.worldTime,
            species: String(event.conditions.species), actorId: event.actors[0]!, patchId: event.patchId,
            trigger: String(event.conditions.trigger), livingBefore: Number(event.conditions.livingBefore),
            massKg: Number(event.effects.massKg), positioned: event.position !== undefined });
          break;
        }
        case 'born': {
          const id = String(event.conditions.species ?? '?');
          birthsBySpecies[id] = (birthsBySpecies[id] ?? 0) + 1;
          break;
        }
        case 'courtship': {
          recordCourtshipByOutcomeReason(courtshipBySpeciesOutcomeReason, event);
          courtship.attempts++;
          if (event.outcome === 'success') courtship.successes++;
          const sp = String(event.conditions.species ?? '?');
          courtshipBySpecies[sp] = (courtshipBySpecies[sp] ?? 0) + 1;
          if (event.outcome === 'success') {
            courtshipBySpecies[`${sp}/ok`] = (courtshipBySpecies[`${sp}/ok`] ?? 0) + 1;
          }
          break;
        }
        case 'died': {
          recordDeprivationBySpeciesCare(deprivationBySpeciesCare, event);
          const cause = String(event.conditions.cause ?? 'unknown');
          deathsByCause[cause] = (deathsByCause[cause] ?? 0) + 1;
          const who = event.actors[0]?.split('_')[0] ?? '?';
          deathsBySpecies[who] = (deathsBySpecies[who] ?? 0) + 1;
          const key = `${who}/${cause}`;
          deathsBySpecies[key] = (deathsBySpecies[key] ?? 0) + 1;
          if (cause === 'starvation') {
            const key = `${who}/${String(event.conditions.lifeStage ?? 'unknown')}`;
            starvationByLifeStage[key] = (starvationByLifeStage[key] ?? 0) + 1;
          }
          if (cause === 'dehydration') {
            const key = `${who}/${String(event.conditions.lifeStage ?? 'unknown')}`;
            dehydrationByLifeStage[key] = (dehydrationByLifeStage[key] ?? 0) + 1;
          }
          if (cause === 'starvation' || cause === 'dehydration') {
            const key = `${cause}/${String(event.conditions.careState ?? 'unknown')}`;
            deprivationByCare[key] = (deprivationByCare[key] ?? 0) + 1;
          }
          break;
        }
        default: break;
      }
    }
  };

  const baseline = world.totalNutrients();
  const closeYear = (endDay: number): void => {
    year.endDay = endDay;
    for (const speciesId of world.species.keys()) {
      year.population[speciesId] = world.livingCount(speciesId);
      if (year.population[speciesId] === 0) year.extinct.push(speciesId);
    }
    year.nutrientDrift = Math.abs(world.totalNutrients() - baseline);
    year.forage.endPct = foragePercent(world.patches.filter(landWalkable));
    // Every animal is accounted for: no one appears or vanishes outside a recorded birth,
    // arrival, death or departure (sim_0.33.0 arrivals included).
    const unreconciled = unreconciledPopulations(year);
    if (unreconciled.length && failures.length < MAX_RECORDED_FAILURES)
      failures.push(`year ${year.year}: population ledger does not reconcile for ${unreconciled.join(', ')}`);
    years.push(year);
    year = emptySoakYear(year.year + 1, endDay);
    year.populationStart = { ...years.at(-1)!.population };
  };
  const failures: string[] = [];
  const warnings: string[] = [];
  const warned = new Set<string>();
  const extinct = new Set<string>();
  const peakPopulation: Record<string, number> = {};
  let completedDays = 0;
  const samplePeaks = (): void => recordPopulationPeaks(peakPopulation, world.species.keys(), (id) => world.livingCount(id));
  samplePeaks();

  for (let day = 0; day < days; day++) {
    for (let hour = 0; hour < 24; hour++) {
      world.step(1); tally(); samplePeaks();
      if (failures.length < MAX_RECORDED_FAILURES) {
        const invalid = world.agents.find(a => a.alive && !positionInPatch(a.position, a.patchId));
        if (invalid) failures.push(`day ${day} hour ${hour}: ${invalid.id} position/patch disagreement`);
      }
      if (island && failures.length < MAX_RECORDED_FAILURES) {
        for (const a of world.agents) if (!landWalkable(world.patches[a.patchId]) || !a.position
          || islandHeightAt(islandGeometrySeed(seed, terrainProfile), a.position.x, a.position.z) <= 0) {
          failures.push(`day ${day} hour ${hour}: ${a.id} outside island core land`); break;
        }
        if (world.patches.some(p => p.surface === 'ocean' && p.waterVolume !== 0)) failures.push('ocean contains freshwater stock');
      }
    }

    completedDays = day + 1;
    sampleYearForage(year, completedDays, foragePercent(world.patches.filter(landWalkable)));
    if (completedDays % yearDays === 0) { tally(); closeYear(completedDays); }
    if (world.community && !isCommunityState(world.community) && failures.length < MAX_RECORDED_FAILURES)
      failures.push(`day ${day}: invalid community state`);
    onProgress?.({ completedDays, requestedDays: days,
      livingAnimals: world.agents.reduce((n, agent) => n + Number(agent.alive), 0), failures: failures.length });
    if (day % 10 !== 0) continue;

    for (const p of world.patches) {
      if (!Number.isFinite(p.waterVolume) || p.waterVolume < 0) failures.push(`day ${day}: patch ${p.id} invalid surface water`);
      if (!Number.isFinite(p.plant.grass) || p.plant.grass < 0) {
        failures.push(`day ${day}: patch ${p.id} grass=${p.plant.grass}`);
      }
      if (!Number.isFinite(p.soilNutrients) || p.soilNutrients < 0) {
        failures.push(`day ${day}: patch ${p.id} soilNutrients=${p.soilNutrients}`);
      }
      const guild = p.floweringGuild;
      if (guild && [guild.capacityKg, guild.vegetativeKg, guild.bloom?.openKg ?? 0,
        guild.bloom?.visitedKg ?? 0, ...guild.seedBank.map(seed => seed.biomassKg)]
        .some(value => !Number.isFinite(value) || value < 0)) {
        failures.push(`day ${day}: patch ${p.id} invalid flowering stock`);
      }
    }
    for (const speciesId of world.species.keys()) {
      const living = world.livingCount(speciesId);
      // Once per species: a closed island cannot recover a lost species, and repeating the
      // same failure every ten days would exhaust the failure cap and end a multi-year run early.
      if (living === 0 && !extinct.has(speciesId)) { extinct.add(speciesId); failures.push(`day ${day}: ${speciesId} extinct`); }
      const ceiling = SOAK_CEILING[speciesId];
      if (ceiling !== undefined && peakPopulation[speciesId]! > ceiling && !warned.has(speciesId)) {
        warned.add(speciesId);
        warnings.push(`${speciesId} peaked over its intended ceiling of ${ceiling} (first seen day ${day})`);
      }
    }
    for (const carcass of world.carcasses) {
      if (carcassMass(carcass.biomass) < -1e-6) {
        failures.push(`day ${day}: carcass ${carcass.id} has negative mass`);
      }
    }
    // Record and keep going. Stopping at the first breach hides everything that happens after
    // it, and an overshoot that corrects itself is a different finding from one that does not.
    if (failures.length > MAX_RECORDED_FAILURES) {
      failures.push(`stopped recording after ${MAX_RECORDED_FAILURES} failures`);
      break;
    }
  }

  tally();
  if (completedDays % yearDays !== 0) closeYear(completedDays);
  if (completedDays !== days) failures.push(`incomplete soak: ${completedDays} of ${days} requested days`);
  if (communityProfile === 'household_v1' && world.community?.people.every(person => !person.alive))
    failures.push('household extinct: no living village people at the end of the requested run');
  const waterResidual = waterBudgetResidual(world.patches, world.waterBudget);
  if (!Number.isFinite(waterResidual) || Math.abs(waterResidual) > 0.01) failures.push(`surface water residual ${waterResidual} L exceeds 0.01 L`);
  packFood.outstandingKg = world.agents.reduce((kg, agent) => kg + (agent.alive ? agent.packFood?.kg ?? 0 : 0), 0);
  const accountedFood = packFood.deliveredKg + packFood.digestedKg + packFood.releasedOnDeathKg
    + packFood.exportedKg + packFood.outstandingKg;
  if (Object.values(packFood).some(value => !Number.isFinite(value) || value < 0)
    || Math.abs(packFood.collectedKg - accountedFood) > 1e-6) {
    failures.push('carried pack food does not reconcile to collection/delivery/digestion/death/export');
  }
  if (!validHumanFamilyMetrics(humanFamily)) {
    failures.push('human family event totals are invalid or exceed recorded conceptions');
  }
  if (!validWoundEventMetrics(woundEvents)) {
    failures.push('wound milestone totals are invalid or exceed recorded episodes');
  }
  if (!validFishEventMetrics(fishEvents)) {
    failures.push('fish cohort milestones are invalid or exceed recorded spawning');
  }
  if (!validFloweringEventMetrics(floweringEvents)) {
    failures.push('flowering milestones or biomass transfers are invalid');
  }
  if (structures.rebuilds > structures.collapses || world.community?.version === 8
    && (structures.collapses !== world.community.building.maintenance?.collapses
      || structures.rebuilds !== world.community.building.maintenance?.rebuildsCompleted)) {
    failures.push('community structure events do not reconcile with saved collapse/rebuild state');
  }

  const finalPopulation: Record<string, number> = {};
  for (const speciesId of world.species.keys()) {
    finalPopulation[speciesId] = world.livingCount(speciesId);
    const starved = deathsBySpecies[`${speciesId}/starvation`] ?? 0;
    if (starved > 0) warnings.push(`${speciesId}: ${starved} recorded starvation deaths; inspect life-stage and feeding evidence`);
    const dehydrated = deathsBySpecies[`${speciesId}/dehydration`] ?? 0;
    if (dehydrated > 0) warnings.push(`${speciesId}: ${dehydrated} recorded dehydration deaths; inspect care and water access`);
    // Include peaks in the final partial ten-day window too.
    const ceiling = SOAK_CEILING[speciesId];
    if (ceiling !== undefined && peakPopulation[speciesId]! > ceiling && !warned.has(speciesId)) {
      warned.add(speciesId);
      warnings.push(`${speciesId} peaked over its intended ceiling of ${ceiling} (seen by final sample)`);
    }
  }

  // Inbreeding across every living pair of parents currently in the world.
  let inbreedingTotal = 0;
  let inbreedingSamples = 0;
  let generationsReached = 0;
  for (const agent of world.agents) {
    if (!agent.alive) continue;
    generationsReached = Math.max(generationsReached, agent.generation);
    if (agent.motherId !== null && agent.fatherId !== null) {
      inbreedingTotal += world.pedigree.coefficientFor(agent.motherId, agent.fatherId);
      inbreedingSamples++;
    }
  }

  return {
    simVersion: SIM_VERSION,
    terrainProfile, navigableLandKm2: world.patches.filter(landWalkable).length * 0.09,
    seed, days, completedDays, completedWorldTime: world.now(), stoppedEarly: completedDays !== days,
    community: { profile: communityProfile, rulesVersion: world.community?.version ?? null, deathRecords: humanDeaths,
      alive: world.community?.people.filter(p => p.alive).length ?? 0,
      deaths: world.community?.people.filter(p => !p.alive).length ?? 0,
      repairs: world.community?.building.maintenance?.repairsCompleted ?? 0,
      homeCondition: world.community ? homeCondition(world.community) : null,
      ...humanFamily,
      childrenAlive: world.community?.people.filter(p => (p.generation ?? 0) > 0 && p.alive).length ?? 0,
      childrenDead: world.community?.people.filter(p => (p.generation ?? 0) > 0 && !p.alive).length ?? 0,
      ...structures },
    finalPopulation, peakPopulation,
    births: world.births,
    birthsBySpecies,
    deathsBySpecies,
    courtshipAttempts: courtship.attempts,
    courtshipBySpecies,
    courtshipBySpeciesOutcomeReason,
    courtshipSuccessRate: courtship.attempts === 0 ? 0 : courtship.successes / courtship.attempts,
    generationsReached,
    meanInbreeding: inbreedingSamples === 0 ? 0 : inbreedingTotal / inbreedingSamples,
    immigrationEvents,
    immigrationByRoute,
    islandArrivals: arrivalRecords,
    importedNutrient: world.ledger.imported,
    events: world.log.size(),
    nutrientDrift: Math.abs(world.totalNutrients() - baseline),
    hydrology: { budget: { ...world.waterBudget }, storedL: surfaceWaterL(world.patches), residualL: waterResidual,
      maximumPatchL: Math.max(...world.patches.map(p => p.waterVolume)) },
    huntAttempts,
    huntSuccessRate: huntAttempts === 0 ? 0 : huntKills / huntAttempts,
    huntsBySpecies,
    starvationByLifeStage,
    dehydrationByLifeStage,
    deprivationByCare,
    diseaseEvents,
    woundEvents,
    fishEvents,
    floweringEvents,
    deprivationBySpeciesCare,
    packFood,
    carcassesCreated,
    carcassesCompleted,
    carcassesOutstanding: world.carcasses.length,
    scavengeEvents,
    deathsByCause,
    yearDays,
    years,
    youngDeprivationWithParent: youngWithParent,
    failures,
    warnings,
    wallClockMs: Date.now() - started,
  };
}

// CLI entry: `npm run soak -- --seed 1 --days 1000`
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string, fallback: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : fallback;
  };
  const result = runSoak({
    terrainProfile: (process.argv.includes('--terrain-profile')
      ? process.argv[process.argv.indexOf('--terrain-profile') + 1] : 'mainland') as TerrainProfile,
    seed: arg('seed', 1),
    days: arg('days', 1000),
    yearDays: arg('year-days', 360),
    communityProfile: (process.argv.includes('--community-profile')
      ? process.argv[process.argv.indexOf('--community-profile') + 1] : 'none') as CommunityProfile,
    ...(process.argv.includes('--progress') ? { onProgress: (p: { completedDays: number; requestedDays: number; livingAnimals: number; failures: number }) => {
      if (p.completedDays === 1 || p.completedDays % 10 === 0 || p.completedDays === p.requestedDays)
        console.error(`soak ${p.completedDays}/${p.requestedDays} days; ${p.livingAnimals} living animals; ${p.failures} recorded failures`);
    } } : {}),
    speciesDir: new URL('../../../config/species', import.meta.url).pathname,
  });
  if (process.argv.includes('--output')) {
    const output = process.argv[process.argv.indexOf('--output') + 1];
    if (!output || output.startsWith('--')) throw new Error('--output requires a new report file path');
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.failures.length === 0 ? 0 : 1);
}
