/** Node CPU and sampled-root work only, not GPU/browser FPS.
 * npm exec tsx tools/performance/tree-checkpoints.ts
 */
import assert from 'node:assert/strict';
import { buildGrid } from '@vana/sim';
import { planVegetation, TreePlacementCache } from '../../packages/client/src/vegetation.js';
import { makeHeightSampler, type PatchView } from '../../packages/client/src/terrain.js';

const initial: PatchView[] = buildGrid(1, 'island_v1').map((p) => ({ ...p,
  grass: p.plant.grass, browse: p.plant.browse, water: p.waterVolume }));
const changedId = initial.find((p) => p.surface === 'land' && p.habitat === 'shola')!.id;
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
const results = [];
for (const scenario of ['grass-only', 'one-canopy-patch', 'all-canopy-patches'] as const) {
  const cache = new TreePlacementCache(), sampler = makeHeightSampler(initial);
  let queries = 0;
  const ground = (x: number, z: number) => { queries++; return sampler(x, z); };
  cache.get(initial, ground);
  const uncachedTimes: number[] = [], cachedTimes: number[] = [];
  const uncachedQueries: number[] = [], cachedQueries: number[] = [];
  let trees = 0;
  for (let iteration = 0; iteration < 15; iteration++) {
    const source = initial.map((p) => ({ ...p, grass: p.grass * (1 - iteration * .01),
      canopyCover: p.canopyCover! * (scenario === 'all-canopy-patches' || scenario === 'one-canopy-patch' && p.id === changedId
        ? 1 - (iteration + 1) * .015 : 1) }));
    queries = 0; let start = performance.now();
    const reference = planVegetation(source, { x: 2850, z: 2850 }, 4500, ground, { only: (kind) => kind.includes('Tree') });
    const uncachedMs = performance.now() - start, fullQueries = queries;
    queries = 0; start = performance.now(); const result = cache.get(source, ground);
    const cachedMs = performance.now() - start, reusedQueries = queries;
    assert.deepEqual(result, reference, 'All plant coordinates, heights, rotations, scales and ordering must agree');
    trees = [...result.values()].reduce((sum, plants) => sum + plants.length, 0);
    if (iteration >= 3) {
      uncachedTimes.push(uncachedMs); cachedTimes.push(cachedMs);
      uncachedQueries.push(fullQueries); cachedQueries.push(reusedQueries);
    }
  }
  results.push({ scenario, measuredCheckpoints: cachedTimes.length, finalTrees: trees,
    medianUncachedMs: median(uncachedTimes), medianCachedMs: median(cachedTimes),
    medianUncachedHeightQueries: median(uncachedQueries), medianCachedHeightQueries: median(cachedQueries) });
  cache.clear();
}
console.log(JSON.stringify({ scope: 'Node CPU and terrain sample counts, not browser/GPU FPS',
  fixture: 'Canonical seed-1 island grid with deterministic grass/canopy edits, not live ecology',
  baseline: 'Uncached full-world tree placement; same post-refactor count calculation as cached path',
  node: process.version, platform: `${process.platform}/${process.arch}`, changedId, results }, null, 2));
