import { NUTRIENT_PER_KG_BIOMASS, landWalkable, type HabitatType, type Patch, type Season } from '@vana/shared';
import { SEASON_GROWTH_FACTOR } from './plants.js';

/**
 * sim_0.37.0: the rooting and mast food of a patch, the food that limits wild boar.
 *
 * Wild boar live on what they dig and pick up: underground storage organs (roots, tubers,
 * bulbs, rhizomes), soil invertebrates, and fallen fruit and seed (mast). Their numbers and
 * their breeding follow that supply: in European forests reproduction and piglet survival rise
 * and fall with the mast crop (Bieber & Ruf 2005; Servanty et al. 2009). Until now the island's
 * pigs ate grass and browse as freely as deer, from a forage pool that never fell below a third of
 * capacity, so nothing limited them and they reached 26-38 per km² (Nagarahole: 4.2 per km²).
 *
 * The pool is finite. It regrows from the soil's own nutrients, logistic toward a capacity by
 * habitat, faster in the monsoon (the same seasonal factors as the plants above it), and boar
 * deplete it. Capacities and rates are uncalibrated model policy: no measured standing stock of
 * pig food per hectare of Indian forest was found. They are set so that, with the island's
 * predators, boar settle at a field density rather than at whatever grass allows.
 */
export const ROOTING_CAPACITY_KG: Record<HabitatType, number> = {
  // Kilograms of digestible rooting and mast food per 300 m patch (9 ha) at capacity.
  shola: 2200,     // evergreen forest: fruit and seed fall, tubers, litter invertebrates
  riparian: 2200,  // moist soil: rhizomes, bulbs, earthworms
  marsh: 1300,
  grassland: 1000, // grass rhizomes and bulbs, few fruiting trees
  rock: 200,
  water: 0,
};

/** Logistic regrowth per hour, before the seasonal and moisture factors (about 3-7 a year). */
export const ROOTING_GROWTH_RATE_PER_HOUR = 0.001;
/** Recolonisation of a dug-out patch from seed rain, roots left behind and invertebrates moving in. */
export const ROOTING_BASELINE_REGROWTH_PER_HOUR = 0.0001;

export function rootingEligible(patch: Patch): boolean {
  return landWalkable(patch) && ROOTING_CAPACITY_KG[patch.habitat] > 0;
}

/**
 * Establish each eligible patch's pool at 60% of capacity (as plants are founded), paid for out
 * of the patch's soil nutrients so the world's nutrient total is unchanged. Used at founding and
 * by the explicit sim_0.36 upgrade. A patch that already has a pool is left alone.
 */
export function establishRooting(patches: Patch[]): void {
  for (const patch of patches) {
    if (patch.rooting !== undefined || !rootingEligible(patch)) continue;
    const capacityKg = ROOTING_CAPACITY_KG[patch.habitat];
    const kg = Math.min(capacityKg * 0.6, Math.max(0, patch.soilNutrients) / NUTRIENT_PER_KG_BIOMASS);
    patch.soilNutrients -= kg * NUTRIENT_PER_KG_BIOMASS;
    patch.rooting = { kg, capacityKg };
  }
}

/** Regrow toward capacity, paid for out of the soil. Returns the kilograms grown. */
export function growRooting(patch: Patch, hours: number, season: Season): number {
  const pool = patch.rooting;
  if (!pool || pool.capacityKg <= 0) return 0;
  const headroom = 1 - pool.kg / pool.capacityKg;
  if (headroom <= 0) return 0;
  const factor = SEASON_GROWTH_FACTOR[season] * (0.4 + patch.soilMoisture * 0.6);
  const wanted = (pool.kg * ROOTING_GROWTH_RATE_PER_HOUR + pool.capacityKg * ROOTING_BASELINE_REGROWTH_PER_HOUR)
    * factor * headroom * hours;
  const applied = Math.min(wanted, pool.capacityKg - pool.kg, Math.max(0, patch.soilNutrients) / NUTRIENT_PER_KG_BIOMASS);
  if (!(applied > 0)) return 0;
  pool.kg += applied;
  patch.soilNutrients -= applied * NUTRIENT_PER_KG_BIOMASS;
  return applied;
}

/** Reject a corrupted or misplaced checkpointed pool. */
export function validateRooting(patch: Patch): void {
  const pool = patch.rooting;
  if (pool === undefined) return;
  if (!rootingEligible(patch) || !Number.isFinite(pool.kg) || !Number.isFinite(pool.capacityKg)
    || pool.capacityKg <= 0 || pool.kg < 0 || pool.kg > pool.capacityKg + 1e-6)
    throw new Error('invalid rooting food checkpoint');
}
