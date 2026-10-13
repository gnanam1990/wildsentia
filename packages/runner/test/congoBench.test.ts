import { describe, expect, it } from 'vitest';
import { CONGO_HOUR_BUDGET_MS, CONGO_STAND_IN, runCongoBench } from '../src/congoBench.js';

describe('congo budget benchmark', () => {
  it('measures founding, hourly steps, memory and snapshot size', () => {
    const r = runCongoBench({ seed: 7, warmHours: 2, measureHours: 4, population: { hare: 2_000, leopard: 10 } });
    expect(r.animals).toBeGreaterThan(1_900);
    expect(r.hourMs.median).toBeGreaterThan(0);
    expect(r.hourMs.p95).toBeGreaterThanOrEqual(r.hourMs.median);
    expect(r.hourMs.max).toBeGreaterThanOrEqual(r.hourMs.p95);
    expect(r.snapshotMb).toBeGreaterThan(0);
  }, 300_000);

  it('steps the full Congo founding population within the 2 s budget', () => {
    // The spec's budget at its real size (a tenth of the animals is not a tenth of the work: the
    // 25,600 patches cost the same at any population). A slower host may set its own budget.
    const r = runCongoBench({ seed: 7, warmHours: 2, measureHours: 3, population: { ...CONGO_STAND_IN } });
    expect(r.animals).toBeGreaterThan(45_000);
    expect(r.hourMs.max).toBeLessThan(Number(process.env.VANA_CONGO_HOUR_BUDGET_MS ?? CONGO_HOUR_BUDGET_MS));
  }, 300_000);
});
