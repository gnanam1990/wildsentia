import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Agent } from '@vana/shared';
import { loadSpeciesDir } from '../src/config/loader.js';
import { updateDrives } from '../src/agents/drives.js';

const species = loadSpeciesDir(fileURLToPath(new URL('../../../config/species', import.meta.url))).get('sambar')!;

const makeAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'a1', speciesId: 'sambar', bornAt: 0, massKg: 220, patchId: 0,
  state: 'resting', currentGoal: 'rest', alternativeGoal: null, goalScore: 0,
  drives: { hunger: 0.2, thirst: 0.2, fatigue: 0.2, fear: 0 }, alive: true,
  ...overrides,
});

describe('updateDrives', () => {
  it('raises hunger and thirst over time', () => {
    const a = makeAgent();
    updateDrives(a, species, 6);
    expect(a.drives.hunger).toBeGreaterThan(0.2);
    expect(a.drives.thirst).toBeGreaterThan(0.2);
  });

  it('raises thirst faster than hunger', () => {
    const a = makeAgent();
    updateDrives(a, species, 6);
    expect(a.drives.thirst - 0.2).toBeGreaterThan(a.drives.hunger - 0.2);
  });

  it('recovers fatigue while resting and builds it while travelling', () => {
    const resting = makeAgent({ state: 'resting', drives: { hunger: 0, thirst: 0, fatigue: 0.8, fear: 0 } });
    const moving = makeAgent({ state: 'travelling', drives: { hunger: 0, thirst: 0, fatigue: 0.2, fear: 0 } });
    updateDrives(resting, species, 4);
    updateDrives(moving, species, 4);
    expect(resting.drives.fatigue).toBeLessThan(0.8);
    expect(moving.drives.fatigue).toBeGreaterThan(0.2);
  });

  it('decays fear toward zero', () => {
    const a = makeAgent({ drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0.9 } });
    updateDrives(a, species, 3);
    expect(a.drives.fear).toBeLessThan(0.9);
    expect(a.drives.fear).toBeGreaterThanOrEqual(0);
  });

  it('clamps every drive into [0, 1]', () => {
    const a = makeAgent({ drives: { hunger: 0.99, thirst: 0.99, fatigue: 0.99, fear: 0 } });
    updateDrives(a, species, 500);
    for (const v of Object.values(a.drives)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
