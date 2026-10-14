import { describe, expect, it } from 'vitest';
import { runCongoSoak } from '../src/congoSoak.js';

// Congo 1B gate in CI: a short soak of a scaled Congo forest (the 30-day full run is the CLI).
describe('a short Congo soak', () => {
  it('keeps every species, sees leopards kill, strands nobody in the river, and holds the budget', () => {
    const r = runCongoSoak({ seed: 7, days: 4, population: { blue_duiker: 4_000, water_chevrotain: 600, african_leopard: 40 } });
    for (const id of ['blue_duiker', 'water_chevrotain', 'african_leopard']) expect(r.living[id], id).toBeGreaterThan(0);
    expect(Object.values(r.kills).reduce((s, n) => s + n, 0)).toBeGreaterThan(0);
    // Who killed whom, and how each species died, so a decline can be traced to its cause.
    expect(Object.values(r.killsBy.african_leopard ?? {}).reduce((s, n) => s + n, 0)).toBe(Object.values(r.kills).reduce((s, n) => s + n, 0));
    expect(Object.values(r.deaths.blue_duiker ?? {}).reduce((s, n) => s + n, 0)).toBeGreaterThanOrEqual(r.kills.blue_duiker ?? 0);
    expect(r.strandedInWater).toBe(0);
    expect(r.hourMs.max).toBeLessThan(2_000);
  }, 600_000);
});
