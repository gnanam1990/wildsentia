/** Direct-vs-precomputed client height work on the canonical island. No browser or live world.
 * npm exec tsx tools/performance/height-field.ts
 */
import assert from 'node:assert/strict';
import { buildGrid } from '@vana/sim';
import { islandHeightAt } from '@vana/shared';
import { islandHeightField } from '../../packages/client/src/islandHeightField.js';
import { planVegetation, nearPlan } from '../../packages/client/src/vegetation.js';
import { planGroundCover } from '../../packages/client/src/groundCover.js';
import type { PatchView } from '../../packages/client/src/terrain.js';

const patches: PatchView[] = buildGrid(1, 'island_v1').map((p) => ({ ...p,
  grass: p.plant.grass, browse: p.plant.browse, water: p.waterVolume }));
const dense = patches.find((p) => p.surface === 'land' && p.habitat === 'shola')!;
const focus = { x: dense.x * 300, z: dense.y * 300 };
const direct = (x: number, z: number) => islandHeightAt(1, x, z);
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
const results = [];
for (const kind of ['whole-tree-cold', 'near-vegetation', 'grass-high'] as const) {
  const original: number[] = [], cached: number[] = [], initialization: number[] = [];
  const plan = (ground: (x: number, z: number) => number) => kind === 'whole-tree-cold'
    ? planVegetation(patches, { x: 2850, z: 2850 }, 4500, ground, { only: (key) => key.includes('Tree') })
    : kind === 'near-vegetation' ? nearPlan(patches, focus, ground) : planGroundCover(patches, focus, ground, 'high');
  for (let iteration = 0; iteration < 15; iteration++) {
    let start = performance.now(); const reference = plan(direct); const beforeMs = performance.now() - start;
    // Explicitly evict outside the measured region so every iteration measures fresh field initialization.
    islandHeightField(1000 + iteration);
    start = performance.now(); const field = islandHeightField(1); const initMs = performance.now() - start;
    start = performance.now(); const actual = plan(field.sample); const afterMs = performance.now() - start;
    assert.deepEqual(actual, reference, `${kind}: exact output, not fewer placements or approximate heights`);
    if (iteration >= 3) { original.push(beforeMs); cached.push(afterMs); initialization.push(initMs); }
  }
  results.push({ kind, measuredRuns: original.length, originalMedianMs: median(original),
    tableInitializationMedianMs: median(initialization), preparedSamplingMedianMs: median(cached) });
}
console.log(JSON.stringify({ scope: 'Node planning CPU only; excludes browser GPU/shader/texture/asset load',
  fixture: 'Canonical seed-1 island; whole forest trees and dense shola near/grass cover', focus,
  storageBytesPerField: islandHeightField(1).byteLength, globalCacheEntries: 1,
  caveat: 'Existing sampler closures can retain an older seed during scene transitions. Initialization is paid once per cold seed, not each planner.',
  node: process.version, platform: `${process.platform}/${process.arch}`, results }, null, 2));
