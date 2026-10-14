import {
  NUTRIENT_PER_KG_BIOMASS, floweringHabitat, WORLD_SECONDS_PER_DAY, WORLD_SECONDS_PER_YEAR, dayOfYear, yearOf,
  type EventType, type FloweringGuildState, type MicroEcologyState, type Patch, type WorldTime,
} from '@vana/shared';
import { habitatBrowseCapacity } from '../grid.js';

/** Uncalibrated scenario coefficients; these are not field-measured species rates. */
export const FLOWERING_POLICY = Object.freeze({
  capacityShare: 0.05, initialStandingShare: 0.6, bloomShare: 0.02,
  visitRatePerPollinatorKgHour: 0.4, seedShare: 0.2, recruitShare: 0.3,
  growthRatePerHour: 0.0025,
  /** Generic clonal growth leaves finite microsites for a later seed recruit. */
  growthCeilingShare: 0.995,
  bloomStartDay: 280, bloomCloseDay: 294, maturationDays: 10,
  germinationDay: 10, expiryDay: 120,
});

export interface FloweringTransition {
  type: Extract<EventType, 'flowering_started' | 'flower_visitation_settled' | 'seeds_matured' | 'plants_recruited' | 'seed_bank_lost'>;
  patchId: number;
  at: WorldTime;
  biomassKg: number;
  recycledKg: number;
  outcome: 'success' | 'failure';
}

export function floweringEligible(patch: Patch): boolean {
  return floweringHabitat(patch.habitat)
    && patch.surface !== 'coast' && patch.surface !== 'ocean' && patch.capacity.browse > 0;
}

/** Divide existing browse, including its carrying capacity, without minting biomass. */
export function establishFloweringGuild(patches: Patch[], at: WorldTime, upgrade = false): void {
  for (const patch of patches) {
    if (patch.floweringGuild !== undefined) throw new Error('flowering guild already established');
    if (!floweringEligible(patch)) continue;
    const capacityKg = patch.capacity.browse * FLOWERING_POLICY.capacityShare;
    const vegetativeKg = Math.min(patch.plant.browse, capacityKg * FLOWERING_POLICY.initialStandingShare);
    patch.capacity.browse -= capacityKg;
    patch.plant.browse -= vegetativeKg;
    patch.floweringGuild = { guildId: 'insect_visited_understorey_v1', capacityKg,
      vegetativeKg, lastBloomYear: upgrade ? yearOf(at) : 0, seedBank: [] };
  }
}

function recycle(patch: Patch, kg: number): void {
  patch.soilNutrients += kg * NUTRIENT_PER_KG_BIOMASS;
}

function standing(guild: FloweringGuildState): number {
  return guild.vegetativeKg + (guild.bloom?.openKg ?? 0) + (guild.bloom?.visitedKg ?? 0);
}

function guildYearInstant(year: number, day: number): WorldTime {
  return (year - 1) * WORLD_SECONDS_PER_YEAR + (day - 1) * WORLD_SECONDS_PER_DAY;
}

