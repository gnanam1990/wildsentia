import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { GRID_SIZE } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { assertNutrientsConserved } from '../src/fields/nutrients.js';
import { expectedExchange } from '../src/landscape.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const onEdge = (patchId: number): boolean => {
  const x = patchId % GRID_SIZE;
  const y = Math.floor(patchId / GRID_SIZE);
  return x === 0 || y === 0 || x === GRID_SIZE - 1 || y === GRID_SIZE - 1;
};

describe('expectedExchange', () => {
  it('brings animals in when the forest holds fewer than the country around it', () => {
    expect(expectedExchange(100, 400, 0.001, 24)).toBeCloseTo(0.3);
  });

  it('sends animals out when it holds more', () => {
    expect(expectedExchange(500, 400, 0.001, 24)).toBeCloseTo(-0.1);
  });

  it('is still when the two match, and scales with the time stepped', () => {
    expect(expectedExchange(400, 400, 0.001, 24)).toBe(0);
    expect(expectedExchange(100, 400, 0.001, 1)).toBeCloseTo(0.3 / 24);
  });
});

describe('World landscape exchange', () => {
  // Thirty-six square kilometres is a window onto a larger forest, not a sealed box. Animals
  // walk in where this stretch is thinner than the country around it and out where it is
  // thicker, which is what keeps a small reserve from emptying or overflowing.
  it('receives immigrants at the edge when the forest is below the regional density', () => {
    const w = createWorld({
      seed: 3, speciesDir, initialAgents: { sambar: 5 }, minPopulation: {},
      landscape: { regional: { sambar: 200 }, exchangePerDay: 0.01 },
    });
    let arrivals = 0;
    for (let h = 0; h < 60 * 24; h++) {
      w.step(1);
      for (const e of w.log.take()) {
        if (e.type !== 'immigration') continue;
        arrivals++;
        expect(onEdge(e.patchId)).toBe(true);
      }
    }
    expect(arrivals).toBeGreaterThan(20);
  });

  it('loses emigrants from the edge when above it, and conserves nutrients doing so', () => {
    const w = createWorld({
      seed: 4, speciesDir, initialAgents: { sambar: 300 }, minPopulation: {},
      landscape: { regional: { sambar: 100 }, exchangePerDay: 0.01 },
    });
    const baseline = w.totalNutrients();
    let departures = 0;
    for (let h = 0; h < 30 * 24; h++) {
      w.step(1);
      for (const e of w.log.take()) {
        if (e.type !== 'emigration') continue;
        departures++;
        expect(onEdge(e.patchId)).toBe(true);
      }
    }
    expect(departures).toBeGreaterThan(10);
    expect(w.agents.every((a) => a.state !== 'emigrated')).toBe(true);
    expect(w.deceased.some((a) => a.state === 'emigrated')).toBe(true);
    assertNutrientsConserved(baseline, w.totalNutrients(), 1e-2);
  });
});
