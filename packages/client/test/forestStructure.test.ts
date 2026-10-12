import { describe, expect, it } from 'vitest';
import { preferenceFor, standAcceptance, standDensity, standSpot, treeAgeScale, valueNoise } from '../src/forestStructure.js';
import { clumpDetailScale, MIN_CLUMP_DETAIL_SCALE, NATURE_KINDS, planVegetation, TREE_DETAIL_DENSITY_CAP,
  type PlacedPlant } from '../src/vegetation.js';
import { coverOpenness, planGroundCover } from '../src/groundCover.js';
import type { PatchView } from '../src/terrain.js';

const patch = (id: number, habitat: string, canopyCover = 0.7): PatchView => ({
  id, x: id % 20, y: Math.floor(id / 20), habitat, grass: 6000, browse: 3000, water: 0, canopyCover, surface: 'land',
});
/** A 3x3 block of closed forest around patch 210 (centre 3000, 3000). */
const block = [189, 190, 191, 209, 210, 211, 229, 230, 231].map((id) => patch(id, 'shola'));
const centre = { x: 3000, z: 3000 };
const flat = () => 0;
const trees = (plan: Map<string, PlacedPlant[]>) =>
  [...plan].filter(([kind]) => kind.includes('Tree')).flatMap(([, items]) => items);
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
/** Clark-Evans ratio: mean nearest-neighbour distance over its expectation for a random pattern
 * of the same density. About 1 for an even random spread, below 1 for clumps. */
function clarkEvans(points: Array<{ x: number; z: number }>, area: number): number {
  const cell = 20, grid = new Map<string, Array<{ x: number; z: number }>>();
  for (const p of points) {
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(p);
  }
  const nearest = points.map((p) => {
    let best = Infinity;
    const cx = Math.floor(p.x / cell), cz = Math.floor(p.z / cell);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      for (const q of grid.get(`${cx + dx},${cz + dz}`) ?? []) if (q !== p) best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z));
    }
    return best;
  });
  return mean(nearest) / (0.5 / Math.sqrt(points.length / area));
}

/** Variance-to-mean ratio of tree counts in 30 m quadrats over the inner 800 m square. */
function dispersion(points: Array<{ x: number; z: number }>): number {
  const counts = new Array(27 * 27).fill(0) as number[];
  for (const p of points) {
    const col = Math.floor((p.x - (centre.x - 405)) / 30), row = Math.floor((p.z - (centre.z - 405)) / 30);
    if (col >= 0 && row >= 0 && col < 27 && row < 27) counts[row * 27 + col]!++;
  }
  const m = mean(counts);
  return mean(counts.map((c) => (c - m) ** 2)) / m;
}

