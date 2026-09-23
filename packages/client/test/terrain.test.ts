import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildTerrain, countDrawCalls, makeHeightSampler, type PatchView } from '../src/terrain.js';

const patches: PatchView[] = Array.from({ length: 400 }, (_, id) => ({
  id, x: id % 20, y: Math.floor(id / 20),
  habitat: ['grassland', 'shola', 'riparian', 'rock', 'marsh', 'water'][id % 6]!,
  grass: 4000, browse: 2000, water: id % 6 === 5 ? 50_000 : 200,
}));

describe('buildTerrain', () => {
  it('renders 400 patches inside the draw-call budget', () => {
    expect(countDrawCalls(buildTerrain(patches))).toBeLessThan(150);
  });

  it('uses instancing rather than one mesh per patch', () => {
    const terrain = buildTerrain(patches);
    let instanced = 0;
    terrain.traverse((o) => {
      if ((o as { isInstancedMesh?: boolean }).isInstancedMesh === true) instanced++;
    });
    expect(instanced).toBeGreaterThan(0);
  });

  it('handles an empty patch list without throwing', () => {
    expect(() => buildTerrain([])).not.toThrow();
  });

  it('is deterministic for the same patches', () => {
    expect(countDrawCalls(buildTerrain(patches))).toBe(countDrawCalls(buildTerrain(patches)));
  });

  it('places water only where the server reported it', () => {
    const dry: PatchView[] = patches.map((p) => ({ ...p, habitat: 'grassland', water: 0 }));
    const terrain = buildTerrain(dry);
    let waterInstances = 0;
    terrain.traverse((o) => {
      if (o.name === 'water') waterInstances = (o as { count?: number }).count ?? 0;
    });
    expect(waterInstances).toBe(0);
  });
});

describe('makeHeightSampler', () => {
  // Hilly ground: each patch at its own elevation.
  const hilly: PatchView[] = patches.map((p) => ({ ...p, elevation: ((p.id * 7919) % 100) / 100 }));

  it('stands animals on the ground that is drawn, not at their patch\'s average height', () => {
    // The sampler used the patch centre's flat height while the mesh interpolates between
    // corners, so on slopes animals stood metres inside the hillside or above it. A gaur was
    // found 2.6 m underground: invisible.
    const terrain = buildTerrain(hilly);
    let ground: THREE.Mesh | undefined;
    terrain.traverse((o) => { if (o.name === 'ground') ground = o as THREE.Mesh; });
    const sample = makeHeightSampler(hilly);
    const ray = new THREE.Raycaster();
    for (const [x, z] of [[10, 20], [455, 1210], [2999, 3001], [5700, 140], [3140, 4466], [0, 0]] as const) {
      ray.set(new THREE.Vector3(x, 1000, z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(ground!)[0]!;
      expect(sample(x, z), `${x},${z}`).toBeCloseTo(hit.point.y, 3);
    }
  });
});
