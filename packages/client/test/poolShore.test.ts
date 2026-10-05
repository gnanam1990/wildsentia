import { describe, expect, it } from 'vitest';
import { onShore } from '../src/pools.js';

describe('onShore', () => {
  const pool = { x: 100, z: 200, radius: 10 };
  it('draws an animal at the pool centre on the shore, facing the water when drinking', () => {
    const p = onShore({ x: 100, z: 200, heading: 0, moving: false }, [pool], 1, true, 90);
    expect(Math.hypot(p.x - 100, p.z - 200)).toBeCloseTo(10.65);
    // Facing the centre: the model's forward (sin h, cos h) points back at the pool.
    expect(Math.sin(p.heading) * (100 - p.x) + Math.cos(p.heading) * (200 - p.z)).toBeGreaterThan(10);
  });
  it('spreads several drinkers round the shore and keeps their side of the pool', () => {
    const a = onShore({ x: 100, z: 200, heading: 0 }, [pool], 1, true, 10);
    const b = onShore({ x: 100, z: 200, heading: 0 }, [pool], 1, true, 200);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(5);
    const east = onShore({ x: 104, z: 200, heading: 1 }, [pool], 1, false, 0);
    expect(east.x).toBeGreaterThan(110); expect(east.z).toBeCloseTo(200); expect(east.heading).toBe(1);
  });
  it('ends on dry ground when neighbouring pools overlap', () => {
    const pools = [{ x: 0, z: 0, radius: 10 }, { x: 0, z: 12, radius: 4 }];
    const p = onShore({ x: 0, z: 1, heading: 0 }, pools, 1, true, 0);
    for (const pool of pools) expect(Math.hypot(p.x - pool.x, p.z - pool.z)).toBeGreaterThanOrEqual(pool.radius);
  });
  it('leaves animals on dry ground alone', () => {
    const dry = { x: 130, z: 200, heading: 2 };
    expect(onShore(dry, [pool], 1, true, 0)).toBe(dry);
  });
});
