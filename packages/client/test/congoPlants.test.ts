import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONGO_GRID, ISLAND_GRID, congoChannelHalfM, congoRivers, patchCentre, riverIndex } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { CONGO_KINDS, congoPlantGeometry, planCongoPatch, type CongoKind } from '../src/congoPlants.js';
import type { PatchView } from '../src/terrain.js';

afterEach(() => setWorldGrid(ISLAND_GRID));
const patch = (id: number, habitat: string): PatchView => ({ id, x: id % 160, y: Math.floor(id / 160), habitat, elevation: 0.4,
  canopyCover: 0.9, grass: 800, browse: 4000, water: 300, congoSeed: 7, surface: 'land' } as PatchView);
const kinds = (id: number, habitat: string) => new Set(planCongoPatch(patch(id, habitat), 7).map((p) => p.kind));

// Congo 1A.5: what grows where, after a Congo forest; the same patch always grows the same plants.
describe('Congo plants', () => {
  it('grow the same in a patch every time, each inside its patch', () => {
    setWorldGrid(CONGO_GRID);
    const a = planCongoPatch(patch(12_880, 'terra_firme'), 7), b = planCongoPatch(patch(12_880, 'terra_firme'), 7);
    expect(a).toEqual(b);
    const c = patchCentre(CONGO_GRID, 12_880);
    for (const p of a) { expect(Math.abs(p.x - c.x)).toBeLessThanOrEqual(150); expect(Math.abs(p.z - c.z)).toBeLessThanOrEqual(150); }
  });
  it('make terra firme a layered forest, swamps Raphia palms, and bais open sedge', () => {
    setWorldGrid(CONGO_GRID);
    const forest = kinds(12_880, 'terra_firme');
    for (const k of ['emergent', 'canopy', 'midstory', 'marantaceae', 'sapling'] as CongoKind[]) expect(forest.has(k)).toBe(true);
    expect(forest.has('sedge')).toBe(false);
    expect(kinds(12_881, 'swamp_forest').has('raphia')).toBe(true);
    const bai = kinds(12_882, 'bai');
    expect(bai.has('sedge')).toBe(true);
    for (const k of ['emergent', 'canopy', 'marantaceae'] as CongoKind[]) expect(bai.has(k)).toBe(false);
    // Mid-river grows nothing; a river patch's dry edge grows like the flooded forest beside it.
    const main = congoRivers(7, CONGO_GRID)[0]!, mid = main.points[Math.floor(main.points.length / 2)]!;
    const midRiver = Math.round((mid.z + 150) / 300 - 0.5) * 160 + Math.round((mid.x + 150) / 300 - 0.5);
    expect(planCongoPatch(patch(midRiver, 'water'), 7)).toEqual([]);
  });
  it('never plant in a river channel', () => {
    setWorldGrid(CONGO_GRID);
    const rivers = congoRivers(7, CONGO_GRID), near = riverIndex(rivers), main = rivers[0]!;
    const mid = main.points[Math.floor(main.points.length / 2)]!;
    // The flooded-forest patches along the main river's bank.
    const ids: number[] = [];
    for (let dz = -1500; dz <= 1500; dz += 300) {
      const col = Math.round(mid.x / 300), row = Math.round((mid.z + dz) / 300);
      ids.push(row * 160 + col);
    }
    for (const id of ids) for (const p of planCongoPatch(patch(id, 'flooded_forest'), 7)) {
      const at = near(p.x, p.z);
      expect(at.distanceM).toBeGreaterThan(congoChannelHalfM(at.river, CONGO_GRID));
    }
  });
  it('plant the dry edge of a river patch, as the flooded forest beside it', () => {
    setWorldGrid(CONGO_GRID);
    const rivers = congoRivers(7, CONGO_GRID), near = riverIndex(rivers), main = rivers[0]!;
    const mid = main.points[Math.floor(main.points.length / 2)]!;
    // Walk out from mid-river to the first patch whose centre is still in the channel but whose edge is not.
    let edge = -1;
    for (let dz = 0; dz < 1200 && edge < 0; dz += 50) {
      const x = mid.x, z = mid.z + dz, at = near(x, z), half = congoChannelHalfM(at.river, CONGO_GRID);
      const col = Math.floor((x + 150) / 300), row = Math.floor((z + 150) / 300), c = patchCentre(CONGO_GRID, row * 160 + col);
      if (near(c.x, c.z).distanceM <= half && near(c.x, c.z + 150).distanceM > half + 30) edge = row * 160 + col;
    }
    expect(edge).toBeGreaterThanOrEqual(0);
    expect(planCongoPatch(patch(edge, 'water'), 7).filter((p) => p.kind === 'canopy').length).toBeGreaterThan(0);
  });
  it('plan one kind alone exactly as it stands in the whole plan', () => {
    setWorldGrid(CONGO_GRID);
    const whole = planCongoPatch(patch(12_880, 'terra_firme'), 7);
    const trees = planCongoPatch(patch(12_880, 'terra_firme'), 7, new Set(['canopy', 'emergent'] as CongoKind[]));
    expect(trees).toEqual(whole.filter((p) => p.kind === 'canopy' || p.kind === 'emergent'));
  });
  it('build tall buttressed emergents, Raphia fronds and broad-leaved understory', () => {
    const box = (k: CongoKind) => new THREE.Box3().setFromBufferAttribute(congoPlantGeometry(k).getAttribute('position') as THREE.BufferAttribute);
    expect(box('emergent').max.y).toBeGreaterThan(40);
    expect(box('canopy').max.y).toBeGreaterThan(25); expect(box('canopy').max.y).toBeLessThan(40);
    expect(box('raphia').max.x - box('raphia').min.x).toBeGreaterThan(12);
    expect(box('marantaceae').max.y).toBeLessThan(3.5);
    for (const k of CONGO_KINDS) expect(congoPlantGeometry(k).getAttribute('color')).toBeDefined();
  });
});
