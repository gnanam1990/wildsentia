import { describe, expect, it } from 'vitest';
import { CONGO_GRID, ISLAND_GRID, congoRivers, nearestRiver, worldExtentM } from '../src/index.js';

describe('congo_terrain_v1 rivers', () => {
  const rivers = congoRivers(7, CONGO_GRID);
  const e = worldExtentM(CONGO_GRID);

  it('is the same network for the same seed, and a different one for another seed', () => {
    expect(congoRivers(7, CONGO_GRID)).toEqual(rivers);
    expect(congoRivers(8, CONGO_GRID)[0]!.points).not.toEqual(rivers[0]!.points);
  });

  it('runs one wide main river from the west edge to the east edge, falling all the way', () => {
    const main = rivers[0]!;
    expect(main.kind).toBe('main');
    expect(main.widthM).toBe(900);
    expect(main.points[0]!.x).toBeLessThanOrEqual(e.min);
    expect(main.points.at(-1)!.x).toBeGreaterThanOrEqual(e.maxX);
    for (let i = 1; i < main.points.length; i++) expect(main.points[i]!.levelM).toBeLessThanOrEqual(main.points[i - 1]!.levelM);
  });

  it('has four to six tributaries that start on the main river, stay on the map and fall toward it', () => {
    for (const seed of [1, 2, 3, 7, 42]) {
      const network = congoRivers(seed, CONGO_GRID), tributaries = network.filter((r) => r.kind === 'tributary');
      expect(tributaries.length, `seed ${seed}`).toBeGreaterThanOrEqual(4);
      expect(tributaries.length, `seed ${seed}`).toBeLessThanOrEqual(6);
      for (const t of tributaries) {
        expect(nearestRiver([network[0]!], t.points[0]!.x, t.points[0]!.z).distanceM).toBeLessThan(1);
        for (const p of t.points) {
          expect(p.x).toBeGreaterThanOrEqual(e.min); expect(p.x).toBeLessThan(e.maxX);
          expect(p.z).toBeGreaterThanOrEqual(e.min); expect(p.z).toBeLessThan(e.maxZ);
        }
        for (let i = 1; i < t.points.length; i++) expect(t.points[i]!.levelM).toBeGreaterThanOrEqual(t.points[i - 1]!.levelM);
        const length = t.points.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - t.points[i]!.x, p.z - t.points[i]!.z), 0);
        expect(length).toBeGreaterThan(6_000);
      }
    }
  });

  it('refuses a grid too small for a river network', () => {
    expect(() => congoRivers(7, ISLAND_GRID)).toThrow('too small');
  });
});
