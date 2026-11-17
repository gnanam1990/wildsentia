import { describe, expect, it } from 'vitest';
import { onShore, shoreSides, HUNTERS } from '../src/pools.js';

const pool = { x: 0, z: 0, radius: 4 };
const at = (id: string, hunter: boolean, seed: number) => ({ id, x: 0, z: 0, hunter, seed });

describe('a hunter drinking with its prey', () => {
  it('is drawn across the water from them, not shoulder to shoulder', () => {
    const drinkers = [at('duiker_a', false, 10), at('duiker_b', false, 40), at('duiker_c', false, 25), at('cat', true, 30)];
    const sides = shoreSides(drinkers, [pool]);
    expect(sides.has('duiker_a')).toBe(false);
    const preyAngle = Math.atan2(['duiker_a', 'duiker_b', 'duiker_c'].reduce((s, _, i) => s + Math.sin([10, 40, 25][i]! * Math.PI / 180), 0),
      [10, 40, 25].reduce((s, a) => s + Math.cos(a * Math.PI / 180), 0));
    const cat = onShore({ x: 0, z: 0, heading: 0 }, [pool], 0.25, true, 30, sides.get('cat'));
    const duiker = onShore({ x: 0, z: 0, heading: 0 }, [pool], 0.2, true, 25);
    expect(Math.hypot(cat.x - duiker.x, cat.z - duiker.z)).toBeGreaterThan(pool.radius * 1.6);
    const catAngle = Math.atan2(cat.x, cat.z);
    expect(Math.abs(Math.atan2(Math.sin(catAngle - preyAngle - Math.PI), Math.cos(catAngle - preyAngle - Math.PI)))).toBeLessThan(0.01);
  });
  it('leaves pools with only prey, or only hunters, as they were', () => {
    expect(shoreSides([at('a', false, 1), at('b', false, 2)], [pool]).size).toBe(0);
    expect(shoreSides([at('a', true, 1), at('b', true, 2)], [pool]).size).toBe(0);
  });
  it('knows the Congo\'s hunters', () => {
    for (const id of ['african_leopard', 'african_golden_cat', 'dwarf_crocodile']) expect(HUNTERS.has(id)).toBe(true);
    expect(HUNTERS.has('blue_duiker')).toBe(false);
  });
});