/** One authoritative hourly transition, after fish/insect feeding and before animal browsing. */
export function stepFloweringGuild(patches: Patch[], micro: MicroEcologyState,
  hours: number, at: WorldTime): FloweringTransition[] {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 1 || !Number.isFinite(at) || at < 0)
    throw new Error('flowering guild requires one finite authoritative hour');
  const transitions: FloweringTransition[] = [];
  for (const patch of patches) {
    const guild = patch.floweringGuild;
    if (!guild) continue;
    const push = (type: FloweringTransition['type'], biomassKg: number,
      recycledKg = 0, outcome: FloweringTransition['outcome'] = 'success'): void => {
      transitions.push({ type, patchId: patch.id, at, biomassKg, recycledKg, outcome });
    };
    if (!floweringEligible(patch)) {
      const lost = standing(guild) + guild.seedBank.reduce((sum, seed) => sum + seed.biomassKg, 0);
      recycle(patch, lost);
      delete patch.floweringGuild;
      if (lost > 0) push('seed_bank_lost', 0, lost, 'failure');
      continue;
    }

    // A seed cohort is not harvestable browse until it actually recruits.
    for (let i = guild.seedBank.length - 1; i >= 0; i--) {
      const seed = guild.seedBank[i]!;
      if (at >= seed.expiresAt) {
        recycle(patch, seed.biomassKg);
        push('seed_bank_lost', 0, seed.biomassKg, 'failure');
        guild.seedBank.splice(i, 1);
      } else if (at >= seed.germinateAt && patch.soilMoisture >= 0.3
        && patch.canopyCover <= 0.9 && guild.capacityKg - standing(guild) > 0) {
        const recruit = Math.min(seed.biomassKg * FLOWERING_POLICY.recruitShare,
          guild.capacityKg - standing(guild));
        if (recruit <= 0) continue;
        const spent = Math.min(seed.biomassKg, recruit / FLOWERING_POLICY.recruitShare);
        guild.vegetativeKg += recruit;
        recycle(patch, spent - recruit);
        seed.biomassKg -= spent;
        push('plants_recruited', recruit, spent - recruit);
        if (seed.biomassKg < 1e-12) guild.seedBank.splice(i, 1);
      }
    }

    const bloom = guild.bloom;
    if (bloom && !bloom.closed && at >= bloom.closesAt) {
      const unvisited = bloom.openKg;
      recycle(patch, unvisited);
      bloom.openKg = 0;
      bloom.closed = true;
      push('flower_visitation_settled', bloom.visitedKg, unvisited,
        bloom.visitedKg > 0 ? 'success' : 'failure');
    }
    if (bloom?.closed && at >= bloom.maturesAt) {
      const seeds = bloom.visitedKg * FLOWERING_POLICY.seedShare;
      const waste = bloom.visitedKg - seeds;
      recycle(patch, waste);
      if (seeds > 0) {
        const nextYear = yearOf(bloom.openedAt) + 1;
        guild.seedBank.push({ biomassKg: seeds, maturedAt: at,
          germinateAt: guildYearInstant(nextYear, FLOWERING_POLICY.germinationDay),
          expiresAt: guildYearInstant(nextYear, FLOWERING_POLICY.expiryDay) });
        push('seeds_matured', seeds, waste);
      }
      delete guild.bloom;
    }

    // Establishment and regrowth use finite soil; no standing stock means no resurrection.
    if (guild.vegetativeKg > 0 && patch.soilMoisture > 0.1 && patch.canopyCover <= 0.9) {
      const headroom = Math.max(0, guild.capacityKg * FLOWERING_POLICY.growthCeilingShare
        - standing(guild));
      const wanted = Math.min(headroom, guild.vegetativeKg * FLOWERING_POLICY.growthRatePerHour
        * patch.soilMoisture * hours);
      const grown = Math.min(wanted, Math.max(0, patch.soilNutrients) / NUTRIENT_PER_KG_BIOMASS);
      guild.vegetativeKg += grown;
      patch.soilNutrients -= grown * NUTRIENT_PER_KG_BIOMASS;
    }

    const year = yearOf(at), day = dayOfYear(at);
    if (!guild.bloom && guild.lastBloomYear < year
      && day >= FLOWERING_POLICY.bloomStartDay && day < FLOWERING_POLICY.bloomCloseDay
      && guild.vegetativeKg > 0) {
      const opened = guild.vegetativeKg * FLOWERING_POLICY.bloomShare;
      guild.vegetativeKg -= opened;
      guild.bloom = { openedAt: at,
        closesAt: guildYearInstant(year, FLOWERING_POLICY.bloomCloseDay),
        maturesAt: guildYearInstant(year, FLOWERING_POLICY.bloomCloseDay + FLOWERING_POLICY.maturationDays),
        openKg: opened, visitedKg: 0, closed: false };
      guild.lastBloomYear = year;
      push('flowering_started', opened);
    }
    if (guild.bloom && !guild.bloom.closed && at < guild.bloom.closesAt) {
      const pollinators = Math.max(0, micro.patches[patch.id]?.pollinatorBiomassKg ?? 0);
      const visited = Math.min(guild.bloom.openKg, guild.bloom.openKg
        * FLOWERING_POLICY.visitRatePerPollinatorKgHour * pollinators
        * Math.max(0, Math.min(1, patch.soilMoisture)) * hours);
      guild.bloom.openKg -= visited;
      guild.bloom.visitedKg += visited;
    }
  }
  return transitions;
}

/** Reject forged, duplicate or physically impossible saved reproductive state. */
export function validateFloweringGuild(patch: Patch, at: WorldTime): void {
  const guild = patch.floweringGuild;
  if (!guild) return;
  const finite = (n: number): boolean => Number.isFinite(n) && n >= 0;
  if (!floweringEligible(patch)
    || guild.guildId !== 'insect_visited_understorey_v1'
    || !finite(guild.capacityKg) || guild.capacityKg <= 0
    || !finite(guild.vegetativeKg)
    || !Number.isSafeInteger(guild.lastBloomYear) || guild.lastBloomYear < 0
    || guild.lastBloomYear > yearOf(at)
    || !Array.isArray(guild.seedBank) || guild.seedBank.length > 2
    || !finite(patch.capacity.browse) || !finite(patch.plant.browse)
    || Math.abs(patch.capacity.browse + guild.capacityKg
      - habitatBrowseCapacity(patch.habitat)) > 1e-6
    || standing(guild) > guild.capacityKg + 1e-7)
    throw new Error('invalid flowering guild checkpoint');
  if (guild.bloom) {
    const bloom = guild.bloom;
    if (![bloom.openedAt, bloom.closesAt, bloom.maturesAt, bloom.openKg, bloom.visitedKg]
      .every(finite) || typeof bloom.closed !== 'boolean'
      || bloom.openedAt > at || bloom.closesAt <= bloom.openedAt
      || bloom.maturesAt <= bloom.closesAt || bloom.maturesAt <= at
      || guild.lastBloomYear !== yearOf(bloom.openedAt)
      || bloom.closed !== (at >= bloom.closesAt) || bloom.closed && bloom.openKg > 1e-8)
      throw new Error('invalid flowering bloom checkpoint');
  }
  let previous = -1;
  for (const seed of guild.seedBank) {
    if (![seed.biomassKg, seed.maturedAt, seed.germinateAt, seed.expiresAt].every(finite)
      || seed.biomassKg <= 0 || seed.maturedAt > at
      || seed.germinateAt <= seed.maturedAt || seed.expiresAt <= seed.germinateAt
      || seed.expiresAt <= at || seed.maturedAt <= previous)
      throw new Error('invalid flowering seed checkpoint');
    previous = seed.maturedAt;
  }
}
