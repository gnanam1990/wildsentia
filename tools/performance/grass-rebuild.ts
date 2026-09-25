/** Node CPU / queued upload metadata, not browser FPS or measured GPU transfers.
 * npm exec tsx tools/performance/grass-rebuild.ts
 * No world state, network, browser, or output files are touched.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { islandHeightAt } from '@vana/shared';
import { GroundCover, planGroundCover } from '../../packages/client/src/groundCover.js';
import { RENDER_BUDGETS, type RenderTier } from '../../packages/client/src/renderQuality.js';
import type { PatchView } from '../../packages/client/src/terrain.js';

const patches: PatchView[] = Array.from({ length: 400 }, (_, id) => ({ id, x: id % 20, y: Math.floor(id / 20),
  habitat: 'grassland', grass: 6000, browse: 0, water: 200 }));
const ground = (x: number, z: number) => islandHeightAt(1, x, z);
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]!;

function baseline(meshes: THREE.InstancedMesh[], focus: { x: number; z: number }, tier: RenderTier) {
  // Original monolithic plan+compose+write loop, including its whole-capacity upload metadata.
  const plan = planGroundCover(patches, focus, ground, tier);
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3(), scale = new THREE.Vector3(), colour = new THREE.Color();
  const counts = [0, 0];
  for (const tuft of plan) {
    const level = Math.hypot(tuft.x - focus.x, tuft.z - focus.z) < RENDER_BUDGETS[tier].curvedRadius ? 0 : 1;
    const mesh = meshes[level]!, i = counts[level]!++;
    rotation.setFromAxisAngle(up, tuft.rotation);
    matrix.compose(position.set(tuft.x, tuft.y - .01, tuft.z), rotation, scale.set(tuft.width, tuft.height, tuft.width));
    mesh.setMatrixAt(i, matrix);
    colour.setRGB(.78 + tuft.tint * .22, .88 + tuft.tint * .12, .72 + tuft.tint * .20);
    mesh.setColorAt(i, colour);
  }
  meshes.forEach((mesh, i) => {
    mesh.count = counts[i]!; mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor!.needsUpdate = true;
  });
}

const results = [];
for (const tier of ['smooth', 'balanced', 'high'] as const) {
  const old = new GroundCover(patches, ground), sliced = new GroundCover(patches, ground);
  sliced.setQuality(tier);
  const oldMeshes = old.root.children as THREE.InstancedMesh[], newMeshes = sliced.root.children as THREE.InstancedMesh[];
  const oldCalls: number[] = [], slices: number[] = [], frames: number[] = [], totals: number[] = [];
  let oldBytes = 0, nextBytes = 0, instances = 0;
  for (let iteration = 0; iteration < 15; iteration++) {
    const focus = { x: 2900 + iteration * 11, z: 3000 };
    let start = performance.now(); baseline(oldMeshes, focus, tier);
    if (iteration >= 3) oldCalls.push(performance.now() - start);
    let count = 0, total = 0;
    do {
      start = performance.now(); sliced.update(focus, 2);
      const elapsed = performance.now() - start; total += elapsed; count++;
      if (iteration >= 3) slices.push(elapsed);
      assert(count < 500);
    } while (sliced.preparing);
    if (iteration >= 3) { frames.push(count); totals.push(total); }
    newMeshes.forEach((mesh, i) => {
      const prior = oldMeshes[i]!;
      assert.equal(mesh.count, prior.count);
      assert.deepEqual(mesh.instanceMatrix.array.slice(0, mesh.count * 16), prior.instanceMatrix.array.slice(0, prior.count * 16));
      assert.deepEqual(mesh.instanceColor!.array.slice(0, mesh.count * 3), prior.instanceColor!.array.slice(0, prior.count * 3));
    });
    oldBytes = oldMeshes.reduce((sum, mesh) => sum + (mesh.instanceMatrix.array.length + mesh.instanceColor!.array.length) * 4, 0);
    nextBytes = newMeshes.reduce((sum, mesh) => sum + [...mesh.instanceMatrix.updateRanges, ...mesh.instanceColor!.updateRanges]
      .reduce((n, r) => n + r.count * 4, 0), 0);
    instances = newMeshes.reduce((n, mesh) => n + mesh.count, 0);
    // Acknowledge the prior upload as WebGLAttributes does. GPU is not actually running here.
    for (const mesh of newMeshes) { mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceColor!.clearUpdateRanges(); }
  }
  results.push({ tier, measuredRebuilds: oldCalls.length, instances, originalMedianMs: quantile(oldCalls, .5),
    sliceMedianMs: quantile(slices, .5), sliceP95Ms: quantile(slices, .95), sliceMaxMs: Math.max(...slices),
    medianFramesToCommit: quantile(frames, .5), slicedMedianTotalCpuMs: quantile(totals, .5),
    originalQueuedBytes: oldBytes, slicedQueuedBytes: nextBytes, retainedExtraCpuBytes: oldBytes });
  old.dispose(); sliced.dispose();
}
console.log(JSON.stringify({ scope: 'Node CPU / queued buffer metadata only; no browser FPS or GPU measurements',
  fixture: 'Uniform grassland render fixture over islandHeightAt(1), 11m camera moves; not an ecological population test',
  baseline: 'Original compose loop; reference planner now shares the yielding cell traversal, drained synchronously',
  caveat: 'Cooperative chunks and final prefix copies can overrun 2ms; no hard real-time promise. Initial GPU allocations remain full capacity.',
  node: process.version, platform: `${process.platform}/${process.arch}`, results }, null, 2));
