import { describe, expect, it } from 'vitest';
import { SIM_VERSION, createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot, upgradeV37Snapshot } from '../src/snapshot.js';
import { SPECIES_DIR } from './helpers.js';

const options = { seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v1' as const,
  initialAgents: { langur: 6, chital: 6, tiger: 1 }, minPopulation: {} };

describe('sim_0.38.0 upgrade of a saved sim_0.37.0 world', () => {
  it('is refused without the explicit upgrade and never rewrites the old checkpoint', () => {
    expect(SIM_VERSION).toBe('sim_0.38.0');
    const world = createWorld(options); world.step(3);
    const old = { ...structuredClone(takeSnapshot(world)), simVersion: 'sim_0.37.0' as const };
    const before = JSON.stringify(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    upgradeV37Snapshot(old);
    expect(JSON.stringify(old)).toBe(before);
    expect(() => upgradeV37Snapshot({ ...old, simVersion: 'sim_0.36.0' })).toThrow(/only sim_0.37.0/);
  });

  it('keeps every saved state byte and schedules nothing: only future decisions change', () => {
    const world = createWorld(options); world.step(3);
    const current = takeSnapshot(world);
    const upgraded = upgradeV37Snapshot({ ...structuredClone(current), simVersion: 'sim_0.37.0' });
    expect(upgraded).toEqual(current);
    expect(takeSnapshot(restoreSnapshot(upgraded, options))).toEqual(current);
  });
});
