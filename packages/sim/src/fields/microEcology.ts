import {
  DAYS_PER_YEAR, NUTRIENT_PER_KG_BIOMASS, dayOfYear, microBiomassKg, seasonAt, yearOf,
  type Carcass, type FishCohort, type MicroEcologyState, type MicroPatchPopulation, type Patch, type Season, type WorldTime,
} from '@vana/shared';

const ROLE_DECAY_PER_HOUR = 0.004;
const MAX_ROLE_GROWTH_PER_HOUR = 0.018;
const FISH_PREY_ASSIMILATION = 0.72;
const FISH_PREY_BODY_FRACTION_PER_DAY = 0.24;
const INSECT_HARVEST_FRACTION_PER_DAY = 0.15;
/** Scenario coefficients, not species-specific ecological calibration. */
const AQUATIC_PRODUCER_SEED_KG = 0.04;
const AQUATIC_PRODUCER_TARGET_KG = 0.12;
const FISH_PRODUCER_ASSIMILATION = 0.6;
const FISH_PRODUCER_HARVEST_FRACTION_PER_DAY = 0.24;
/** An established school can disperse a bounded share of its body mass each day. */
const FISH_DISPERSAL_FRACTION_PER_DAY = 0.12;
const MIN_DISPERSING_FISH_KG = 0.002;
/** Explicitly uncalibrated scenario policy, not measured wild rates. */
/** Fish spawn in the first month of the world's wet season, on its own calendar (island or Congo). */
const FISH_SPAWN_WINDOW_DAYS = 30;
const SEASON_DAYS = DAYS_PER_YEAR / 4;
const FISH_SPAWN_FRACTION = 0.03;
const FISH_SPAWN_MAX_KG = 0.004;
const FISH_SPAWN_MIN_STOCK_KG = 0.01;
const FISH_EGG_HOURS = 48;
const FISH_LARVAL_HOURS = 20 * 24;
const FISH_EGG_MORTALITY_PER_DAY = 0.02;
const FISH_LARVAL_MORTALITY_PER_DAY = 0.01;
const FISH_HATCH_SURVIVAL = 0.8;
const FISH_LARVAL_PRODUCER_HARVEST_PER_DAY = 0.08;
const FISH_LARVAL_FOOD_PER_BODY_PER_DAY = 0.1;
const FISH_LARVAL_ASSIMILATION = 0.7;

export interface FishTransition {
  type: 'fish_spawned' | 'fish_hatched' | 'fish_recruited' | 'fish_cohort_lost';
  patchId: number;
  at: WorldTime;
  biomassKg: number;
  recycledKg: number;
}

type PreyRole = 'detritivoreBiomassKg' | 'antBiomassKg' | 'pollinatorBiomassKg';

function emptyPatch(patchId: number): MicroPatchPopulation {
  return { patchId, antColonies: 0, fishSchools: 0, antBiomassKg: 0, pollinatorBiomassKg: 0,
    detritivoreBiomassKg: 0, aquaticProducerBiomassKg: 0, fishBiomassKg: 0,
    lastFishSpawnYear: 0,
    decomposerBiomassKg: 0 };
}

function recycleCohort(patch: Patch, cohort: FishCohort, kg: number): void {
  patch.soilNutrients += kg * NUTRIENT_PER_KG_BIOMASS;
  cohort.biomassKg -= kg;
}

