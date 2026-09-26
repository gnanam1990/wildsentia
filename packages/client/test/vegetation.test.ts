import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { canopyField, NATURE_KINDS, TREE_DETAIL_RADIUS_M, TREE_ROOT_SEATING, ROCK_SEATING, vegetationGroundHeight, natureScale, nearPlan, planVegetation, flattenedNatureGeometry } from '../src/vegetation.js';
import type { PatchView } from '../src/terrain.js';

const patch = (id: number, habitat: string, extra: Partial<PatchView> = {}): PatchView => ({
  id, x: id % 20, y: Math.floor(id / 20), habitat, grass: 6000, browse: 3000, water: 0,
  canopyCover: habitat === 'shola' ? 0.8 : 0.1, ...extra,
});
const flat = () => 10;

describe('planVegetation', () => {
  it('flattens a shared GLB mesh once across placement kinds but preserves different node transforms', () => {
    const geometry = new THREE.BoxGeometry(1, 2, 3);
    const clone = vi.spyOn(geometry, 'clone');
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(7, 4, -3); mesh.updateMatrixWorld(true);
    const cache = new WeakMap<THREE.Mesh, THREE.BufferGeometry>();
    // The two source files each back multiple kinds. All kinds still have their own
    // InstancedMesh/material, while immutable vertex data is shared once per GLB node.
    expect(NATURE_KINDS.CommonTree_1!.file).toBe(NATURE_KINDS.TwistedTree_1!.file);
    const first = flattenedNatureGeometry(mesh, cache);
    const reused = flattenedNatureGeometry(mesh, cache);
    expect(reused).toBe(first);
    expect(clone).toHaveBeenCalledOnce();
    expect(first).not.toBe(geometry);
    expect(first.boundingBox).toBeNull();
    first.computeBoundingBox();
    expect(first.boundingBox!.min.toArray()).toEqual([6.5, 3, -4.5]);
    expect(first.boundingBox!.max.toArray()).toEqual([7.5, 5, -1.5]);
    expect(geometry.boundingBox).toBeNull();
    // A different node may share the GLB's buffer but carry another transform.
    const other = new THREE.Mesh(geometry, material);
    other.position.x = -2; other.updateMatrixWorld(true);
    const separate = flattenedNatureGeometry(other, cache);
    expect(separate).not.toBe(first);
    expect(clone).toHaveBeenCalledTimes(2);
    separate.computeBoundingBox();
    expect(separate.boundingBox!.min.x).toBe(-2.5);
    first.dispose(); separate.dispose(); geometry.dispose(); material.dispose();
  });
  it('has genuinely different stone and boulder sizes using existing local assets', () => {
    expect(NATURE_KINDS.Stone_Small!.scale[1]).toBeLessThan(NATURE_KINDS.Rock_Medium_1!.scale[0]);
    expect(NATURE_KINDS.Rock_Medium_1!.scale[1]).toBeLessThan(NATURE_KINDS.Boulder_Large!.scale[0]);
  });
  it('builds a denser woodland close in while bounding expensive tree geometry', () => {
    // Inside a forest, not a lone patch whose edges thin toward open ground (canopyField).
    const block = [0, 1, 2, 20, 21, 22, 40, 41, 42].map((id) => patch(id, 'shola'));
    const trees = [...nearPlan(block, { x: 300, z: 300 }, flat)]
      .filter(([kind]) => kind.includes('Tree')).flatMap(([, items]) => items);
    expect(trees.length).toBeGreaterThan(350);
    // Includes a 24 m scheduling margin; the GPU fades geometry out by 80 m.
    expect(trees.length).toBeLessThan(500);
    expect(trees.every((p) => Math.hypot(p.x - 300, p.z - 300) <= TREE_DETAIL_RADIUS_M)).toBe(true);
    expect(Math.max(...trees.map((p) => p.scale)) / Math.min(...trees.map((p) => p.scale))).toBeGreaterThan(2.5);
  });
  it('thins a forest toward open ground so it has soft edges, not a square outline', () => {
    // A 3x3 shola block surrounded by grassland.
    const forest = new Set([189, 190, 191, 209, 210, 211, 229, 230, 231]);
    const island = Array.from({ length: 400 }, (_, id) => forest.has(id) ? patch(id, 'shola') : patch(id, 'grassland'));
    const field = canopyField(island);
    expect(field(3000, 3000)).toBeCloseTo(1.14, 2);
    expect(field(3000 + 450, 3000)).toBeLessThan(field(3000 + 300, 3000));
    const trees = [...planVegetation(island, { x: 3000, z: 3000 }, 900, flat, { only: (k) => k.startsWith('CommonTree_1'), canopyAt: field })]
      .flatMap(([, items]) => items);
    const within = (lo: number, hi: number) => trees.filter((t) => { const d = Math.max(Math.abs(t.x - 3000), Math.abs(t.z - 3000)); return d >= lo && d < hi; }).length;
    // Density per square metre: the outer ring of the block is sparser than its heart.
    const heart = within(0, 150) / (300 * 300), rim = within(300, 450) / (900 * 900 - 600 * 600);
    expect(rim).toBeLessThan(heart * 0.7);
    expect(rim).toBeGreaterThan(0);
  });
  it('varies stone silhouettes deterministically without distorting trees', () => {
    const item = { x: 15, y: 0, z: 17, rotY: 0, scale: 2 };
    expect(natureScale('CommonTree_1', item)).toEqual([2, 2, 2]);
    for (const kind of ['Stone_Small', 'Rock_Medium_1', 'Boulder_Large']) {
      const shape = natureScale(kind, item);
      expect(shape).toEqual(natureScale(kind, item));
      expect(new Set(shape).size).toBeGreaterThan(1);
      expect(shape).not.toEqual(natureScale(kind, { ...item, x: 16 }));
      expect(shape.every((value) => value > 0 && value < 3)).toBe(true);
    }
  });
  it('does not leave decorative grass on zero-biomass or flooded patches', () => {
    for (const extra of [{ grass: 0 }, { water: 30_000 }]) {
      const plan = planVegetation([patch(0, 'grassland', extra)], { x: 0, z: 0 }, 220, flat);
      expect([...plan].filter(([kind]) => kind.startsWith('Grass')).flatMap(([, items]) => items)).toEqual([]);
    }
  });
  const patches = Array.from({ length: 400 }, (_, id) =>
    patch(id, ['grassland', 'shola', 'riparian', 'marsh', 'rock', 'water'][id % 6]!));

  it('places detail only near where the camera is looking', () => {
    const focus = { x: 3000, z: 3000 };
    const plan = planVegetation(patches, focus, 450, flat);
    let total = 0;
    for (const items of plan.values()) {
      for (const item of items) {
        expect(Math.hypot(item.x - focus.x, item.z - focus.z)).toBeLessThanOrEqual(450);
        total++;
      }
    }
    expect(total).toBeGreaterThan(200);
  });

  it('is the same every time for the same place, so the forest does not reshuffle as you look', () => {
    const a = planVegetation(patches, { x: 1500, z: 1500 }, 450, flat);
    const b = planVegetation(patches, { x: 1500, z: 1500 }, 450, flat);
    expect(JSON.stringify([...a])).toBe(JSON.stringify([...b]));
  });

  it('grows what each habitat grows: trees in shola, grass in grassland, nothing in open water', () => {
    const only = (habitat: string) => Array.from({ length: 400 }, (_, id) => patch(id, habitat));
    const kindsIn = (habitat: string) => new Set(
      [...planVegetation(only(habitat), { x: 3000, z: 3000 }, 450, flat)]
        .filter(([, items]) => items.length > 0).map(([kind]) => kind),
    );
    expect([...kindsIn('shola')].some((k) => k.startsWith('CommonTree'))).toBe(true);
    expect([...kindsIn('grassland')].some((k) => k.startsWith('Grass'))).toBe(true);
    expect(kindsIn('water').size).toBe(0);
  });

  it('thins grass where the simulation says it has been grazed down', () => {
    const lush = Array.from({ length: 400 }, (_, id) => patch(id, 'grassland', { grass: 6000 }));
    const bare = Array.from({ length: 400 }, (_, id) => patch(id, 'grassland', { grass: 300 }));
    const grassCount = (ps: PatchView[]) => [...planVegetation(ps, { x: 3000, z: 3000 }, 450, flat)]
      .filter(([kind]) => kind.startsWith('Grass')).reduce((n, [, items]) => n + items.length, 0);
    expect(grassCount(bare)).toBeLessThan(grassCount(lush) / 3);
  });

  it('seats scanned roots and rocks below ground while preserving other plant contact', () => {
    const plan = planVegetation(patches, { x: 3000, z: 3000 }, 450, (x) => x / 100);
    for (const [kind, items] of plan) for (const item of items) {
      const file = NATURE_KINDS[kind]!.file;
      const seating = TREE_ROOT_SEATING[file] ?? ROCK_SEATING[file];
      const dimensions = natureScale(kind, item);
      const expected = item.x / 100 - (seating ? seating.embed * dimensions[1] + seating.radius * Math.max(dimensions[0], dimensions[2]) / 100 : 0);
      expect(item.y).toBeCloseTo(expected);
    }
  });

  it('buries the spreading scan soil skirt on flat ground and samples the downhill root edge', () => {
    expect(vegetationGroundHeight('CommonTree_1', 0, 0, 2, () => 10)).toBeCloseTo(9.44);
    expect(vegetationGroundHeight('CommonTree_2', 0, 0, 2, () => 10)).toBeCloseTo(9.9);
    // Downhill radius is 2.2 m, with a further .56 m embed at this scale.
    expect(vegetationGroundHeight('CommonTree_1', 0, 0, 2, (x) => 10 + x * 0.2)).toBeCloseTo(9);
    expect(vegetationGroundHeight('Fern_1', 0, 0, 2, () => 10)).toBe(10);
    expect(vegetationGroundHeight('DeadTree_2', 0, 0, 2, () => 10)).toBe(10);
  });
  it('partly embeds natural rocks and accounts for their non-uniform footprint', () => {
    // At the origin, shape multipliers are [.85, .55, 1.25].
    expect(vegetationGroundHeight('Boulder_Large', 0, 0, 2, () => 10)).toBeCloseTo(10 - 0.12 * 1.1);
    expect(vegetationGroundHeight('Boulder_Large', 0, 0, 2, (x) => 10 + x * 0.2))
      .toBeCloseTo(10 - 0.12 * 1.1 - 1.1 * 2.5 * 0.2);
    expect(vegetationGroundHeight('Stone_Small', 0, 0, 0.1, () => 10)).toBeCloseTo(10 - 0.1 * 0.055);
  });

  it('only names kinds that exist', () => {
    for (const kind of planVegetation(patches, { x: 3000, z: 3000 }, 450, flat).keys()) {
      expect(NATURE_KINDS[kind], kind).toBeDefined();
    }
  });

  it('can lay a denser carpet of grass close in, without disturbing the rest of the plan', () => {
    const base = planVegetation(patches, { x: 3000, z: 3000 }, 120, flat);
    const dense = planVegetation(patches, { x: 3000, z: 3000 }, 120, flat, { boost: 6, only: (k) => k.startsWith('Grass'), salt: 1 });
    const count = (plan: Map<string, unknown[]>, pick: (k: string) => boolean) =>
      [...plan].filter(([k]) => pick(k)).reduce((n, [, items]) => n + items.length, 0);
    expect(count(dense, (k) => k.startsWith('Grass'))).toBeGreaterThan(4 * count(base, (k) => k.startsWith('Grass')));
    expect(count(dense, (k) => !k.startsWith('Grass'))).toBe(0);
  });
});
