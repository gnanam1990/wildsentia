import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { WORLD_SECONDS_PER_DAY } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { assertNutrientsConserved } from '../src/fields/nutrients.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const options = { seed: 5, speciesDir, initialAgents: { sambar: 40 }, minPopulation: { sambar: 40 } };

describe('World', () => {
  it('spawns the requested population', () => {
    expect(createWorld(options).livingCount('sambar')).toBe(40);
  });

  it('advances the clock by the hours stepped', () => {
    const w = createWorld(options);
    w.step(24);
    expect(w.now()).toBe(WORLD_SECONDS_PER_DAY);
  });

  it('is deterministic for a given seed', () => {
    const a = createWorld(options);
    const b = createWorld(options);
    for (let i = 0; i < 200; i++) { a.step(1); b.step(1); }
    expect(a.log.size()).toBe(b.log.size());
    expect(a.agents.map((x) => [x.id, x.patchId, x.drives.hunger]))
      .toEqual(b.agents.map((x) => [x.id, x.patchId, x.drives.hunger]));
  });

  it('conserves nutrients across 90 world-days', () => {
    const w = createWorld(options);
    const baseline = w.totalNutrients();
    for (let h = 0; h < 90 * 24; h++) w.step(1);
    assertNutrientsConserved(baseline, w.totalNutrients(), 1e-2);
  });

  it('keeps the population at the configured floor via immigration', () => {
    const w = createWorld(options);
    for (let h = 0; h < 200 * 24; h++) w.step(1);
    expect(w.livingCount('sambar')).toBeGreaterThanOrEqual(40);
    expect(w.log.all().some((e) => e.type === 'immigration')).toBe(true);
  });

  it('never produces NaN or negative biomass', () => {
    const w = createWorld(options);
    for (let h = 0; h < 120 * 24; h++) w.step(1);
    for (const p of w.patches) {
      expect(Number.isFinite(p.plant.grass)).toBe(true);
      expect(p.plant.grass).toBeGreaterThanOrEqual(0);
      expect(p.soilNutrients).toBeGreaterThanOrEqual(0);
      expect(p.waterVolume).toBeGreaterThanOrEqual(0);
    }
  });
});