/** Segments a tick at the two stage deadlines so long steps cannot skip a life stage. */
function advanceFishCohort(patch: Patch, micro: MicroPatchPopulation, startAt: WorldTime,
  endAt: WorldTime, transitions: FishTransition[]): void {
  const cohort = micro.fishCohort;
  if (!cohort) return;
  let cursor = startAt;
  while (cursor < endAt && micro.fishCohort) {
    const deadline = cohort.stage === 'eggs' ? cohort.hatchAt : cohort.recruitAt;
    const segmentEnd = Math.min(endAt, deadline);
    const days = Math.max(0, segmentEnd - cursor) / 86_400;
    if (cohort.stage === 'larvae' && days > 0 && cohort.biomassKg > 0) {
      const harvested = Math.min(micro.aquaticProducerBiomassKg,
        micro.aquaticProducerBiomassKg * Math.min(1, FISH_LARVAL_PRODUCER_HARVEST_PER_DAY * days),
        cohort.biomassKg * FISH_LARVAL_FOOD_PER_BODY_PER_DAY * days);
      micro.aquaticProducerBiomassKg -= harvested;
      cohort.biomassKg += harvested * FISH_LARVAL_ASSIMILATION;
      patch.soilNutrients += harvested * (1 - FISH_LARVAL_ASSIMILATION) * NUTRIENT_PER_KG_BIOMASS;
    }
    const mortality = cohort.biomassKg * Math.min(1,
      (cohort.stage === 'eggs' ? FISH_EGG_MORTALITY_PER_DAY : FISH_LARVAL_MORTALITY_PER_DAY) * days);
    recycleCohort(patch, cohort, mortality);
    cursor = segmentEnd;
    if (cursor < deadline) break;
    if (cohort.stage === 'eggs') {
      const hatchLoss = cohort.biomassKg * (1 - FISH_HATCH_SURVIVAL);
      recycleCohort(patch, cohort, hatchLoss);
      cohort.stage = 'larvae';
      transitions.push({ type: 'fish_hatched', patchId: patch.id, at: cursor,
        biomassKg: cohort.biomassKg, recycledKg: hatchLoss });
    } else {
      const biomassKg = cohort.biomassKg;
      micro.fishBiomassKg += biomassKg;
      delete micro.fishCohort;
      transitions.push({ type: 'fish_recruited', patchId: patch.id, at: cursor,
        biomassKg, recycledKg: 0 });
    }
  }
}

export function emptyMicroEcology(patches: readonly Patch[], updatedAt: WorldTime): MicroEcologyState {
  return { updatedAt, patches: patches.map((p) => ({ ...emptyPatch(p.id),
    lastFishSpawnYear: yearOf(updatedAt) })) };
}

/** Establishes the world's initial population from existing local biomass, never creating
 * nutrient mass. Only wet inland freshwater habitats receive fish at genesis; subsequently
 * emptied pools must be recolonized by a connected school. */
export function seedMicroEcology(patches: Patch[], updatedAt: WorldTime): MicroEcologyState {
  const state = emptyMicroEcology(patches, updatedAt);
  for (const m of state.patches) m.lastFishSpawnYear = 0;
  for (const patch of patches) {
    const m = state.patches[patch.id];
    if (!m || patch.surface === 'ocean') continue;
    m.antBiomassKg = takePlant(patch, Math.min(0.006, (patch.plant.grass + patch.plant.browse) * 0.000001));
    m.pollinatorBiomassKg = takePlant(patch, Math.min(0.002, (patch.plant.grass + patch.plant.browse) * 0.0000004));
    m.decomposerBiomassKg = takeSoilNutrients(patch, 0.01);
    if (wetFreshwater(patch)) {
      m.aquaticProducerBiomassKg = takeSoilNutrients(patch, AQUATIC_PRODUCER_SEED_KG);
      m.fishBiomassKg = takeSoilNutrients(patch, 0.004);
    }
    m.antColonies = m.antBiomassKg > 0 ? 1 : 0;
    m.fishSchools = m.fishBiomassKg > 0 ? 1 : 0;
  }
  return state;
}

function takePlant(patch: Patch, wantedKg: number): number {
  let remaining = Math.max(0, wantedKg);
  let taken = Math.min(patch.plant.grass, remaining);
  patch.plant.grass -= taken; remaining -= taken;
  const browse = Math.min(patch.plant.browse, remaining);
  patch.plant.browse -= browse;
  return taken + browse;
}

function takeSoilNutrients(patch: Patch, wantedKg: number): number {
  const affordable = Math.min(Math.max(0, wantedKg), Math.max(0, patch.soilNutrients) / NUTRIENT_PER_KG_BIOMASS);
  patch.soilNutrients -= affordable * NUTRIENT_PER_KG_BIOMASS;
  return affordable;
}

