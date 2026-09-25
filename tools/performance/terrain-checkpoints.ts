/** Node CPU + new geometry/instance allocation accounting; not browser FPS/VRAM.
 * npm exec tsx tools/performance/terrain-checkpoints.ts
 * Uses the canonical seed-1 island grid; never starts or alters a live world.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildGrid } from '@vana/sim';
import { buildTerrain, type PatchView } from '../../packages/client/src/terrain.js';
import { disposeTerrain } from '../../packages/client/src/environment.js';
import { TerrainCheckpoints } from '../../packages/client/src/terrainCheckpoints.js';

const initial: PatchView[] = buildGrid(1, 'island_v1').map((p) => ({ ...p,
  grass: p.plant.grass, browse: p.plant.browse, water: p.waterVolume }));
const asBytes = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function allocation(root: THREE.Group) {
  let bytes = 0;
  for (const mesh of root.children as THREE.Mesh[]) {
    for (const a of Object.values(mesh.geometry.attributes)) bytes += a.array.byteLength;
    bytes += mesh.geometry.index?.array.byteLength ?? 0;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) bytes += (mesh as THREE.InstancedMesh).instanceMatrix.array.byteLength;
    if (mesh.userData.base) bytes += (mesh.userData.base as Float32Array).byteLength;
  }
  return bytes;
}
function verify(a: THREE.Group, b: THREE.Group) {
  assert.deepEqual(a.children.map((c) => c.name).sort(), b.children.map((c) => c.name).sort());
  for (const mesh of a.children as THREE.Mesh[]) {
    const other = b.getObjectByName(mesh.name) as THREE.Mesh;
    for (const key of Object.keys(mesh.geometry.attributes)) assert(asBytes(mesh.geometry.getAttribute(key).array)
      .equals(asBytes(other.geometry.getAttribute(key).array)), `${mesh.name}.${key}`);
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const x = mesh as THREE.InstancedMesh, y = other as THREE.InstancedMesh;
      assert.equal(x.count, y.count); assert(asBytes(x.instanceMatrix.array).equals(asBytes(y.instanceMatrix.array)), mesh.name);
    }
  }
}
const results = [];
for (const mode of ['unchanged-draw-inputs', 'grass-and-water-changes'] as const) {
  const cache = new TerrainCheckpoints(); cache.commit(cache.prepare(initial));
  const fullMs: number[] = [], keyedMs: number[] = [];
  let fullBytes = 0, keyedBytes = 0; let changedLayers: string[] = [];
  for (let iteration = 0; iteration < 15; iteration++) {
    const source = initial.map((p) => ({ ...p, browse: p.browse + iteration,
      ...(mode === 'grass-and-water-changes' ? { grass: p.grass * (1 - (iteration + 1) * .003),
        water: p.water * (1 + (iteration + 1) * .003) } : {}) }));
    let start = performance.now(); const full = buildTerrain(source); const fullTime = performance.now() - start;
    start = performance.now(); const prepared = cache.prepare(source); const cachedTime = performance.now() - start;
    if (iteration >= 3) { fullMs.push(fullTime); keyedMs.push(cachedTime); }
    fullBytes = allocation(full); keyedBytes = allocation(prepared.root); changedLayers = prepared.root.children.map((c) => c.name);
    const actual = cache.commit(prepared); verify(full, actual); disposeTerrain(full);
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  results.push({ mode, measuredCheckpoints: fullMs.length, fullBuildMedianMs: median(fullMs),
    cachedPrepareMedianMs: median(keyedMs), fullNewBufferBytes: fullBytes, cachedNewBufferBytes: keyedBytes, changedLayers });
  cache.dispose();
}
console.log(JSON.stringify({ scope: 'Node CPU and newly allocated typed-array bytes; no browser/GPU/texture decoding measurement',
  fixture: 'Canonical seed-1 island founding grid with deterministic resource perturbations, not a running-world benchmark',
  node: process.version, platform: `${process.platform}/${process.arch}`, results }, null, 2));
