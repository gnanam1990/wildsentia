import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addLeafLodFade, alternateLeafCards, LEAF_LOD_END_M, LEAF_LOD_START_M } from '../src/leafLod.js';
import { addTreeDetailFade } from '../src/treeLod.js';

function cards(count: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
  const indices = new Uint32Array(count * 6);
  for (let card = 0; card < count; card++) indices.set([
    card * 4, card * 4 + 1, card * 4 + 2, card * 4 + 2, card * 4 + 1, card * 4 + 3,
  ], card * 6);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

describe('middle-distance leaf-card LOD', () => {
  it('halves independent cards while preserving source attributes and parent geometry', () => {
    const full = cards(16);
    const middle = alternateLeafCards(full)!;
    expect(middle.getIndex()?.count).toBe(full.getIndex()!.count / 2);
    expect(middle.getAttribute('position')).toBe(full.getAttribute('position'));
    expect(Array.from(middle.getIndex()!.array)).toEqual([
      ...Array.from(full.getIndex()!.array.slice(0, 6)),
      ...Array.from(full.getIndex()!.array.slice(12, 18)),
      ...Array.from(full.getIndex()!.array.slice(24, 30)),
      ...Array.from(full.getIndex()!.array.slice(36, 42)),
      ...Array.from(full.getIndex()!.array.slice(48, 54)),
      ...Array.from(full.getIndex()!.array.slice(60, 66)),
      ...Array.from(full.getIndex()!.array.slice(72, 78)),
      ...Array.from(full.getIndex()!.array.slice(84, 90)),
    ]);
    expect(full.getIndex()?.count).toBe(96);
    middle.dispose(); full.dispose();
  });

  it('rejects unknown topology instead of dropping arbitrary triangles', () => {
    const full = cards(16);
    full.getIndex()!.setX(3, 9);
    expect(alternateLeafCards(full)).toBeNull();
    full.dispose();
  });

  it('uses complementary screen-door fades between full and middle foliage', () => {
    expect(LEAF_LOD_START_M).toBeLessThan(LEAF_LOD_END_M);
    const compile = (level: 'full' | 'middle') => {
      const material = new THREE.MeshStandardMaterial();
      addTreeDetailFade(material, { value: new THREE.Vector3() });
      addLeafLodFade(material, level);
      const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>',
        fragmentShader: '#include <alphatest_fragment>' };
      material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
      const result = shader.fragmentShader;
      expect(result).toContain('vTreeDistance');
      expect(result).toContain('screenNoise >= detail');
      material.dispose(); return result;
    };
    expect(compile('full')).toContain('leafNoise < leafBlend');
    expect(compile('middle')).toContain('leafNoise >= leafBlend');
  });
});
