import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { treeAnchorForPatch, treeAnchorGeometry } from '@vana/shared';
import { buildTerrain, makeHeightSampler, type PatchView } from '../src/terrain.js';
import { planVegetation, TreePlacementCache } from '../src/vegetation.js';
import { disposeTerrain } from '../src/environment.js';

const patch: PatchView = { id: 210, x: 10, y: 10, habitat: 'shola', grass: 1000, browse: 3000,
  water: 200, canopyCover: .8, elevation: .5, islandSeed: 1, surface: 'land' };
const onlyTrees = (kind: string) => kind.includes('Tree');
const instanceAt = (mesh: THREE.InstancedMesh, index: number): THREE.Vector3 => {
  const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
};

describe('exact visible trunk for a shared tree anchor', () => {
  it('places a near GLB and first far trunk on the same authoritative x/z without increasing live tree count', () => {
    const anchor = treeAnchorForPatch(patch)!;
    const ground = makeHeightSampler([patch]);
    const plan = planVegetation([patch], { x: anchor.x, z: anchor.z }, 4500, ground, { only: onlyTrees });
    const live = plan.get(anchor.visualKind)!;
    expect(live).toHaveLength(Math.round(360 * Math.min(1.3, .8 / .7)));
    expect(live[0]).toMatchObject({ x: anchor.x, z: anchor.z, scale: anchor.visualScale });
    expect(live[0]!.y).toBeLessThanOrEqual(ground(anchor.x, anchor.z));
    const root = buildTerrain([patch], new Set(['trunk', 'canopy']));
    const trunk = root.getObjectByName('trunk') as THREE.InstancedMesh;
    expect(trunk.count).toBe(300);
    // Instanced matrices are float32; world coordinates near 3 km round by ~0.1 mm.
    expect(instanceAt(trunk, 0).x).toBeCloseTo(anchor.x, 2);
    expect(instanceAt(trunk, 0).z).toBeCloseTo(anchor.z, 2);
    disposeTerrain(root);
  });

  it('retains one visible, non-climbable remnant at the same x/z after canopy loss', () => {
    const depleted = { ...patch, canopyCover: 0 };
    const geometry = treeAnchorGeometry(patch.id)!;
    expect(treeAnchorForPatch(depleted)).toBeNull();
    const ground = makeHeightSampler([depleted]);
    const plan = new TreePlacementCache().get([depleted], ground);
    expect(plan.get('CommonTree_1')).toHaveLength(0);
    expect(plan.get('DeadTree_2')).toEqual([{ x: geometry.x, z: geometry.z,
      y: ground(geometry.x, geometry.z), rotY: 0, scale: 1.8 }]);
    const root = buildTerrain([depleted], new Set(['trunk', 'canopy']));
    const trunk = root.getObjectByName('trunk') as THREE.InstancedMesh;
    const canopy = root.getObjectByName('canopy') as THREE.InstancedMesh;
    expect(trunk.count).toBe(1);
    expect(canopy.count).toBe(0); // Bare remnant, not a leafy tree in a canopy-free patch.
    expect(instanceAt(trunk, 0).x).toBeCloseTo(geometry.x, 2);
    expect(instanceAt(trunk, 0).z).toBeCloseTo(geometry.z, 2);
    disposeTerrain(root);
  });

  it('never renders an anchor remnant in coast or ocean', () => {
    for (const surface of ['coast', 'ocean'] as const) {
      const source = { ...patch, surface, canopyCover: 0 };
      const ground = makeHeightSampler([source]);
      expect(new TreePlacementCache().get([source], ground).get('DeadTree_2')).toBeUndefined();
      const root = buildTerrain([source], new Set(['trunk', 'canopy']));
      expect((root.getObjectByName('trunk') as THREE.InstancedMesh).count).toBe(0);
      disposeTerrain(root);
    }
  });
});
