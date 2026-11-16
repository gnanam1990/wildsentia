import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONGO_GRID, ISLAND_GRID, congoChannelHalfM, congoRivers, patchCentre, riverIndex, treeAnchorForPatch } from '@vana/shared';
import { setWorldGrid } from '../src/worldGrid.js';
import { CONGO_KINDS, buttressFin, congoPartMaterial, congoPlantGeometry, congoPlantParts, planCongoPatch, type CongoKind } from '../src/congoPlants.js';
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
  // A leopard or golden cat climbs at its patch's tree anchor (shared/treeAnchor.ts), 6 m up; the
  // forest stands a real canopy tree there, so a climbing cat is never drawn on thin air.
  it('stands a canopy tree at every climbable patch\'s tree anchor, and none where nothing can climb', () => {
    setWorldGrid(CONGO_GRID);
    for (const habitat of ['terra_firme', 'flooded_forest']) {
      const view = patch(12_880, habitat), anchor = treeAnchorForPatch(CONGO_GRID, view)!;
      expect(anchor, habitat).not.toBeNull();
      const at = planCongoPatch(view, 7).filter((p) => p.kind === 'canopy' && p.x === anchor.x && p.z === anchor.z);
      expect(at, habitat).toHaveLength(1);
      expect(planCongoPatch(view, 7, new Set(['canopy'])).some((p) => p.x === anchor.x && p.z === anchor.z)).toBe(true);
      expect(planCongoPatch(view, 7, new Set(['herb'])).some((p) => p.x === anchor.x && p.z === anchor.z)).toBe(false);
    }
    const open = { ...patch(12_880, 'terra_firme'), canopyCover: 0.1 };
    const anchorless = treeAnchorForPatch(CONGO_GRID, open);
    expect(anchorless).toBeNull();
    expect(planCongoPatch(patch(12_882, 'bai'), 7).filter((p) => p.kind === 'canopy')).toEqual([]);
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
  it('stand the big trees on curved plank buttresses in their own bark, not flat triangles', () => {
    // One fin running out along +x: its top edge sweeps down in a concave curve, it thins toward
    // its tip, it reaches a little into the ground, and its bark is the trunk's, tiled the same.
    const fin = buttressFin(5, 3.4, 0.95, 0xb7a990, () => 0.5), p = fin.getAttribute('position'), uv = fin.getAttribute('uv');
    const top = (x0: number, x1: number) => { let y = -Infinity; for (let i = 0; i < p.count; i++) if (p.getX(i) >= x0 && p.getX(i) <= x1) y = Math.max(y, p.getY(i)); return y; };
    const width = (x0: number, x1: number) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < p.count; i++) if (p.getX(i) >= x0 && p.getX(i) <= x1) { lo = Math.min(lo, p.getZ(i)); hi = Math.max(hi, p.getZ(i)); } return hi - lo; };
    const reach = new THREE.Box3().setFromBufferAttribute(p as THREE.BufferAttribute).max.x;
    expect(reach).toBeGreaterThan(3); expect(reach).toBeLessThan(4.5);
    expect(top(0, 1)).toBeGreaterThan(4);
    // Concave: at half its reach the top is well under half the height (a straight edge is at half).
    expect(top(reach * 0.45, reach * 0.55)).toBeLessThan(5 * 0.35);
    expect(width(0, 1)).toBeGreaterThan(0.25);
    expect(width(reach * 0.85, reach)).toBeLessThan(0.12);
    expect(new THREE.Box3().setFromBufferAttribute(p as THREE.BufferAttribute).min.y).toBeLessThan(0);
    let uvSpan = 0;
    for (let i = 0; i < uv.count; i++) uvSpan = Math.max(uvSpan, uv.getY(i));
    expect(uvSpan).toBeGreaterThan(1.5); // about 5 m of bark at a 2.2 m tile, as on the trunk
    const c = fin.getAttribute('color'), trunkTint = new THREE.Color(0xb7a990).lerp(new THREE.Color(0xffffff), 0.6);
    expect(Math.abs(c.getX(0) - trunkTint.r)).toBeLessThan(0.12);
  });
  it('lay each crown card on one photographed spray of the leaf atlas', () => {
    const uv = congoPlantParts('canopy').leaves!.getAttribute('uv');
    // Each card is two triangles (six vertices), all within one quarter of the 2 x 2 atlas.
    for (let card = 0; card < uv.count; card += 6) {
      let u = 0, v = 0;
      for (let k = card; k < card + 6; k++) { u += uv.getX(k) / 6; v += uv.getY(k) / 6; }
      const u0 = Math.floor(u * 2) / 2, v0 = Math.floor(v * 2) / 2;
      for (let k = card; k < card + 6; k++) {
        expect(uv.getX(k)).toBeGreaterThanOrEqual(u0 - 1e-6); expect(uv.getX(k)).toBeLessThanOrEqual(u0 + 0.5 + 1e-6);
        expect(uv.getY(k)).toBeGreaterThanOrEqual(v0 - 1e-6); expect(uv.getY(k)).toBeLessThanOrEqual(v0 + 0.5 + 1e-6);
      }
    }
  });
  it('hang lianas from the canopy trees down to the forest floor, away from the trunk', () => {
    const p = congoPlantParts('canopy').wood!.getAttribute('position');
    let hanging = 0;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < 1 && Math.hypot(p.getX(i), p.getZ(i)) > 2) hanging++;
    expect(hanging).toBeGreaterThan(0);
  });
  it('dress each kind in its own bark and its own leaf', () => {
    expect(congoPartMaterial('emergent', 'wood')).not.toBe(congoPartMaterial('canopy', 'wood'));
    expect(congoPartMaterial('canopy', 'wood')).toBe(congoPartMaterial('midstory', 'wood'));
    expect(congoPartMaterial('raphia', 'wood')).not.toBe(congoPartMaterial('canopy', 'wood'));
    expect(congoPartMaterial('herb', 'blades')).not.toBe(congoPartMaterial('marantaceae', 'blades'));
    expect(congoPartMaterial('herb', 'blades')).not.toBe(congoPartMaterial('groundcover', 'blades'));
    expect(congoPartMaterial('raphia', 'blades')).not.toBe(congoPartMaterial('marantaceae', 'blades'));
  });
  it('cut each seedling and floor clump from one tile of its 2 x 2 atlas, standing on the ground', () => {
    for (const kind of ['herb', 'groundcover'] as const) {
      const blades = congoPlantParts(kind).blades!, uv = blades.getAttribute('uv'), p = blades.getAttribute('position');
      const tiles = new Set<string>();
      // Each card is two triangles (six vertices): its UVs sit inside one quarter of the atlas.
      for (let c = 0; c < uv.count; c += 6) {
        const us = [0, 1, 2, 3, 4, 5].map((k) => uv.getX(c + k)), vs = [0, 1, 2, 3, 4, 5].map((k) => uv.getY(c + k));
        const col = Math.floor(Math.min(...us) * 2 + 1e-6), row = Math.floor(Math.min(...vs) * 2 + 1e-6);
        expect(Math.max(...us) - col / 2).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(Math.max(...vs) - row / 2).toBeLessThanOrEqual(0.5 + 1e-6);
        tiles.add(`${col},${row}`);
      }
      let lowest = Infinity;
      for (let i = 0; i < p.count; i++) lowest = Math.min(lowest, p.getY(i));
      expect(lowest).toBeCloseTo(0, 5);
      expect(tiles.size).toBeGreaterThan(0);
    }
  });
  it('grow Raphia in clumps, a swamp a thicket of palms', () => {
    const palms = planCongoPatch({ id: 12_881, habitat: 'swamp_forest' }, 7, new Set(['raphia']));
    expect(palms.length).toBeGreaterThan(400);
    // Most palms stand within 8 m of another: clumps, not an orchard's even spacing.
    let close = 0;
    for (const a of palms) if (palms.some((b) => b !== a && Math.hypot(a.x - b.x, a.z - b.z) < 8)) close++;
    expect(close / palms.length).toBeGreaterThan(0.85);
  });
});
