import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runSoak } from '../src/soak.js';

// Deliberately failed founding cohort: exercise the real runner stop path without spending
// a full year or changing real species rates. Only this isolated test module uses the mock.
vi.mock('@vana/sim', async importOriginal => {
  const actual = await importOriginal<typeof import('@vana/sim')>();
  return { ...actual, createWorld: (options: Parameters<typeof actual.createWorld>[0]) => {
    const { landscape: _landscape, ...rest } = options;
    return actual.createWorld({ ...rest, initialAgents: {}, minPopulation: {} });
  } };
});
describe('soak completion evidence', () => {
  it('records the actual stop day and never reports a truncated run as completed', () => {
    const progress: number[] = [];
    const result = runSoak({ seed: 1, days: 90,
      speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
      onProgress: p => progress.push(p.completedDays) });
    expect(result.days).toBe(90); expect(result.completedDays).toBe(31);
    expect(result.completedWorldTime).toBe(31 * 86400); expect(result.stoppedEarly).toBe(true);
    expect(progress.at(-1)).toBe(result.completedDays);
    expect(result.failures).toContain('incomplete soak: 31 of 90 requested days');
    expect(result.failures.some(f => f.includes('extinct'))).toBe(true);
  });
});
