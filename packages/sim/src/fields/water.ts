import type { Patch, Season } from '@vana/shared';

const RAINFALL_L_PER_HOUR: Record<Season, number> = {
  monsoon: 90, wet: 45, transition: 12, dry: 2,
};

const EVAPORATION_FRACTION_PER_HOUR: Record<Season, number> = {
  monsoon: 0.0006, wet: 0.0012, transition: 0.0028, dry: 0.0045,
};

/**
 * Springs and seepage, which keep flowing when the rain stops. Without them every pool in the
 * forest, lakes included, dried to a few hundred litres by the end of the dry season and the
 * elephants and gaur died of thirst each year. Rain-fed ground still dries out; lakes and
 * marshes are what a dry-season forest gathers around.
 */
const BASEFLOW_L_PER_HOUR: Partial<Record<Patch['habitat'], number>> = {
  water: 400, marsh: 20,
};

/** Fraction of the remaining dryness a litre of hourly rain restores. */
const SOIL_RECHARGE_PER_LITRE = 0.00004;
/** Soil loses moisture more slowly than open water evaporates. */
const SOIL_DRYING_FACTOR = 0.7;

export function updateWater(patch: Patch, hours: number, season: Season): void {
  const rain = (RAINFALL_L_PER_HOUR[season] + (BASEFLOW_L_PER_HOUR[patch.habitat] ?? 0)) * hours;
  const evaporated = patch.waterVolume * EVAPORATION_FRACTION_PER_HOUR[season] * hours;
  const capacity = patch.habitat === 'water' ? 80_000 : patch.habitat === 'marsh' ? 12_000 : 1_200;

  patch.waterVolume = Math.max(0, Math.min(capacity, patch.waterVolume + rain - evaporated));
  // Rain and seepage recharge the soil toward saturation; evaporation dries it in proportion to
  // what it holds. The balance settles near 0.9 in the monsoon and near 0.03 at the height of
  // the dry season, with a marsh's seepage keeping it damp. Drying once subtracted the
  // evaporation fraction as an absolute amount, which left every patch bone dry from the first
  // monsoon on and held plants to forty percent of their growth all year.
  const recharge = rain * SOIL_RECHARGE_PER_LITRE;
  const drying = EVAPORATION_FRACTION_PER_HOUR[season] * SOIL_DRYING_FACTOR * hours;
  patch.soilMoisture = Math.max(0, Math.min(1,
    patch.soilMoisture + recharge * (1 - patch.soilMoisture) - drying * patch.soilMoisture));
}
