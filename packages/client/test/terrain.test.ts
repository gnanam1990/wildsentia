import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { waterAccessPosition, waterContactPosition } from '@vana/shared';
import { buildTerrain, countDrawCalls, hideFarFieldNear, makeHeightSampler, poolMatrix, type PatchView } from '../src/terrain.js';
import { insidePool, islandPool } from '../src/pools.js';
import { ISLAND_GRID } from '@vana/shared';

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

  it('shows a small island freshwater pool at every drinkable access point', () => {
    const wet = { ...patches[210]!, habitat: 'shola', surface: 'land' as const,
      islandSeed: 1, water: 200 };
    const dry = { ...patches[211]!, surface: 'land' as const, islandSeed: 1, water: 0 };
    const terrain = buildTerrain([wet, dry]);
    const water = terrain.getObjectByName('water')!;
    expect(water.userData.pools).toBe(1);
    for (const part of ['water-surface', 'water-bank', 'water-reeds']) expect(water.getObjectByName(part)).toBeTruthy();
    const pool = islandPool(wet)!, access = waterAccessPosition(ISLAND_GRID, wet.id);
    expect(pool.x).toBeCloseTo(access.x); expect(pool.z).toBeCloseTo(access.z); expect(pool.radius).toBeCloseTo(2);
    // Every animal's drinking spot is in the water, even at the smallest (2 m) pool.
    for (const species of ['elephant_1', 'chital_7', 'tiger_3', 'hare_99']) {
      const contact = waterContactPosition(ISLAND_GRID, species, wet.id);
      expect(insidePool(pool, contact.x, contact.z)).toBe(true);
    }
  });

  it('lays an island pool on a hillside instead of burying its uphill side', () => {
    const slope = (x: number, z: number) => 0.25 * x - 0.1 * z + 0.02 * Math.sin(x);
    const pool = { x: 40, z: -12, radius: 9 }, matrix = poolMatrix(pool, slope);
    for (let k = 0; k < 24; k++) {
      const a = k / 24 * Math.PI * 2;
      for (const f of [0.5, 1]) {
        const rim = new THREE.Vector3(Math.cos(a) * f, 0, Math.sin(a) * f).applyMatrix4(matrix);
        expect(rim.y).toBeGreaterThanOrEqual(slope(rim.x, rim.z));
        expect(rim.y - slope(rim.x, rim.z)).toBeLessThan(0.2);
      }
    }
  });

  it('renders authoritative drainage as a river and steep drop as a waterfall', () => {
    const hydrology = patches.map((p) => ({ ...p, elevation: p.id === 0 ? 0.9 : p.id === 1 ? 0.1 : 0.5,
      drainage: p.id === 0 ? { downstreamPatchId: 1, boundaryOutlet: false, inflowL: 0, outflowL: 20_000, hours: 1 } : undefined }));
    const terrain = buildTerrain(hydrology);
    const river = terrain.getObjectByName('river') as THREE.Mesh;
    const waterfall = terrain.getObjectByName('waterfall') as THREE.Mesh;
    expect(river).toBeDefined();
    expect(river.geometry.index!.count).toBe(6);
    expect(waterfall).toBeDefined();
    expect(waterfall.geometry.index!.count).toBe(6);
  });

  it('does not invent a river when a checkpoint has no completed drainage step', () => {
    const terrain = buildTerrain(patches);
    expect(terrain.getObjectByName('river')).toBeUndefined();
    expect(terrain.getObjectByName('waterfall')).toBeUndefined();
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

describe('hideFarFieldNear', () => {
  it('stops submitting placeholder trees once the matching atlas forest is ready', () => {
    const terrain = buildTerrain([{ ...patches[0]!, habitat: 'shola', canopyCover: 0.8 }]);
    hideFarFieldNear(terrain, { x: 0, z: 0 }, 220, Infinity, 132);
    expect(terrain.getObjectByName('trunk')!.visible).toBe(false);
    expect(terrain.getObjectByName('canopy')!.visible).toBe(false);
    expect(terrain.getObjectByName('grass')!.visible).toBe(true);
    hideFarFieldNear(terrain, { x: 1000, z: 1000 }, 220, 110, 132);
    expect(terrain.getObjectByName('trunk')!.visible).toBe(true);
    const matrix = new THREE.Matrix4();
    (terrain.getObjectByName('trunk') as THREE.InstancedMesh).getMatrixAt(0, matrix);
    expect(matrix.elements[0]).toBeGreaterThan(0);
  });
  it('keeps distant grass in the belt beyond the carpet, independently of props', () => {
    const terrain = buildTerrain(patches);
    const grass = terrain.getObjectByName('grass') as THREE.InstancedMesh;
    const base = grass.userData.base as Float32Array;
    const focus = { x: 3000, z: 3000 };
    hideFarFieldNear(terrain, focus, 220, 110, 132);
    let belt = 0;
    for (let i = 0; i < grass.count; i++) {
      const offset = i * 16;
      const distance = Math.hypot(base[offset + 12]! - focus.x, base[offset + 14]! - focus.z);
      if (distance > 144 && distance < 220) {
        belt++;
        expect(grass.instanceMatrix.array[offset]).toBe(base[offset]);
      }
    }
    expect(belt).toBeGreaterThan(0);
  });
  it('never shows far grass in flooded or water habitats', () => {
    for (const extra of [{ habitat: 'water' }, { water: 30_000 }, { grass: 0 }]) {
      const terrain = buildTerrain([{ ...patches[0]!, ...extra }]);
      expect((terrain.getObjectByName('grass') as THREE.InstancedMesh).count).toBe(0);
    }
  });
  it('hides the cheap stand-in vegetation where detailed plants are drawn, and brings it back', () => {
    const terrain = buildTerrain(patches);
    const grass = terrain.getObjectByName('grass') as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    const scaleAt = (i: number) => { grass.getMatrixAt(i, m); return new THREE.Vector3().setFromMatrixScale(m).y; };
    const near = Array.from({ length: grass.count }, (_, i) => {
      grass.getMatrixAt(i, m);
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      return Math.hypot(p.x - 3000, p.z - 3000) <= 450;
    });
    expect(near.some(Boolean)).toBe(true);
    expect(near.some((n) => !n)).toBe(true);

    hideFarFieldNear(terrain, { x: 3000, z: 3000 }, 450);
    near.forEach((isNear, i) => {
      if (isNear) expect(scaleAt(i)).toBe(0);
      else expect(scaleAt(i)).toBeGreaterThan(0);
    });

    hideFarFieldNear(terrain, { x: -5000, z: -5000 }, 450);
    near.forEach((_, i) => expect(scaleAt(i)).toBeGreaterThan(0));
  });
});