describe('natural stand structure', () => {
  it('is a fixed, smooth 0-1 field with real clearings and real clumps', () => {
    const samples: number[] = [];
    for (let z = -150; z < 5850; z += 37) for (let x = -150; x < 5850; x += 37) samples.push(standDensity(x, z));
    expect(samples.every((v) => v >= 0 && v <= 1)).toBe(true);
    const share = (test: (v: number) => boolean) => samples.filter(test).length / samples.length;
    expect(share((v) => v < 0.15)).toBeGreaterThan(0.1);
    expect(share((v) => v < 0.15)).toBeLessThan(0.4);
    expect(share((v) => v > 0.85)).toBeGreaterThan(0.1);
    expect(share((v) => v > 0.85)).toBeLessThan(0.4);
    // Smooth at the scale of a tree, so a clump has an edge rather than salt-and-pepper noise.
    for (let i = 0; i < 200; i++) {
      const x = 97.3 * i, z = 3000 + Math.sin(i) * 2000;
      expect(Math.abs(standDensity(x, z) - standDensity(x + 1, z))).toBeLessThan(0.1);
    }
    expect(standDensity(1234.5, 678.9)).toBe(standDensity(1234.5, 678.9));
    expect(valueNoise(3.5, -2.25, 7)).toBe(valueNoise(3.5, -2.25, 7));
  });

  it('keeps each patch’s simulated tree count but gathers the trees into clumps', () => {
    const plan = planVegetation(block, centre, 5000, flat, { only: (kind) => kind.includes('Tree') });
    // Exactly the canopy-driven count per kind and patch: placement moves trees, never adds any.
    for (const [kind, perPatch] of [['CommonTree_1', 360], ['CommonTree_2', 340], ['CommonTree_4', 300]] as const) {
      expect(plan.get(kind)!.length).toBe(block.length * perPatch);
    }
    const all = trees(plan);
    const inner = all.filter((t) => Math.abs(t.x - centre.x) < 400 && Math.abs(t.z - centre.z) < 400);
    // Against the same number of evenly random trees: nearest neighbours are closer, and
    // 30 m quadrats vary far more than chance (variance/mean ~1 for an even random spread).
    let seed = 7;
    const random = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed / 4_294_967_296; };
    const even = inner.map(() => ({ x: centre.x + (random() - 0.5) * 800, z: centre.z + (random() - 0.5) * 800 }));
    expect(clarkEvans(even, 800 * 800)).toBeGreaterThan(0.95);
    expect(clarkEvans(inner, 800 * 800)).toBeLessThan(clarkEvans(even, 800 * 800) - 0.08);
    expect(dispersion(even)).toBeLessThan(1.5);
    expect(dispersion(inner)).toBeGreaterThan(3);
    // Trees stand where the pattern is thick; across the same ground it averages ~0.5.
    const ground: number[] = [];
    for (let z = 2550; z < 3450; z += 10) for (let x = 2550; x < 3450; x += 10) ground.push(standDensity(x, z));
    expect(mean(all.map((t) => standDensity(t.x, t.z)))).toBeGreaterThan(mean(ground) + 0.15);
    // Every spot stays inside its own patch.
    for (const [kind, items] of plan) if (kind.includes('Tree')) {
      for (const t of items) expect(Math.abs(t.x - centre.x)).toBeLessThanOrEqual(450);
    }
  });

  it('puts grass in the clearings and ferns and shrubs under and around the clumps', () => {
    const plan = planVegetation(block, centre, 5000, flat);
    const standOf = (kind: string) => mean(plan.get(kind)!.map((p) => standDensity(p.x, p.z)));
    expect(standOf('Grass_Common_Short')).toBeLessThan(standOf('CommonTree_1') - 0.2);
    expect(standOf('Fern_1')).toBeGreaterThan(standOf('Grass_Common_Short') + 0.15);
    expect(preferenceFor('Bush_Common', 'shola')).toBe('edge');
    expect(preferenceFor('Stone_Small', 'shola')).toBe('none');
    // Shrubs favour a clump's edge over both its heart and open clearings.
    expect(standAcceptance('edge', 0.4, 0.7)).toBeGreaterThan(standAcceptance('edge', 0.95, 0.7));
    expect(standAcceptance('edge', 0.4, 0.7)).toBeGreaterThan(standAcceptance('edge', 0.0, 0.7));
    // The grass carpet thins under clumps, thickens in clearings and is untouched off-forest.
    expect(coverOpenness('shola', 0, 0)).toBeGreaterThanOrEqual(0.3);
    expect(coverOpenness('marsh', 10, 10)).toBe(1);
    const tufts = planGroundCover([patch(210, 'shola')], { x: 3000, z: 3000 }, flat);
    const field: number[] = [];
    for (let z = 2860; z < 3140; z += 4) for (let x = 2860; x < 3140; x += 4) {
      if (Math.hypot(x - 3000, z - 3000) < 140) field.push(standDensity(x, z));
    }
    expect(mean(tufts.map((t) => standDensity(t.x, t.z)))).toBeLessThan(mean(field) - 0.05);
  });

  it('rocks keep their original placements: only plants follow the stand pattern', () => {
    let a = 1;
    const random = () => { a = (Math.imul(a, 1_664_525) + 1_013_904_223) >>> 0; return a / 4_294_967_296; };
    let b = 1;
    const legacy = () => { b = (Math.imul(b, 1_664_525) + 1_013_904_223) >>> 0; return b / 4_294_967_296; };
    const spot = standSpot(random, centre, 300, 'none');
    expect(spot.x).toBe(centre.x + (legacy() - 0.5) * 300);
    expect(spot.z).toBe(centre.z + (legacy() - 0.5) * 300);
  });

  it('grows saplings, mature trees and a few emergents, younger in the light gaps', () => {
    const [lo, hi] = NATURE_KINDS.CommonTree_1!.scale;
    const draws = Array.from({ length: 4000 }, (_, i) => (i + 0.5) / 4000);
    for (const stand of [0.1, 0.9]) {
      const ages = draws.map((r) => treeAgeScale(lo, hi, r, stand));
      const share = (age: string) => ages.filter((a) => a.age === age).length / ages.length;
      expect(share('sapling')).toBeGreaterThan(0.15); expect(share('sapling')).toBeLessThan(0.45);
      expect(share('emergent')).toBeGreaterThan(0.02); expect(share('emergent')).toBeLessThan(0.15);
      // One draw maps monotonically to size: a deterministic age from the patch seed.
      for (let i = 1; i < ages.length; i++) expect(ages[i]!.scale).toBeGreaterThanOrEqual(ages[i - 1]!.scale);
    }
    const gap = draws.filter((r) => treeAgeScale(lo, hi, r, 0.05).age === 'sapling').length;
    const clump = draws.filter((r) => treeAgeScale(lo, hi, r, 0.95).age === 'sapling').length;
    expect(gap).toBeGreaterThan(clump * 1.5);
    const sizes = trees(planVegetation(block, centre, 5000, flat, { only: (kind) => kind.includes('Tree') })).map((t) => t.scale);
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeGreaterThan(5);
    // Emergents rise above the old mature ceiling; saplings sit well below the old floor.
    expect(Math.max(...sizes)).toBeGreaterThan(2.7);
    expect(Math.min(...sizes)).toBeLessThan(0.65);
  });

  it('is identical every time, so the forest never reshuffles', () => {
    const one = planVegetation(block, centre, 5000, flat);
    const two = planVegetation([...block].reverse(), { x: 3100, z: 2900 }, 5000, flat);
    for (const [kind, items] of one) {
      const key = (p: PlacedPlant) => `${p.x}:${p.z}:${p.scale}:${p.rotY}`;
      expect(new Set(two.get(kind)!.map(key))).toEqual(new Set(items.map(key)));
    }
  });

  it('caps detailed tree geometry inside a dense clump at the densest even forest', () => {
    const plan = planVegetation(block, centre, 5000, flat, { only: (kind) => kind.includes('Tree') });
    const end = 60, allowed = Math.floor(Math.PI * end * end * TREE_DETAIL_DENSITY_CAP);
    let densest = centre, most = 0;
    for (let z = 2700; z <= 3300; z += 25) for (let x = 2700; x <= 3300; x += 25) {
      const n = trees(plan).filter((t) => Math.hypot(t.x - x, t.z - z) <= end).length;
      if (n > most) { most = n; densest = { x, z }; }
    }
    expect(most).toBeGreaterThan(allowed);
    const scale = clumpDetailScale(plan, densest, end);
    expect(scale).toBeLessThan(1); expect(scale).toBeGreaterThanOrEqual(MIN_CLUMP_DETAIL_SCALE);
    const detailed = trees(plan).filter((t) => Math.hypot(t.x - densest.x, t.z - densest.z) < end * scale).length;
    expect(detailed).toBeLessThanOrEqual(allowed);
    // An open stand keeps the tier's full detail range.
    const sparse = planVegetation([patch(210, 'shola', 0.2)], centre, 5000, flat, { only: (kind) => kind.includes('Tree') });
    expect(clumpDetailScale(sparse, centre, end)).toBe(1);
  });
});
