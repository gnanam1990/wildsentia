/**
 * Land, habitats and water of the island profiles on given seeds (sim_0.37.0 adds island_v2).
 *
 *   npx tsx tools/diagnostics/islandLand.ts [--seeds 1,2,3]
 */
import { ISLAND_GRID, landWalkable } from '@vana/shared';
import { buildGrid } from '@vana/sim';

const i = process.argv.indexOf('--seeds');
const seeds = (i >= 0 ? process.argv[i + 1]! : '1,2,3').split(',').map(Number);
const km2 = (ISLAND_GRID.patchM / 1000) ** 2;
for (const seed of seeds) for (const profile of ['island_v1', 'island_v2'] as const) {
  const patches = buildGrid(seed, profile), land = patches.filter(landWalkable);
  const habitats: Record<string, number> = {};
  for (const p of land) habitats[p.habitat] = (habitats[p.habitat] ?? 0) + 1;
  const waterL = land.reduce((n, p) => n + p.waterVolume, 0);
  console.log(JSON.stringify({ profile, seed, landCells: land.length, landKm2: +(land.length * km2).toFixed(2),
    habitats, basins: land.filter(p => p.habitat === 'water').length, waterL: Math.round(waterL) }));
}
