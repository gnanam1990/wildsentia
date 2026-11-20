import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addCongoDeciduous, addSeasonalLeaves, CONGO_DECIDUOUS_SHARE, congoSeasonalDryness, seasonalDryness } from '../src/seasonalLeaves.js';

// the environment realism pass of 5 October 2026, Limits: ground litter followed the season but canopies
// never thinned. The island is a monsoon forest; its deciduous trees (teak, sal) drop much of
// their leaf in the dry season and green again with the rains.
describe('seasonal leaves', () => {
  it('is driest in the dry season and fully leafed in the monsoon', () => {
    expect(seasonalDryness('monsoon')).toBe(0);
    expect(seasonalDryness('wet')).toBeLessThan(seasonalDryness('transition'));
    expect(seasonalDryness('transition')).toBeLessThan(seasonalDryness('dry'));
    expect(seasonalDryness('dry')).toBeLessThanOrEqual(1);
    expect(seasonalDryness('unknown season')).toBe(0);
  });
  it('tints only green pixels and thins only leaf cards, from one shared uniform, with its own program key', () => {
    const dryness = { value: 0.8 };
    const leaf = new THREE.MeshStandardMaterial(), atlas = new THREE.MeshStandardMaterial();
    const keyBefore = leaf.customProgramCacheKey();
    addSeasonalLeaves(leaf, dryness, true);
    addSeasonalLeaves(atlas, dryness, false);
    expect(leaf.customProgramCacheKey()).not.toBe(keyBefore);
    expect(leaf.customProgramCacheKey()).not.toBe(atlas.customProgramCacheKey());
    const shader = { uniforms: {} as Record<string, { value: unknown }>, fragmentShader: '#include <map_fragment>\n#include <alphatest_fragment>', vertexShader: '' };
    leaf.onBeforeCompile(shader as never, {} as never);
    expect(shader.uniforms.uSeasonDry).toBe(dryness);
    expect(shader.fragmentShader).toContain('uSeasonDry');
    expect(shader.fragmentShader).toContain('discard');
    const flat = { uniforms: {} as Record<string, { value: unknown }>, fragmentShader: '#include <map_fragment>\n#include <alphatest_fragment>', vertexShader: '' };
    atlas.onBeforeCompile(flat as never, {} as never);
    expect(flat.fragmentShader).toContain('uSeasonDry');
    expect(flat.fragmentShader).not.toContain('discard');
  });
});

// The Congo forest is semi-evergreen: only its deciduous share of crowns (ayous, limba, kapok)
// turns and sheds in the two drier spells, each crown whole, not the whole canopy evenly.
describe('Congo deciduous crowns', () => {
  it('turns only in the drier spells', () => {
    expect(congoSeasonalDryness('monsoon')).toBe(0);
    expect(congoSeasonalDryness('wet')).toBe(0);
    expect(congoSeasonalDryness('transition')).toBeGreaterThan(0.5);
    expect(CONGO_DECIDUOUS_SHARE).toBeGreaterThan(0.1);
    expect(CONGO_DECIDUOUS_SHARE).toBeLessThan(0.5);
  });
  it('picks crowns per instance, and drops leaf by place on the leaf, not by screen pixel', () => {
    const dryness = { value: 0.8 };
    const leaves = new THREE.MeshStandardMaterial();
    addCongoDeciduous(leaves, dryness, 'leaves');
    const shader = { uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <begin_vertex>\n#include <project_vertex>', fragmentShader: '#include <color_fragment>\n#include <alphatest_fragment>' };
    leaves.onBeforeCompile(shader as never, {} as never);
    expect(shader.uniforms.uSeasonDry).toBe(dryness);
    expect(shader.vertexShader).toContain('instanceMatrix');
    expect(shader.fragmentShader).toContain('discard');
    expect(shader.fragmentShader).not.toContain('gl_FragCoord');
    const depth = new THREE.MeshDepthMaterial();
    addCongoDeciduous(depth, dryness, 'depth');
    expect(depth.customProgramCacheKey()).not.toBe(leaves.customProgramCacheKey());
    const shadow = { uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <begin_vertex>\n#include <project_vertex>', fragmentShader: '#include <map_fragment>\n#include <alphatest_fragment>' };
    depth.onBeforeCompile(shadow as never, {} as never);
    expect(shadow.fragmentShader).toContain('discard');
  });
});
