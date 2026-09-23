import { NUTRIENT_PER_KG_BIOMASS, type Patch, type Season } from '@vana/shared';

export const PLANT_GROWTH_RATE_PER_HOUR = 0.0025;

/**
 * Fraction of a patch's capacity that returns each hour regardless of how little is standing.
 * At 0.0003 a bare grassland patch is back to roughly half capacity in two months, which is
 * about right for a monsoon grassland recovering from heavy grazing.
 */
export const BASELINE_REGROWTH_PER_HOUR = 0.0003;

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

    // Two terms, because grass does not only grow from the grass that is left.
    //
    // The logistic term is the standing crop putting on more of itself. The baseline is root
    // reserves and seed rain: what brings a grazed-bare patch back. Without it, `rate x current`
    // meant a patch stripped to nothing regrew at nothing, so a herd that ate one patch out
    // moved on and starved the whole neighbourhood behind it.
    const wanted =
      current * PLANT_GROWTH_RATE_PER_HOUR * factor * headroom * hours +
      capacity * BASELINE_REGROWTH_PER_HOUR * factor * headroom * hours;

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
