import { describe, expect, it } from 'vitest';
import { NATURE_KINDS, planVegetation } from '../src/vegetation.js';
import type { PatchView } from '../src/terrain.js';

const patch = (id: number, habitat: string, extra: Partial<PatchView> = {}): PatchView => ({
  id, x: id % 20, y: Math.floor(id / 20), habitat, grass: 6000, browse: 3000, water: 0,
  canopyCover: habitat === 'shola' ? 0.8 : 0.1, ...extra,
});
const flat = () => 10;

describe('planVegetation', () => {
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

  it('stands everything on the ground it is given', () => {
    const plan = planVegetation(patches, { x: 3000, z: 3000 }, 450, (x) => x / 100);
    for (const items of plan.values()) for (const item of items) expect(item.y).toBeCloseTo(item.x / 100);
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

