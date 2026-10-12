import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runSoak } from '../src/soak.js';
vi.mock('@vana/sim', async importOriginal => {
  const actual = await importOriginal<typeof import('@vana/sim')>();
  return { ...actual, createWorld: (options: Parameters<typeof actual.createWorld>[0]) => {
    const world = actual.createWorld(options);
    const count = world.livingCount.bind(world);
    world.livingCount = id => world.now() >= 2 * 86400 && id === 'dhole' ? 0 : count(id);
    return world;
  } };
});
describe('soak final-state gate', () => {
  it('fails a final-day extinction outside the periodic sample, exactly once', () => {
    const result = runSoak({ seed: 1, days: 2, terrainProfile: 'island_v2', communityProfile: 'household_v1',
      speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)) });
    expect(result.finalPopulation.dhole).toBe(0);
    expect(result.years[0]!.extinct).toContain('dhole');
    expect(result.failures.filter(failure => failure.includes('dhole extinct'))).toEqual(['day 1: dhole extinct']);
  });
});
