import { describe, expect, it } from 'vitest';
import { insidePool, onShore, shoreFactor } from '../src/pools.js';

describe('onShore', () => {
  const pool = { x: 100, z: 200, radius: 10 };
  it('draws an animal at the pool centre at the edge of the water, facing it when drinking', () => {
    const p = onShore({ x: 100, z: 200, heading: 0, moving: false }, [pool], 1, true, 90);
    // On the bank: clear of the water by its body margin, and within a stride of it.
    expect(insidePool(pool, p.x, p.z, 0.6)).toBe(false);
    expect(insidePool(pool, p.x, p.z, 0.8)).toBe(true);
    // Facing the centre: the model's forward (sin h, cos h) points back at the pool.
    const toCentre = Math.hypot(100 - p.x, 200 - p.z);
    expect(Math.sin(p.heading) * (100 - p.x) + Math.cos(p.heading) * (200 - p.z)).toBeCloseTo(toCentre, 6);
  });
  it('spreads several drinkers round the shore and keeps their side of the pool', () => {
    const a = onShore({ x: 100, z: 200, heading: 0 }, [pool], 1, true, 10);
    const b = onShore({ x: 100, z: 200, heading: 0 }, [pool], 1, true, 200);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(5);
    const east = onShore({ x: 104, z: 200, heading: 1 }, [pool], 1, false, 0);
    expect(east.x).toBeGreaterThan(108); expect(east.z).toBeCloseTo(200); expect(east.heading).toBe(1);
    expect(insidePool(pool, east.x, east.z, 0.6)).toBe(false);
  });
  it('ends on dry ground when neighbouring pools overlap', () => {
    const pools = [{ x: 0, z: 0, radius: 10 }, { x: 0, z: 12, radius: 4 }];
    const p = onShore({ x: 0, z: 1, heading: 0 }, pools, 1, true, 0);
    for (const pool of pools) expect(insidePool(pool, p.x, p.z)).toBe(false);
  });
  it('leaves animals on dry ground alone', () => {
    const dry = { x: 130, z: 200, heading: 2 };
    expect(onShore(dry, [pool], 1, true, 0)).toBe(dry);
  });
});

describe('pool shoreline', () => {
  it('is irregular, not a circle, and each pool has its own', () => {
    const radii = (seed: number) => Array.from({ length: 72 }, (_, k) => shoreFactor(k / 72 * Math.PI * 2, seed));
    const a = radii(3), b = radii(170);
    expect(Math.max(...a) - Math.min(...a)).toBeGreaterThan(0.12);
    expect(a.some((r, k) => Math.abs(r - b[k]!) > 0.05)).toBe(true);
  });
  it('stays between 0.8 and 1.2 of the nominal radius, so drinking spots stay in the water', () => {
    for (let seed = 0; seed < 200; seed++) for (let k = 0; k < 72; k++) {
      const f = shoreFactor(k / 72 * Math.PI * 2, seed);
      expect(f).toBeGreaterThan(0.85); expect(f).toBeLessThan(1.15);
    }
  });
});
