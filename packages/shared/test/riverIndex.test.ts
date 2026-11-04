import { describe, expect, it } from 'vitest';
import { CONGO_GRID, congoRivers, createRng, nearestRiver, patchCentre, patchCount, riverIndex, worldExtentM } from '../src/index.js';

describe('river index', () => {
  it('finds exactly the river, distance and level the brute force finds', () => {
    for (const seed of [1, 7, 290]) {
      const rivers = congoRivers(seed, CONGO_GRID), nearest = riverIndex(rivers), e = worldExtentM(CONGO_GRID);
      const rng = createRng(seed, 'river-index');
      const points: Array<[number, number]> = Array.from({ length: 20_000 }, () => [e.min + rng.next() * (e.maxX - e.min), e.min + rng.next() * (e.maxZ - e.min)]);
      for (let id = 0; id < patchCount(CONGO_GRID); id += 3) { const c = patchCentre(CONGO_GRID, id); points.push([c.x, c.z]); }
      // Well outside the map, and exactly on a centreline vertex (a tie between two segments).
      points.push([-20_000, -20_000], [90_000, 1_000], [rivers[1]!.points[3]!.x, rivers[1]!.points[3]!.z]);
      for (const [x, z] of points) {
        const want = nearestRiver(rivers, x, z), got = nearest(x, z);
        expect(got.river).toBe(want.river);
        expect(got.distanceM).toBe(want.distanceM);
        expect(got.levelM).toBe(want.levelM);
      }
    }
  }, 120_000);

  it('is local: a lookup is at least five times cheaper than the brute force', () => {
    const rivers = congoRivers(7, CONGO_GRID), nearest = riverIndex(rivers);
    for (let i = 0; i < 2_000; i++) { nearestRiver(rivers, i * 23, i * 11); nearest(i * 23, i * 11); } // warm both
    // The best of three timings each, so one noisy moment on a shared CI runner cannot decide it.
    const best = (run: () => void) => Math.min(...[0, 1, 2].map(() => { const t = performance.now(); run(); return performance.now() - t; }));
    const brute = best(() => { for (let i = 0; i < 20_000; i++) nearestRiver(rivers, (i * 2.3) % 48_000, (i * 7.1) % 48_000); });
    const indexed = best(() => { for (let i = 0; i < 20_000; i++) nearest((i * 2.3) % 48_000, (i * 7.1) % 48_000); });
    expect(indexed).toBeLessThan(brute / 5);
  });
});
