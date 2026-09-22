import type { Patch, Season } from '@vana/shared';

const RAINFALL_L_PER_HOUR: Record<Season, number> = {
  monsoon: 90, wet: 45, transition: 12, dry: 2,
};

const EVAPORATION_FRACTION_PER_HOUR: Record<Season, number> = {
  monsoon: 0.0006, wet: 0.0012, transition: 0.0028, dry: 0.0045,
};

export function updateWater(patch: Patch, hours: number, season: Season): void {
  const rain = RAINFALL_L_PER_HOUR[season] * hours;
  const evaporated = patch.waterVolume * EVAPORATION_FRACTION_PER_HOUR[season] * hours;
  const capacity = patch.habitat === 'water' ? 80_000 : patch.habitat === 'marsh' ? 12_000 : 1_200;

  patch.waterVolume = Math.max(0, Math.min(capacity, patch.waterVolume + rain - evaporated));
  patch.soilMoisture = Math.max(0, Math.min(1,
    patch.soilMoisture + (rain / 4000) * hours * 0.01 - EVAPORATION_FRACTION_PER_HOUR[season] * hours));
}
