import { describe, expect, it } from 'vitest';
import { AdaptiveQuality, qualityMode, RENDER_BUDGETS, RenderPacer, renderPixelRatio, ShadowCadence, SHADOW_HZ } from '../src/renderQuality.js';
import { chooseVisible } from '../src/lod.js';

describe('observer rendering budgets', () => {
  it('paces only shadows and immediately refreshes on jumps, invalidation, resume and tier changes', () => {
    const target = { x: 0, y: 0, z: 0 }, light = { x: 100, y: 100, z: 100 };
    for (const tier of ['smooth', 'balanced', 'high'] as const) {
      const cadence = new ShadowCadence(); let updates = 0;
      for (let frame = 0; frame < 600; frame++) if (cadence.next(frame * 1000 / 60, tier, target, light)) updates++;
      expect(updates).toBe(SHADOW_HZ[tier] * 10);
      expect(cadence.next(20_000, tier, target, light)).toBe(true);
      expect(cadence.next(20_001, tier, target, light)).toBe(false);
      expect(cadence.next(20_002, tier, { ...target, x: 4 }, light)).toBe(true);
      expect(cadence.next(20_003, tier, { ...target, x: 4 }, { ...light, z: 104 })).toBe(true);
      expect(cadence.next(20_004, tier, target, light, true)).toBe(true);
      expect(cadence.next(20_005, tier === 'high' ? 'smooth' : 'high', target, light)).toBe(true);
      expect(cadence.next(1, tier, target, light)).toBe(true);
      expect(cadence.next(NaN, tier, target, light)).toBe(false);
    }
  });
  it('caps total pixel work even on high-DPI 4K screens without changing CSS size', () => {
    for (const tier of ['smooth', 'balanced', 'high'] as const) {
      for (const [width, height, dpr] of [[3840, 2160, 2], [1440, 900, 2], [390, 844, 3]]) {
        const ratio = renderPixelRatio(tier, width!, height!, dpr!);
        expect(width! * height! * ratio ** 2).toBeLessThanOrEqual(RENDER_BUDGETS[tier].pixels + 1);
        expect(ratio).toBeLessThanOrEqual(dpr!);
      }
    }
    expect(renderPixelRatio('balanced', 800, 600, 1)).toBe(1);
    expect(renderPixelRatio('balanced', 800, 600, NaN)).toBe(1);
    expect(qualityMode('corrupt-value')).toBe('auto');
  });
  it('requires sustained slow delivery, never lowers a manual tier, and does not oscillate', () => {
    const auto = new AdaptiveQuality();
    for (let i = 0; i < 60; i++) auto.sample(17);
    expect(auto.tier).toBe('balanced');
    for (let i = 0; i < 59; i++) expect(auto.sample(34)).toBe(false);
    for (let i = 0; i < 61; i++) auto.sample(34);
    expect(auto.tier).toBe('smooth');
    for (let i = 0; i < 1800; i++) auto.sample(16.7);
    expect(auto.tier).toBe('smooth');
    auto.select('high');
    for (let i = 0; i < 200; i++) expect(auto.sample(100)).toBe(false);
    expect(auto.tier).toBe('high');
    auto.select('auto'); expect(auto.tier).toBe('balanced');
    for (let i = 0; i < 200; i++) auto.sample(2000);
    expect(auto.tier).toBe('balanced');
  });
  it('resets timing on suspension, clamps RAF work to 60 Hz, and resumes without a time jump', () => {
    for (const hz of [60, 120, 144]) {
      const pacer = new RenderPacer(); let frames = 0, elapsed = 0;
      for (let i = 0; i <= hz * 10; i++) {
        const delta = pacer.next(i * 1000 / hz);
        if (delta !== null) { frames++; elapsed += delta; }
      }
      expect(frames).toBeGreaterThanOrEqual(599); expect(frames).toBeLessThanOrEqual(602);
      expect(elapsed).toBeCloseTo(10_000, 0);
      expect(pacer.next(20_000, true)).toBeNull();
      expect(pacer.next(100_000)).toBe(0);
    }
  });
  it('keeps the selected animal at all budgets and leaves other animals available as dots', () => {
    const positions = new Map(Array.from({ length: 500 }, (_, i) => [`a${i}`, { x: i, z: i }]));
    for (const tier of ['smooth', 'balanced', 'high'] as const) {
      const budget = RENDER_BUDGETS[tier];
      const selected = chooseVisible(positions, { x: 0, z: 0 }, 'a499', { max: budget.animalModels, radiusM: budget.animalRadius });
      expect(selected.size).toBe(budget.animalModels); expect(selected.has('a499')).toBe(true);
      expect(positions.size).toBe(500);
    }
  });
});
