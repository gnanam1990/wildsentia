import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runSoak } from '../src/soak.js';

// Deliberately failed founding cohort and fifteen patches with impossible negative soil:
// exercise the real runner stop path without spending a full year or changing real species
// rates. An extinction is recorded once; the soil failures recur every sample until the cap.
// Only this isolated test module uses the mock.
vi.mock('@vana/sim', async importOriginal => {
  const actual = await importOriginal<typeof import('@vana/sim')>();
  return { ...actual, createWorld: (options: Parameters<typeof actual.createWorld>[0]) => {
    const { landscape: _landscape, ...rest } = options;
    const world = actual.createWorld({ ...rest, initialAgents: {}, minPopulation: {} });
    for (const patch of world.patches.slice(0, 15)) patch.soilNutrients = -1;
    return world;
  } };
});
describe('soak completion evidence', () => {
  it('records the actual stop day and never reports a truncated run as completed', () => {
    const progress: number[] = [];
    const result = runSoak({ seed: 1, days: 90,
      speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
      onProgress: p => progress.push(p.completedDays) });
    expect(result.days).toBe(90); expect(result.completedDays).toBe(11);
    expect(result.completedWorldTime).toBe(11 * 86400); expect(result.stoppedEarly).toBe(true);
    expect(progress.at(-1)).toBe(result.completedDays);
    expect(result.failures).toContain('incomplete soak: 11 of 90 requested days');
    // Thirteen species, each extinct from the first sample and each recorded exactly once.
    expect(result.failures.filter(f => f.includes('extinct'))).toHaveLength(13);
  });
});