function takeCarcass(carcass: Carcass, wantedKg: number): number {
  let remaining = Math.max(0, wantedKg), taken = 0;
  for (const tissue of ['muscle', 'organ', 'ingesta', 'hide', 'bone'] as const) {
    const present = carcass.biomass[tissue] ?? 0;
    const amount = Math.min(present, remaining);
    carcass.biomass[tissue] = present - amount;
    taken += amount; remaining -= amount;
    if (remaining <= 0) break;
  }
  return taken;
}

function growthDemand(target: number, current: number, hours: number): number {
  const headroom = Math.max(0, target - current);
  return Math.min(headroom, target * MAX_ROLE_GROWTH_PER_HOUR * hours);
}

function wetFreshwater(patch: Patch): boolean {
  return patch.surface !== 'ocean' && patch.surface !== 'coast' && patch.waterVolume >= 20
    && (patch.habitat === 'water' || patch.habitat === 'marsh' || patch.habitat === 'riparian'
      // The Congo's flooded and swamp forest hold fish while they hold water.
      || patch.habitat === 'flooded_forest' || patch.habitat === 'swamp_forest');
}

function connectedWetNeighbours(patch: Patch, byId: Map<number, Patch>): Patch[] {
  return patch.neighbours.map((id) => byId.get(id)).filter((other): other is Patch => !!other
    && wetFreshwater(other) && other.neighbours.includes(patch.id)
    && Math.abs(other.x - patch.x) + Math.abs(other.y - patch.y) === 1)
    .sort((a, b) => a.id - b.id);
}

/** Transfers existing fish between directly connected freshwater cells. Each source's export
 * budget is calculated from the same pre-dispersal snapshot, so patch iteration cannot create
 * fish or let a school cross two edges in one step. Empty disconnected pools remain empty. */
function disperseFish(patches: Patch[], microById: Map<number, MicroPatchPopulation>,
  targets: Map<number, number>, hours: number): void {
  const patchById = new Map(patches.map((p) => [p.id, p]));
  const initial = new Map([...microById].map(([id, m]) => [id, m.fishBiomassKg]));
  const exports = new Map<number, number>(), imports = new Map<number, number>();
  for (const source of [...patches].sort((a, b) => a.id - b.id)) {
    const stock = initial.get(source.id) ?? 0;
    const sourceTarget = targets.get(source.id) ?? 0;
    if (!wetFreshwater(source) || stock < MIN_DISPERSING_FISH_KG || sourceTarget <= 0) continue;
    let budget = Math.min(Math.max(0, stock - MIN_DISPERSING_FISH_KG),
      stock * Math.min(0.5, FISH_DISPERSAL_FRACTION_PER_DAY * hours / 24));
    const sourceDensity = stock / sourceTarget;
    const neighbours = connectedWetNeighbours(source, patchById).filter((destination) => {
      const target = targets.get(destination.id) ?? 0;
      return microById.has(destination.id) && target > 0
        && (initial.get(destination.id) ?? 0) / target < sourceDensity;
    });
    for (let index = 0; index < neighbours.length && budget > 0; index++) {
      const destination = neighbours[index]!;
      const target = targets.get(destination.id)!;
      const current = initial.get(destination.id) ?? 0;
      const room = Math.max(0, target - current - (imports.get(destination.id) ?? 0));
      const moved = Math.min(room, budget / (neighbours.length - index));
      if (moved <= 0) continue;
      exports.set(source.id, (exports.get(source.id) ?? 0) + moved);
      imports.set(destination.id, (imports.get(destination.id) ?? 0) + moved);
      budget -= moved;
    }
  }
  for (const [id, micro] of microById) {
    micro.fishBiomassKg += (imports.get(id) ?? 0) - (exports.get(id) ?? 0);
  }
}

/** Fish take insects and detritivores from their own patch or a directly adjacent shoreline.
 * A per-source budget prevents several schools from each taking the full daily harvest allowance.
 * Unassimilated prey is returned to soil as waste, keeping the nutrient ledger closed. */
