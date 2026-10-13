import { describe, expect, it } from 'vitest';
import { runCongoBench } from '../src/congoBench.js';

describe('congo budget benchmark', () => {
  it('measures founding, hourly steps, memory and snapshot size', () => {
    const r = runCongoBench({ seed: 7, warmHours: 2, measureHours: 4, population: { hare: 2_000, leopard: 10 } });
    expect(r.animals).toBeGreaterThan(1_900);
    expect(r.hourMs.median).toBeGreaterThan(0);
    expect(r.hourMs.p95).toBeGreaterThanOrEqual(r.hourMs.median);
    expect(r.hourMs.max).toBeGreaterThanOrEqual(r.hourMs.p95);
    expect(r.snapshotMb).toBeGreaterThan(0);
  }, 300_000);

  it('keeps a scaled Congo hour inside its share of the 2 s budget', () => {
    const r = runCongoBench({ seed: 7, warmHours: 2, measureHours: 4, population: { hare: 4_500, chital: 300, leopard: 15 } });
    // A tenth of the population gets a tenth of the budget; the full-size check is the CLI.
    expect(r.hourMs.p95).toBeLessThan(Number(process.env.VANA_CONGO_TENTH_BUDGET_MS ?? 200));
  }, 300_000);
});
