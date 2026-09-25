/** Actual island placements and source-tree bounds; submission counts/Node CPU, NOT GPU FPS.
 * npm exec tsx tools/performance/forest-batches.ts */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildGrid } from '@vana/sim';
import { TreePlacementCache, NATURE_KINDS } from '../../packages/client/src/vegetation.js';
import { makeHeightSampler, type PatchView } from '../../packages/client/src/terrain.js';
import { ForestBatches, FOREST_CELL_M } from '../../packages/client/src/forestBatches.js';
import { FOREST_RADIUS_M, type TreeAtlas } from '../../packages/client/src/treeLod.js';

async function sourceAtlas(file: string): Promise<TreeAtlas> {
  const bytes = readFileSync(new URL(`../../packages/client/public/assets/nature/${file}`, import.meta.url));
  const jsonLength = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  // Geometry-only GLB parse. No browser, images, network, WebGL context or atlas rendering.
  delete json.images; delete json.textures; delete json.materials;
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  const jsonBytes = Buffer.from(JSON.stringify(json)), paddedLength = Math.ceil(jsonBytes.length / 4) * 4;
  const tail = bytes.subarray(20 + jsonLength), output = Buffer.alloc(20 + paddedLength + tail.length, 0x20);
  bytes.copy(output, 0, 0, 12); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedLength, 12); output.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(output, 20); tail.copy(output, 20 + paddedLength);
  const gltf = await new GLTFLoader().parseAsync(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength), '');
  const sphere = new THREE.Box3().setFromObject(gltf.scene).getBoundingSphere(new THREE.Sphere());
  gltf.scene.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) {
    mesh.geometry.dispose(); for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
  } });
  return { target: new THREE.WebGLRenderTarget(1, 1), centre: sphere.center, diameter: sphere.radius * 2.1 };
}

const patches: PatchView[] = buildGrid(1, 'island_v1').map((p) => ({ ...p, grass: p.plant.grass, browse: p.plant.browse, water: p.waterVolume }));
const ground = makeHeightSampler(patches), plan = new TreePlacementCache().get(patches, ground);
const atlases = new Map<string, TreeAtlas>(), forests: ForestBatches[] = [];
let coldBuildMs = 0;
for (const [kind, items] of plan) {
  const file = NATURE_KINDS[kind]!.file;
  if (!atlases.has(file)) atlases.set(file, await sourceAtlas(file));
  const forest = new ForestBatches(atlases.get(file)!, kind); forests.push(forest);
  const start = performance.now(); forest.setItems(items); coldBuildMs += performance.now() - start;
  forest.root.updateMatrixWorld(true);
}
const allMeshes = forests.flatMap((f) => f.root.children as THREE.InstancedMesh[]).filter((m) => m.count > 0);
const total = [...plan.values()].reduce((sum, plants) => sum + plants.length, 0);
assert.equal(allMeshes.reduce((sum, m) => sum + m.count, 0), total);
const versions = allMeshes.map((m) => m.instanceMatrix.version);
const dense = patches.find((p) => p.surface === 'land' && p.habitat === 'shola')!;
const positions = [{ name: 'dense-shola', x: dense.x * 300, z: dense.y * 300 }, { name: 'island-centre', x: 2850, z: 2850 }];
const results = [];
for (const focus of positions) for (const view of ['north', 'south', 'east', 'overhead'] as const) {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, .3, 12000);
  const height = ground(focus.x, focus.z);
  camera.position.set(focus.x, height + (view === 'overhead' ? 600 : 12), focus.z);
  camera.lookAt(focus.x + (view === 'east' ? 300 : 0), height, focus.z + (view === 'north' ? -300 : view === 'south' ? 300 : 0));
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  let oldInstances = 0, oldDraws = 0;
  for (const items of plan.values()) {
    const n = items.filter((p) => Math.hypot(p.x - focus.x, p.z - focus.z) < FOREST_RADIUS_M).length;
    oldInstances += n; if (n) oldDraws++;
  }
  const samples: number[] = [];
  let visible: THREE.InstancedMesh[] = [];
  for (let run = 0; run < 100; run++) {
    const start = performance.now();
    for (const forest of forests) forest.updateRange(focus);
    visible = allMeshes.filter((m) => m.visible && frustum.intersectsObject(m));
    if (run >= 10) samples.push(performance.now() - start);
  }
  const instances = visible.reduce((sum, m) => sum + m.count, 0);
  results.push({ position: focus.name, view, oldSubmittedInstances: oldInstances, submittedInstances: instances,
    instanceReductionPercent: (1 - instances / oldInstances) * 100, oldDrawCalls: oldDraws, drawCalls: visible.length,
    rangeAndFrustumMedianMs: samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] });
}
assert.deepEqual(allMeshes.map((m) => m.instanceMatrix.version), versions, 'Camera motion must not upload any matrices');
const instanceBufferBytes = allMeshes.reduce((sum, m) => sum + m.instanceMatrix.array.byteLength, 0);
for (const forest of forests) forest.dispose();
for (const atlas of atlases.values()) atlas.target.dispose();
console.log(JSON.stringify({ scope: 'Node submission/CPU diagnostic. Excludes raster/fragment work, GPU timings and whole-scene FPS.',
  fixture: 'Canonical seed-1 island with actual packaged tree bounds; 50 degree FOV, 16:9',
  caveat: 'Spatial culling increases draw calls while reducing submitted instances. More instances can remain at range boundaries to preserve whole crowns; device profiling still required.',
  node: process.version, platform: `${process.platform}/${process.arch}`, totalPreservedTrees: total,
  cellMetres: FOREST_CELL_M, cells: allMeshes.length, coldBuildMs, instanceBufferBytes, cameraDrivenMatrixUploads: 0, results }, null, 2));