function feedFish(patch: Patch, fish: MicroPatchPopulation, demandKg: number, hours: number,
  microById: Map<number, MicroPatchPopulation>, patchById: Map<number, Patch>,
  preyBudget: Map<string, number>): number {
  if (fish.fishBiomassKg <= 0 || demandKg <= 0) return 0;
  let preyNeeded = Math.min(demandKg / FISH_PREY_ASSIMILATION,
    fish.fishBiomassKg * FISH_PREY_BODY_FRACTION_PER_DAY * hours / 24);
  let consumed = 0;
  const sourceIds = [patch.id, ...patch.neighbours.slice().sort((a, b) => a - b)];
  for (const id of sourceIds) {
    if (preyNeeded <= 0) break;
    const sourcePatch = patchById.get(id), source = microById.get(id);
    if (!sourcePatch || !source || sourcePatch.surface === 'ocean') continue;
    // A neighbouring patch is accessible only at a wet land/shoreline edge.
    if (id !== patch.id && (sourcePatch.habitat === 'water' || sourcePatch.surface === 'coast')) continue;
    for (const role of ['detritivoreBiomassKg', 'antBiomassKg', 'pollinatorBiomassKg'] as const satisfies readonly PreyRole[]) {
      const key = `${id}:${role}`;
      let available = preyBudget.get(key);
      if (available === undefined) {
        available = source[role] * Math.min(1, INSECT_HARVEST_FRACTION_PER_DAY * hours / 24);
      }
      const taken = Math.min(preyNeeded, available, source[role]);
      source[role] -= taken;
      preyBudget.set(key, available - taken);
      consumed += taken; preyNeeded -= taken;
      if (preyNeeded <= 0) break;
    }
  }
  patch.soilNutrients += consumed * (1 - FISH_PREY_ASSIMILATION) * NUTRIENT_PER_KG_BIOMASS;
  return consumed * FISH_PREY_ASSIMILATION;
}

/** Fish take only finite local aquatic producer biomass. Unassimilated biomass returns to
 * the same patch's soil ledger. This pool cannot seed fish in an empty pool. */
function feedFishFromProducer(patch: Patch, micro: MicroPatchPopulation,
  demandKg: number, hours: number): number {
  if (micro.fishBiomassKg <= 0 || demandKg <= 0) return 0;
  const harvest = Math.min(micro.aquaticProducerBiomassKg,
    micro.aquaticProducerBiomassKg * Math.min(1, FISH_PRODUCER_HARVEST_FRACTION_PER_DAY * hours / 24),
    demandKg / FISH_PRODUCER_ASSIMILATION);
  micro.aquaticProducerBiomassKg -= harvest;
  patch.soilNutrients += harvest * (1 - FISH_PRODUCER_ASSIMILATION) * NUTRIENT_PER_KG_BIOMASS;
  return harvest * FISH_PRODUCER_ASSIMILATION;
}

/**
 * Advances population-level organisms without creating individual agents. Biomass moves between
 * plants, carcasses, soil and the six micro-organism pools, so the existing nutrient ledger can
 * account for it exactly. Seasonal moisture changes carrying capacity, but outcomes stay here in
 * the authoritative simulation rather than in the renderer or narrator.
 */
