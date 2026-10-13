import {
  ISLAND_GRID, cardinalNeighbours, createRng, gridForProfile, islandPatchSurface, islandHeightAt, patchCentre, patchCount,
  patchIdAt, landWalkable, isIslandProfile, islandGeometrySeed, type HabitatType, type Patch, type TerrainProfile, type WorldGrid,
} from '@vana/shared';

/** Six 300 m cardinal patches keep the two perennial basins in separate local ranges. */
export const ISLAND_BASIN_SEPARATION_PATCHES = 6;
export const ISLAND_INITIAL_LAKE_WATER_L = 50_000;

const basinDistance = (a: Patch, b: Patch): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const hasSeparatedPair = (patches: readonly Patch[], ids: readonly number[]): boolean =>
  ids.some((id, i) => ids.slice(i + 1).some(other =>
    basinDistance(patches[id]!, patches[other]!) >= ISLAND_BASIN_SEPARATION_PATCHES));

/**
 * Pure island geology choice: IDs to promote, not a mutation or a water grant. Existing lakes
 * count and remain untouched. A saved-world upgrade must preserve its current water inventory
 * and separately account for any displaced vegetation; only new world generation seeds stock.
 */
export function islandFreshwaterBasinIds(patches: readonly Patch[]): number[] {
  if (patches.length !== patchCount(ISLAND_GRID) || patches.some((p, i) => p.id !== i || p.islandSeed === undefined))
    throw new Error('island basins require a complete island patch grid');
  const land = patches.filter(landWalkable);
  const existing = land.filter(p => p.habitat === 'water').map(p => p.id);
  if (hasSeparatedPair(patches, existing)) return [];

  const habitatPriority: Record<HabitatType, number> = {
    marsh: 0, riparian: 1, shola: 2, grassland: 3, rock: 4, water: 5,
  };
  const candidates = land.filter(p => p.habitat !== 'water').sort((a, b) =>
    habitatPriority[a.habitat] - habitatPriority[b.habitat]
    || a.elevation - b.elevation || a.id - b.id);
  const chosen = [...existing], promoted: number[] = [];
  if (!chosen.length) {
    const first = candidates.shift();
    if (!first) throw new Error('island has no land for a freshwater basin');
    chosen.push(first.id); promoted.push(first.id);
  }
  if (!hasSeparatedPair(patches, chosen)) {
    const second = candidates.find(p => chosen.some(id => basinDistance(p, patches[id]!)
      >= ISLAND_BASIN_SEPARATION_PATCHES));
    if (!second) throw new Error('island cannot place separated freshwater basins');
    promoted.push(second.id);
  }
  return promoted;
}

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

export function buildGrid(seed: number, profile: TerrainProfile = 'mainland', grid: WorldGrid = gridForProfile(profile)): Patch[] {
  const island = isIslandProfile(profile), geometry = island ? islandGeometrySeed(seed, profile) : seed;
  const rng = createRng(seed, 'grid');
  const count = patchCount(grid);
  const elevationNoise = Array.from({ length: count }, () => rng.next());
  const moistureNoise = Array.from({ length: count }, () => rng.next());

  const patches: Patch[] = [];
  for (let id = 0; id < count; id++) {
    const x = id % grid.cols;
    const y = Math.floor(id / grid.cols);

    // Smooth the noise against neighbours so habitats form contiguous regions.
    const smooth = (source: number[]): number => {
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const at = patchIdAt(grid, x + dx, y + dy);
          if (at === null) continue;
          sum += source[at]!;
          n++;
        }
      }
      return sum / n;
    };

    const elevation = smooth(elevationNoise);
    const moisture = smooth(moistureNoise);
    const habitat = habitatFor(elevation, moisture);
    const capacity = { ...CAPACITY_BY_HABITAT[habitat] };

    const neighbours = cardinalNeighbours(grid, id);

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
  if (island) for (const p of patches) {
    p.islandSeed = geometry; p.surface = islandPatchSurface(geometry, p.id);
    const centre = patchCentre(grid, p.id);
    p.elevation = Math.max(0, islandHeightAt(geometry, centre.x, centre.z)) / 90;
    if (p.surface !== 'land') {
      p.habitat = p.surface === 'ocean' ? 'water' : 'rock';
      p.canopyCover = 0; p.plant = { grass: 0, browse: 0 }; p.capacity = { grass: 0, browse: 0 };
      p.waterVolume = 0; p.soilNutrients = 0; p.soilMoisture = 0;
    }
  }
  if (island) for (const id of islandFreshwaterBasinIds(patches)) {
    const patch = patches[id]!;
    patch.habitat = 'water'; patch.canopyCover = 0;
    patch.plant = { grass: 0, browse: 0 };
    patch.capacity = { grass: 0, browse: 0 };
    patch.soilMoisture = 1;
    patch.waterVolume = ISLAND_INITIAL_LAKE_WATER_L;
  }
  return patches;
}
