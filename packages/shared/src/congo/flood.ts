import type { HabitatType, Season } from '../index.js';

/**
 * Whether a patch stands in water (Congo 1B): river channels always; flooded forest in the
 * rainy seasons, when the rivers spill into it. Everything else is dry ground.
 */
export function isFlooded(patch: { readonly habitat: HabitatType | string }, season: Season): boolean {
  if (patch.habitat === 'water') return true;
  return patch.habitat === 'flooded_forest' && (season === 'monsoon' || season === 'wet');
}
