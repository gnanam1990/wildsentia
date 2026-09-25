/** CPU/queued-buffer-work probe, not a browser/GPU/FPS benchmark. No files or world state written.
 * npm exec tsx tools/performance/animal-dots.ts
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { islandHeightAt } from '@vana/shared';
import { AnimalDots } from '../../packages/client/src/animalDots.js';
import type { AnimalState } from '../../packages/client/src/protocol.js';
import type { RenderPosition } from '../../packages/client/src/space.js';
import { visualFor } from '../../packages/client/src/species.js';

const capacity = 8000, count = 3000, measuredFrames = 240, warmupFrames = 30;
const animals = new Map<string, AnimalState>();
const positions = new Map<string, RenderPosition>();
for (let i = 0; i < count; i++) {
  const id = `a${i}`;
  animals.set(id, { id, speciesId: i % 2 ? 'chital' : 'hare', patchId: 0, state: 'resting',
    currentGoal: 'rest', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } });
  positions.set(id, { x: 1500 + i % 100 * 25, z: 1500 + Math.floor(i / 100) * 50, heading: 0, moving: false });
}
const excluded = new Set<string>();

// Pre-increment #fillDots attribute work: full terrain/colour writes and unconditional uploads.
function baseline() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  return { geometry, sync(groundAt: (x: number, z: number) => number) {
    const colour = new THREE.Color(); let n = 0;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute, colors = geometry.getAttribute('color') as THREE.BufferAttribute;
    for (const [id, position] of positions) {
      if (excluded.has(id) || n >= capacity) continue;
      const visual = visualFor(animals.get(id)!.speciesId);
      pos.setXYZ(n, position.x, groundAt(position.x, position.z) + visual.heightM, position.z);
      colour.setHex(visual.colour); colors.setXYZ(n, colour.r, colour.g, colour.b); n++;
    }
    geometry.setDrawRange(0, n); pos.needsUpdate = true; colors.needsUpdate = true;
  } };
}

function run(kind: 'baseline' | 'incremental', moving: number) {
  const old = baseline(), dots = new AnimalDots(capacity);
  const geometry = kind === 'baseline' ? old.geometry : dots.mesh.geometry;
  let terrainSamples = 0, queuedBytes = 0, cpuMs = 0;
  const groundAt = (x: number, z: number) => { terrainSamples++; return islandHeightAt(1, x, z); };
  const attributes = ['position', 'color'].map((key) => geometry.getAttribute(key) as THREE.BufferAttribute);
  for (let frame = 0; frame < warmupFrames + measuredFrames; frame++) {
    let i = 0;
    for (const position of positions.values()) { position.x = 1500 + i % 100 * 25 + (i < moving ? frame / 60 : 0); i++; }
    if (frame === warmupFrames) terrainSamples = 0;
    const versions = attributes.map((a) => a.version), start = performance.now();
    if (kind === 'baseline') old.sync(groundAt); else dots.sync(animals, positions, excluded, groundAt);
    if (frame >= warmupFrames) {
      cpuMs += performance.now() - start;
      attributes.forEach((a, index) => {
        if (a.version !== versions[index]) queuedBytes += (a.updateRanges.length ? a.updateRanges.reduce((sum, range) => sum + range.count, 0) : a.array.length) * 4;
      });
    }
    // Acknowledge the metadata as the installed WebGLAttributes updater does; no GPU runs here.
    attributes.forEach((a) => a.clearUpdateRanges());
  }
  const snapshot = attributes.map((a) => Array.from(a.array).slice(0, count * 3));
  old.geometry.dispose(); dots.mesh.geometry.dispose(); dots.mesh.material.dispose();
  return { snapshot, result: { kind, movingDots: moving, measuredFrames, terrainSamples,
    queuedAttributeBytes: queuedBytes, totalCpuMs: +cpuMs.toFixed(3), meanCpuMs: +(cpuMs / measuredFrames).toFixed(4) } };
}

const results = [];
for (const moving of [0, 1, count]) {
  const old = run('baseline', moving), next = run('incremental', moving);
  assert.deepEqual(next.snapshot, old.snapshot, 'Final rendered dot buffers must agree exactly');
  results.push(old.result, next.result);
}
console.log(JSON.stringify({ scope: 'Node CPU + queued attribute metadata only; not GPU/browser FPS', count, capacity,
  heightSampler: 'islandHeightAt(seed=1)', node: process.version, platform: `${process.platform}/${process.arch}`, results }, null, 2));
