import { NUTRIENT_PER_KG_BIOMASS, type Patch, type Season } from '@vana/shared';

export const PLANT_GROWTH_RATE_PER_HOUR = 0.0025;

export const SEASON_GROWTH_FACTOR: Record<Season, number> = {
  monsoon: 1.4, wet: 1.1, transition: 0.8, dry: 0.35,
};

export interface GrowthResult { grew: number; nutrientsDrawn: number }

/** Logistic growth toward capacity, paid for out of the patch's soil nutrients. */
export function growPlants(patch: Patch, hours: number, season: Season): GrowthResult {
  const factor = SEASON_GROWTH_FACTOR[season] * (0.4 + patch.soilMoisture * 0.6);
  let grew = 0;
  let nutrientsDrawn = 0;

  for (const key of ['grass', 'browse'] as const) {
    const capacity = patch.capacity[key];
    if (capacity <= 0) continue;
    const current = patch.plant[key];
    const headroom = 1 - current / capacity;
    if (headroom <= 0) continue;

    // Seed bank: a stripped patch can still recover from neighbouring seed rain.
    const wanted =
      current * PLANT_GROWTH_RATE_PER_HOUR * factor * headroom * hours +
      (current < capacity * 0.02 ? 0.05 * hours * factor : 0);

    const cost = wanted * NUTRIENT_PER_KG_BIOMASS;
    const affordable = Math.min(cost, Math.max(0, patch.soilNutrients - nutrientsDrawn));
    const applied = Math.min(affordable / NUTRIENT_PER_KG_BIOMASS, capacity - current);
    if (applied <= 0) continue;

    patch.plant[key] = current + applied;
    grew += applied;
    nutrientsDrawn += applied * NUTRIENT_PER_KG_BIOMASS;
  }

  patch.soilNutrients -= nutrientsDrawn;
  return { grew, nutrientsDrawn };
}
