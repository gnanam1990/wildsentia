import {
  GRID_SIZE, PATCH_COUNT, createRng,
  type HabitatType, type Patch,
} from '@vana/shared';

const CAPACITY_BY_HABITAT: Record<HabitatType, { grass: number; browse: number }> = {
  grassland: { grass: 9000, browse: 500 },
  shola:     { grass: 1200, browse: 7000 },
  riparian:  { grass: 5000, browse: 4000 },
  marsh:     { grass: 3500, browse: 900 },
  rock:      { grass: 300,  browse: 200 },
  water:     { grass: 0,    browse: 0 },
};

function habitatFor(elevation: number, moisture: number): HabitatType {
  if (moisture > 0.62) return 'water';
  if (moisture > 0.57) return 'marsh';
  if (elevation > 0.62) return 'rock';
  if (moisture > 0.52) return 'riparian';
  if (elevation > 0.48) return 'grassland';
  return 'shola';
}

export function buildGrid(seed: number): Patch[] {
  const rng = createRng(seed, 'grid');
  const elevationNoise = Array.from({ length: PATCH_COUNT }, () => rng.next());
  const moistureNoise = Array.from({ length: PATCH_COUNT }, () => rng.next());

  const patches: Patch[] = [];
  for (let id = 0; id < PATCH_COUNT; id++) {
    const x = id % GRID_SIZE;
    const y = Math.floor(id / GRID_SIZE);

    // Smooth the noise against neighbours so habitats form contiguous regions.
    const smooth = (source: number[]): number => {
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) continue;
          sum += source[ny * GRID_SIZE + nx]!;
          n++;
        }
      }
      return sum / n;
    };

    const elevation = smooth(elevationNoise);
    const moisture = smooth(moistureNoise);
    const habitat = habitatFor(elevation, moisture);
    const capacity = { ...CAPACITY_BY_HABITAT[habitat] };

    const neighbours: number[] = [];
    if (x > 0) neighbours.push(id - 1);
    if (x < GRID_SIZE - 1) neighbours.push(id + 1);
    if (y > 0) neighbours.push(id - GRID_SIZE);
    if (y < GRID_SIZE - 1) neighbours.push(id + GRID_SIZE);

    patches.push({
      id, x, y, elevation, habitat,
      canopyCover: habitat === 'shola' ? 0.85 : habitat === 'riparian' ? 0.5 : 0.1,
      plant: { grass: capacity.grass * 0.6, browse: capacity.browse * 0.6 },
      capacity,
      soilMoisture: moisture,
      soilNutrients: 400 + moisture * 200,
      waterVolume: habitat === 'water' ? 50_000 : habitat === 'marsh' ? 8_000 : moisture * 600,
      neighbours,
    });
  }
  return patches;
}
