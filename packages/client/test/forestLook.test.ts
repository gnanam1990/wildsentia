import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CANOPY_LIGHT_BUDGET, CanopyLight, cellHash, shaftCells, shaftStrength } from '../src/canopyLight.js';
import { GRADE, postFxFor } from '../src/postFx.js';
import { ContactShadows } from '../src/contactShadows.js';

describe('canopy light', () => {
  it('shows only by day and only among the trees', () => {
    expect(shaftStrength(0, 1)).toBe(0);
    expect(shaftStrength(1, 0)).toBe(0);
    expect(shaftStrength(1, 1)).toBe(1);
    expect(shaftStrength(0.5, 1)).toBeGreaterThan(0);
  });

  it('keeps its shafts standing where they are as the eye moves a little', () => {
    const a = shaftCells(1000, 2000, 9), b = shaftCells(1001.5, 2000.5, 9);
    expect(a.length).toBe(9);
    const key = (c: { x: number; z: number }) => `${c.x.toFixed(3)},${c.z.toFixed(3)}`;
    const shared = a.filter((c) => b.some((d) => key(c) === key(d)));
    expect(shared.length).toBeGreaterThanOrEqual(7);
  });

  it('draws shafts in a ring round the eye, never on top of it', () => {
    for (const c of shaftCells(-300, 740, 14)) {
      const d = Math.hypot(c.x + 300, c.z - 740);
      expect(d).toBeGreaterThanOrEqual(6);
      expect(d).toBeLessThanOrEqual(48);
    }
    expect(shaftCells(0, 0, 0)).toEqual([]);
  });

  it('hashes ground cells to a stable 0..1 value', () => {
    expect(cellHash(3, -7, 1)).toBe(cellHash(3, -7, 1));
    for (let i = 0; i < 200; i++) { const h = cellHash(i, i * 3 - 50, 2); expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThan(1); }
  });

  it('draws nothing on smooth graphics and hides from above the canopy', () => {
    expect(CANOPY_LIGHT_BUDGET.smooth).toEqual({ shafts: 0, motes: 0 });
    const light = new CanopyLight();
    light.setTier('smooth');
    light.update(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), new THREE.Color(1, 1, 1), 1, 1, 0, false, 800, () => 0);
    expect(light.root.visible).toBe(false);
    light.setTier('high');
    light.update(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), new THREE.Color(1, 1, 1), 1, 0, 0, false, 800, () => 0);
    expect(light.root.visible).toBe(false);
    light.update(new THREE.Vector3(), new THREE.Vector3(0.3, 0.8, 0.2), new THREE.Color(1, 1, 1), 1, 1, 0, false, 800, () => 0);
    expect(light.root.visible).toBe(true);
    light.dispose();
  });
});

describe('finishing pass', () => {
  it('runs the grade on balanced and high graphics, the bloom on high only, nothing on smooth', () => {
    expect(postFxFor('smooth')).toEqual({ bloom: false, grade: false });
    expect(postFxFor('balanced')).toEqual({ bloom: false, grade: true });
    expect(postFxFor('high')).toEqual({ bloom: true, grade: true });
  });

  it('keeps the grade gentle: the forest stays bright', () => {
    expect(GRADE.lift).toBeGreaterThan(0);
    expect(GRADE.contrast).toBeLessThanOrEqual(0.12);
    expect(GRADE.vignette).toBeLessThanOrEqual(0.2);
  });
});

describe('contact shadows', () => {
  it('lays one patch per standing animal, up to its capacity, and is never tapped', () => {
    const shadows = new ContactShadows(2);
    shadows.update([{ x: 0, y: 1, z: 0, lengthM: 1, heading: 0 }]);
    expect(shadows.mesh.count).toBe(1);
    const m = new THREE.Matrix4(); shadows.mesh.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).y).toBeCloseTo(1.02);
    shadows.update(Array.from({ length: 5 }, (_, i) => ({ x: i, y: 0, z: 0, lengthM: 1, heading: 0 })));
    expect(shadows.mesh.count).toBe(2);
    const hits: THREE.Intersection[] = [];
    shadows.mesh.raycast(new THREE.Raycaster(), hits);
    expect(hits).toEqual([]);
    shadows.dispose();
  });
});