export function stepMicroEcology(state: MicroEcologyState, patches: Patch[], carcasses: Carcass[],
  hours: number, season: Season, worldTime: WorldTime, terrainProfile?: string): FishTransition[] {
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('invalid micro-ecology duration');
  const transitions: FishTransition[] = [];
  const endAt = worldTime + hours * 3600;
  const byPatch = new Map<number, Carcass[]>();
  const microById = new Map(state.patches.map((m) => [m.patchId, m]));
  const patchById = new Map(patches.map((p) => [p.id, p]));
  const fishDemands: Array<{ patch: Patch; micro: MicroPatchPopulation; target: number; demand: number }> = [];
  for (const carcass of carcasses) {
    const list = byPatch.get(carcass.patchId);
    if (list) list.push(carcass); else byPatch.set(carcass.patchId, [carcass]);
  }
  const wet = season === 'monsoon' ? 1.25 : season === 'wet' ? 1.1 : season === 'dry' ? 0.62 : 0.9;
  for (const patch of patches) {
    const m = microById.get(patch.id);
    if (!m) continue;
    if (!wetFreshwater(patch)) {
      // This coarse freshwater proxy cannot survive a dry cell or the coast/ocean boundary.
      // Recycling it also prevents a dried fish pool from reviving ex nihilo.
      patch.soilNutrients += (m.fishBiomassKg + m.aquaticProducerBiomassKg) * NUTRIENT_PER_KG_BIOMASS;
      m.fishBiomassKg = 0;
      m.aquaticProducerBiomassKg = 0;
      if (m.fishCohort) {
        const biomassKg = m.fishCohort.biomassKg;
        recycleCohort(patch, m.fishCohort, biomassKg);
        delete m.fishCohort;
        transitions.push({ type: 'fish_cohort_lost', patchId: patch.id, at: worldTime,
          biomassKg: 0, recycledKg: biomassKg });
      }
    }
    const plantKg = patch.plant.grass + patch.plant.browse;
    const waterFactor = patch.waterVolume > 0 ? Math.min(1.5, patch.waterVolume / 8_000) : 0;
    const soilFactor = Math.min(1.5, Math.max(0, patch.soilNutrients) / 500);
    const carcassKg = (byPatch.get(patch.id) ?? []).reduce((sum, c) => sum
      + Object.values(c.biomass).reduce((a, b) => a + (b ?? 0), 0), 0);

    const antTarget = patch.surface === 'ocean' ? 0 : Math.max(0.002, plantKg * 0.00008) * wet;
    const pollinatorTarget = patch.surface === 'ocean' ? 0 : Math.max(0.001, plantKg * 0.000035) * wet;
    const detritivoreTarget = patch.surface === 'ocean' ? 0 : Math.max(0.001, carcassKg * 0.012 + soilFactor * 0.015) * wet;
    const fishTarget = wetFreshwater(patch) && waterFactor > 0
      ? Math.max(0.001, waterFactor * 0.04 + plantKg * 0.000008) * wet : 0;
    const producerTarget = wetFreshwater(patch)
      ? AQUATIC_PRODUCER_TARGET_KG * Math.min(1.5, waterFactor) * wet : 0;
    const decomposerTarget = patch.surface === 'ocean' ? 0 : Math.max(0.002, carcassKg * 0.02 + soilFactor * 0.03) * wet;

    const antGrowth = Math.min(growthDemand(antTarget, m.antBiomassKg, hours),
      takePlant(patch, growthDemand(antTarget, m.antBiomassKg, hours)));
    const pollGrowth = Math.min(growthDemand(pollinatorTarget, m.pollinatorBiomassKg, hours),
      takePlant(patch, growthDemand(pollinatorTarget, m.pollinatorBiomassKg, hours)));
    // Sunlight/energy and dissolved nutrient speciation are not modelled. The producer biomass
    // uses the existing local soil nutrient ledger as a strictly finite nutrient proxy.
    const producerGrowth = takeSoilNutrients(patch,
      growthDemand(producerTarget, m.aquaticProducerBiomassKg, hours));
    fishDemands.push({ patch, micro: m, target: fishTarget,
      demand: growthDemand(fishTarget, m.fishBiomassKg, hours) });
    let detritGrowth = 0, decompGrowth = 0;
    const detritDemand = growthDemand(detritivoreTarget, m.detritivoreBiomassKg, hours);
    const decompDemand = growthDemand(decomposerTarget, m.decomposerBiomassKg, hours);
    for (const carcass of byPatch.get(patch.id) ?? []) {
      const need = (detritDemand - detritGrowth) + (decompDemand - decompGrowth);
      if (need <= 0) break;
      const taken = takeCarcass(carcass, need);
      const detritNeed = Math.max(0, detritDemand - detritGrowth);
      const detritTaken = Math.min(taken, detritNeed);
      detritGrowth += detritTaken; decompGrowth += taken - detritTaken;
    }
    decompGrowth += Math.min(Math.max(0, decompDemand - decompGrowth),
      takeSoilNutrients(patch, decompDemand - decompGrowth));
    m.antBiomassKg += antGrowth; m.pollinatorBiomassKg += pollGrowth;
    m.aquaticProducerBiomassKg += producerGrowth;
    m.detritivoreBiomassKg += detritGrowth; m.decomposerBiomassKg += decompGrowth;

    const decay = Math.min(1, ROLE_DECAY_PER_HOUR * hours);
    for (const key of ['antBiomassKg', 'pollinatorBiomassKg', 'detritivoreBiomassKg',
      'aquaticProducerBiomassKg', 'fishBiomassKg', 'decomposerBiomassKg'] as const) {
      const lost = m[key] * decay; m[key] -= lost; patch.soilNutrients += lost * NUTRIENT_PER_KG_BIOMASS;
    }
  }
  const preyBudget = new Map<string, number>();
  for (const { patch, micro: m, target, demand } of fishDemands) {
    // Primary food is not a fish seed. A newly wet pool needs a connected school to colonize it.
    if (m.fishBiomassKg <= 0) continue;
    const boundedDemand = Math.min(demand, Math.max(0, target - m.fishBiomassKg));
    const preyGrowth = feedFish(patch, m, boundedDemand, hours, microById, patchById, preyBudget);
    const primaryGrowth = feedFishFromProducer(patch, m,
      Math.max(0, boundedDemand - preyGrowth), hours);
    m.fishBiomassKg += preyGrowth + primaryGrowth;
  }
  disperseFish(patches, microById, new Map(fishDemands.map(({ patch, target }) => [patch.id, target])), hours);
  for (const patch of [...patches].sort((a, b) => a.id - b.id)) {
    const m = microById.get(patch.id);
    if (!m) continue;
    if (wetFreshwater(patch)) {
      advanceFishCohort(patch, m, worldTime, endAt, transitions);
      const spawnYear = yearOf(endAt), spawnDay = dayOfYear(endAt);
      if (!m.fishCohort && m.lastFishSpawnYear < spawnYear && seasonAt(endAt, terrainProfile) === 'wet'
        && (spawnDay - 1) % SEASON_DAYS < FISH_SPAWN_WINDOW_DAYS
        && m.fishBiomassKg >= FISH_SPAWN_MIN_STOCK_KG) {
        const biomassKg = Math.min(FISH_SPAWN_MAX_KG, m.fishBiomassKg * FISH_SPAWN_FRACTION);
        m.fishBiomassKg -= biomassKg;
        m.fishCohort = { stage: 'eggs', biomassKg, spawnedAt: endAt,
          hatchAt: endAt + FISH_EGG_HOURS * 3600,
          recruitAt: endAt + (FISH_EGG_HOURS + FISH_LARVAL_HOURS) * 3600 };
        m.lastFishSpawnYear = spawnYear;
        transitions.push({ type: 'fish_spawned', patchId: patch.id, at: endAt,
          biomassKg, recycledKg: 0 });
      }
    }
    m.antColonies = m.antBiomassKg < 0.001 ? 0 : Math.min(100, Math.max(1, Math.round(m.antBiomassKg / 0.015)));
    m.fishSchools = m.fishBiomassKg < 0.002 ? 0 : Math.min(40, Math.max(1, Math.round(m.fishBiomassKg / 0.12)));
    for (const key of ['antBiomassKg', 'pollinatorBiomassKg', 'detritivoreBiomassKg',
      'aquaticProducerBiomassKg', 'fishBiomassKg', 'decomposerBiomassKg'] as const) {
      if (!Number.isFinite(m[key]) || m[key] < 0) throw new Error(`invalid micro-ecology biomass for patch ${patch.id}`);
    }
    if (!Number.isSafeInteger(m.lastFishSpawnYear) || m.lastFishSpawnYear < 0
      || m.fishCohort && (!Number.isFinite(m.fishCohort.biomassKg) || m.fishCohort.biomassKg < 0))
      throw new Error(`invalid fish recruitment state for patch ${patch.id}`);
  }
  state.updatedAt = endAt;
  return transitions;
}

export { microBiomassKg };
