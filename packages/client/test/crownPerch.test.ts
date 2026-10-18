import { describe, expect, it } from 'vitest';
import { spreadInCrowns } from '../src/crownPerch.js';

const at = (id: string, x = 100, z = 200, altitudeM = 20, moving = false) => ({ id, x, z, heading: 0, moving, altitudeM });

// A mangabey troop rests up its patch's one climbable tree: the simulation records every one of
// them at that tree's point, so up to seventeen were drawn inside each other.
describe('spreading a troop through its tree', () => {
  it('gives each animal resting in one tree its own place in the crown', () => {
    const troop = Array.from({ length: 17 }, (_, i) => at(`agile_mangabey_${i.toString(16).padStart(4, '0')}`));
    const spread = spreadInCrowns(troop);
    const placed = troop.map((a) => spread.get(a.id)!);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!, b = placed[j]!;
      expect(Math.hypot(a.x - b.x, a.z - b.z, a.altitudeM - b.altitudeM)).toBeGreaterThan(0.9);
    }
    for (const p of placed) {
      // Within the crown (a canopy tree's is about 16 m across) and among its branches.
      expect(Math.hypot(p.x - 100, p.z - 200)).toBeGreaterThan(1);
      expect(Math.hypot(p.x - 100, p.z - 200)).toBeLessThan(7);
      expect(p.altitudeM).toBeGreaterThan(16); expect(p.altitudeM).toBeLessThan(24);
    }
  });

  it('keeps an animal in the same place from frame to frame, whoever else is in the tree', () => {
    const a = at('agile_mangabey_00a1'), b = at('agile_mangabey_00b2'), c = at('agile_mangabey_00c3');
    const first = spreadInCrowns([a, b, c]).get(a.id)!;
    expect(spreadInCrowns([c, a, b]).get(a.id)).toEqual(first);
    expect(spreadInCrowns([a, b, c]).get(a.id)).toEqual(first);
  });

  it('puts a lone climber out on a limb, not inside the trunk, and names the trunk', () => {
    const lone = spreadInCrowns([at('m1')]).get('m1')!;
    expect(Math.hypot(lone.x - 100, lone.z - 200)).toBeGreaterThan(1);
    expect(lone).toMatchObject({ trunkX: 100, trunkZ: 200 });
  });

  it('leaves alone one climbing the trunk, and keeps animals in different trees in their own', () => {
    const climbing = spreadInCrowns([at('m1', 100, 200, 12, true), at('m2', 100, 200, 20)]);
    expect(climbing.get('m1')).toBeUndefined();
    const apart = spreadInCrowns([at('m1', 100, 200), at('m2', 400, 200)]);
    expect(apart.get('m1')).toMatchObject({ trunkX: 100, trunkZ: 200 });
    expect(apart.get('m2')).toMatchObject({ trunkX: 400, trunkZ: 200 });
  });
});
