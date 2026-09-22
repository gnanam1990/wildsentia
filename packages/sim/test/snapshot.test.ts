import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const options = { seed: 5, speciesDir, initialAgents: { sambar: 20 }, minPopulation: { sambar: 20 } };

describe('snapshots', () => {
  it('round-trips through JSON without losing state', () => {
    const w = createWorld(options);
    for (let h = 0; h < 240; h++) w.step(1);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(w))), options);

    expect(restored.now()).toBe(w.now());
    expect(restored.agents).toEqual(w.agents);
    expect(restored.patches).toEqual(w.patches);
    expect(restored.totalNutrients()).toBeCloseTo(w.totalNutrients(), 6);
  });

  it('continues from the restored state with identical results', () => {
    const w = createWorld(options);
    for (let h = 0; h < 100; h++) w.step(1);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(w))), options);

    for (let h = 0; h < 50; h++) { w.step(1); restored.step(1); }

    expect(restored.now()).toBe(w.now());
    expect(restored.agents.map((a) => [a.id, a.patchId, a.alive, a.drives.hunger]))
      .toEqual(w.agents.map((a) => [a.id, a.patchId, a.alive, a.drives.hunger]));
  });

  it('records the sim version so an incompatible snapshot is detectable', () => {
    const w = createWorld(options);
    expect(takeSnapshot(w).simVersion).toBe('sim_0.1.0');
    expect(() => restoreSnapshot({ ...takeSnapshot(w), simVersion: 'sim_9.9.9' }, options))
      .toThrow(/version/i);
  });

  it('preserves the nutrient ledger so conservation survives a restore', () => {
    const w = createWorld(options);
    for (let h = 0; h < 480; h++) w.step(1);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(w))), options);
    expect(restored.ledger).toEqual(w.ledger);
  });
});
