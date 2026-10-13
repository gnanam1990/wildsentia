import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONGO_GRID, ISLAND_GRID } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { buildTerrain, type PatchView } from '../src/terrain.js';
import { groundLayers, patchGroundColours } from '../src/groundTint.js';

afterEach(() => setWorldGrid(ISLAND_GRID));
const patch = (id: number, habitat: string, extra: Partial<PatchView> = {}): PatchView => ({ id, x: id % 160, y: Math.floor(id / 160),
  habitat, elevation: 0.4, canopyCover: habitat === 'bai' ? 0.05 : 0.9, grass: habitat === 'bai' ? 8000 : 800, browse: 4000,
  water: 300, congoSeed: 7, surface: 'land', ...extra } as PatchView);
const hsl = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 });

// Congo 1A.5: a rainforest floor is dark leaf litter on red-brown soil, not grass; a bai is green and open.
describe('the Congo floor', () => {
  it('is litter brown under the forest and sedge green in a bai', () => {
    const forest = patchGroundColours(patch(12_880, 'terra_firme'), 'monsoon');
    const bai = patchGroundColours(patch(12_881, 'bai'), 'monsoon');
    for (const c of [forest.near, forest.far]) {
      const { h } = hsl(c);
      expect(h).toBeGreaterThan(0.02); expect(h).toBeLessThan(0.14); // brown: red-orange hues
    }
    expect(hsl(bai.far).h).toBeGreaterThan(0.14); // greener than the forest floor
    expect(groundLayers(patch(12_880, 'terra_firme'), 'monsoon').litter).toBeGreaterThanOrEqual(0.8);
  });
  it('carries none of the island tufts, rocks, fallback trees or square water', () => {
    setWorldGrid(CONGO_GRID);
    const patches = [patch(12_880, 'terra_firme'), patch(12_881, 'water', { deepWater: true }), patch(12_882, 'flooded_forest', { flooded: true }), patch(12_883, 'bai')];
    const root = buildTerrain(patches);
    for (const name of ['grass', 'rock', 'trunk', 'canopy', 'water']) {
      const layer = root.getObjectByName(name) as THREE.InstancedMesh | undefined;
      expect(layer?.count ?? 0).toBe(0);
    }
    expect(root.getObjectByName('ground')).toBeDefined();
  });
});
