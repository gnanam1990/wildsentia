import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addTreeDetailFade, treeAtlasView, treeDetailWeight, treeFadeRangeFor, treeImpostorMaterial, TREE_FADE_END_M, TREE_PLAN_MARGIN_M } from '../src/treeLod.js';
import { planVegetation, nearPlan, TREE_DETAIL_RADIUS_M } from '../src/vegetation.js';
import type { PatchView } from '../src/terrain.js';

describe('continuous forest detail', () => {
  it('keeps near and distant trees at identical coordinates, scale and rotation', () => {
    const patches: PatchView[] = Array.from({ length: 9 }, (_, n) => ({
      id: Math.floor(n / 3) * 20 + n % 3, x: n % 3, y: Math.floor(n / 3), habitat: 'shola',
      grass: 1000, browse: 3000, water: 0, canopyCover: 0.8,
    }));
    const whole = planVegetation(patches, { x: 300, z: 300 }, 2000, (x, z) => (x + z) / 100, { only: (k) => k.includes('Tree') });
    for (const focus of [{ x: 300, z: 300 }, { x: 399, z: 350 }]) {
      for (const [kind, plants] of nearPlan(patches, focus, (x, z) => (x + z) / 100)) {
        if (!kind.includes('Tree')) continue;
        const identities = new Set(whole.get(kind)!.map((p) => JSON.stringify(p)));
        expect(plants.length).toBeGreaterThan(0);
        expect(plants.every((p) => identities.has(JSON.stringify(p)))).toBe(true);
      }
    }
  });
  it('has complementary, smooth weights and a plan margin larger than its 20 m update step', () => {
    expect(treeDetailWeight(0)).toBe(1); expect(treeDetailWeight(50)).toBe(1);
    expect(treeDetailWeight(65)).toBeCloseTo(0.5); expect(treeDetailWeight(80)).toBe(0);
    expect(treeDetailWeight(2000)).toBe(0);
    expect(TREE_DETAIL_RADIUS_M).toBe(TREE_FADE_END_M + TREE_PLAN_MARGIN_M);
    expect(TREE_PLAN_MARGIN_M).toBeGreaterThan(20);
    for (let d = 50; d < 80; d++) expect(treeDetailWeight(d + 1)).toBeLessThan(treeDetailWeight(d));
  });
  it('moves lower-quality geometry to the same atlas earlier without changing forest placement', () => {
    const smooth = treeFadeRangeFor('smooth'), balanced = treeFadeRangeFor('balanced'), high = treeFadeRangeFor('high');
    expect(smooth.toArray()).toEqual([24, 42]);
    expect(balanced.toArray()).toEqual([35, 60]);
    expect(high.toArray()).toEqual([50, 80]);
    expect(smooth.y).toBeGreaterThan(36); // Full-to-half leaf transition finishes first.
    expect(smooth.y).toBeLessThan(balanced.y);
    expect(balanced.y).toBeLessThan(high.y);
    const patch: PatchView = { id: 0, x: 0, y: 0, habitat: 'shola', grass: 1000, browse: 3000, water: 0, canopyCover: 0.8 };
    const focus = { x: 0, z: 0 }, ground = () => 0;
    const highPlan = nearPlan([patch], focus, ground, high.y + TREE_PLAN_MARGIN_M);
    const smoothPlan = nearPlan([patch], focus, ground, smooth.y + TREE_PLAN_MARGIN_M);
    for (const [kind, plants] of smoothPlan) {
      if (!kind.includes('Tree')) {
        expect(plants).toEqual(highPlan.get(kind));
        continue;
      }
      const highIds = new Set(highPlan.get(kind)!.map(plant => JSON.stringify(plant)));
      expect(plants.every(plant => highIds.has(JSON.stringify(plant)))).toBe(true);
      expect(plants.every(plant => Math.hypot(plant.x, plant.z) <= smooth.y + TREE_PLAN_MARGIN_M)).toBe(true);
      expect(plants.length).toBeLessThan(highPlan.get(kind)!.length);
    }
  });
  it('wraps view indices and supports horizontal, diagonal and overhead cameras', () => {
    expect(treeAtlasView(0, 0)).toEqual({ column: 0, row: 0 });
    expect(treeAtlasView(Math.PI / 2, Math.PI / 4)).toEqual({ column: 2, row: 1 });
    expect(treeAtlasView(-Math.PI / 4, Math.PI / 2)).toEqual({ column: 7, row: 2 });
    expect(treeAtlasView(Math.PI * 2, 2)).toEqual({ column: 0, row: 2 });
  });
  it('composes the evergreen shader and uses depth-writing complementary discard', () => {
    const near = new THREE.MeshStandardMaterial();
    near.onBeforeCompile = (shader) => { shader.fragmentShader += '\n// evergreen'; };
    const range = { value: treeFadeRangeFor('balanced') };
    addTreeDetailFade(near, { value: new THREE.Vector3() }, range);
    const compile = (material: THREE.Material) => {
      const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>\n#include <project_vertex>',
        fragmentShader: '#include <map_fragment>\n#include <alphatest_fragment>' };
      material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
      return shader;
    };
    expect(compile(near).fragmentShader).toContain('// evergreen');
    expect(compile(near).fragmentShader).toContain('screenNoise >= detail');
    expect((compile(near).uniforms as Record<string, unknown>).treeFadeRange).toBe(range);
    const target = new THREE.WebGLRenderTarget(1, 1);
    const far = treeImpostorMaterial({ target, centre: new THREE.Vector3(), diameter: 12 }, range);
    expect(compile(far).fragmentShader).toContain('screenNoise < detail');
    expect((compile(far).uniforms as Record<string, unknown>).treeFadeRange).toBe(range);
    expect(compile(far).vertexShader).toContain('viewMatrix * treeWorld');
    expect(far.transparent).toBe(false); expect(far.depthWrite).toBe(true);
    target.dispose(); far.dispose(); near.dispose();
  });
});
