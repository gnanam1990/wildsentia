import { describe, expect, it } from 'vitest';
import { canRetryPrey, rememberFailedHunt, FAILED_HUNT_RETRY_SECONDS, MAX_FAILED_HUNT_MEMORIES } from '../src/agents/huntMemory.js';
import { makeAgent, SPECIES_DIR } from './helpers.js';
import { createWorld } from '../src/world.js';
import { takeSnapshot, restoreSnapshot } from '../src/snapshot.js';

describe('bounded failed-hunt memory', () => {
  it('excludes only the failed individual until the retry time and expires exactly at it', () => {
    const a = makeAgent('dhole');
    rememberFailedHunt(a, 'prey', 100);
    expect(canRetryPrey(a, 'prey', 100)).toBe(false);
    expect(canRetryPrey(a, 'other', 100)).toBe(true);
    expect(canRetryPrey(a, 'prey', 100 + FAILED_HUNT_RETRY_SECONDS)).toBe(true);
  });
  it('prunes expired entries, replaces duplicates and keeps memory bounded', () => {
    const a = makeAgent('dhole');
    for (let i = 0; i < 40; i++) rememberFailedHunt(a, `p${i}`, i);
    expect(a.failedHunts).toHaveLength(MAX_FAILED_HUNT_MEMORIES);
    rememberFailedHunt(a, 'p39', 60);
    expect(a.failedHunts!.filter((m) => m.preyId === 'p39')).toHaveLength(1);
    rememberFailedHunt(a, 'new', 100 + FAILED_HUNT_RETRY_SECONDS);
    expect(a.failedHunts).toEqual([{ preyId: 'new', retryAfter: 100 + 2 * FAILED_HUNT_RETRY_SECONDS }]);
  });
  it('survives a checkpoint with approach commitment intact and without RNG mutation', () => {
    const options = { seed: 5, speciesDir: SPECIES_DIR, initialAgents: { dhole: 1 }, minPopulation: {} };
    const w = createWorld(options); const a = w.agents[0]!;
    const before = takeSnapshot(w).rngState;
    rememberFailedHunt(a, 'old-prey', w.now()); a.targetId = 'visible-prey';
    const restored = restoreSnapshot(takeSnapshot(w), options);
    expect(restored.agents[0]!.failedHunts).toEqual(a.failedHunts);
    expect(restored.agents[0]!.targetId).toBe('visible-prey');
    expect(takeSnapshot(w).rngState).toEqual(before);
  });
});
