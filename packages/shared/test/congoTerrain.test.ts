import { describe, expect, it } from 'vitest';
import { CONGO_GRID, cardinalNeighbours, createCongoTerrain, patchCentre, patchCount, regionIds, regionPatchIds } from '../src/index.js';

describe('congo_terrain_v1 terrain', () => {
  const terrain = createCongoTerrain(7, CONGO_GRID);
  const habitats = Array.from({ length: patchCount(CONGO_GRID) }, (_, id) => terrain.habitatAt(id));

  it('is mostly dry forest, with every habitat present', () => {
    const share = (h: string) => habitats.filter((x) => x === h).length / habitats.length;
    expect(share('terra_firme')).toBeGreaterThan(0.5);
    for (const h of ['water', 'flooded_forest', 'swamp_forest', 'bai']) expect(share(h), h).toBeGreaterThan(0);
    expect(share('water')).toBeLessThan(0.12);
  });

  it('connects every water patch to the main river', () => {
    const water = new Set(habitats.flatMap((h, id) => h === 'water' ? [id] : []));
    const start = [...water].find((id) => patchCentre(CONGO_GRID, id).x < 300)!;
    const seen = new Set([start]), queue = [start];
    while (queue.length) for (const n of cardinalNeighbours(CONGO_GRID, queue.pop()!)) if (water.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
    expect(seen.size).toBe(water.size);
  });

  it('puts no more than two bais in any region', () => {
    for (const r of regionIds(CONGO_GRID)) expect(regionPatchIds(CONGO_GRID, r).filter((id) => habitats[id] === 'bai').length).toBeLessThanOrEqual(2);
  });

  it('keeps every river bed below its banks and the land within 250-700 m', () => {
    for (let id = 0; id < habitats.length; id += 37) {
      const c = patchCentre(CONGO_GRID, id), h = terrain.heightAt(c.x, c.z);
      expect(h).toBeGreaterThanOrEqual(250); expect(h).toBeLessThanOrEqual(700);
      if (habitats[id] === 'water') for (const n of cardinalNeighbours(CONGO_GRID, id))
        if (habitats[n] !== 'water') expect(terrain.heightAt(patchCentre(CONGO_GRID, n).x, patchCentre(CONGO_GRID, n).z)).toBeGreaterThan(h);
    }
  });

  it('is the same terrain for the same seed', () => {
    const again = createCongoTerrain(7, CONGO_GRID);
    for (let id = 0; id < habitats.length; id += 101) expect(again.habitatAt(id)).toBe(habitats[id]);
  });
});
