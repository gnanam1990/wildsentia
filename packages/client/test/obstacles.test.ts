import { describe, expect, it } from 'vitest';
import { ObstacleField, obstaclesFrom } from '../src/obstacles.js';

describe('walking round trunks and boulders', () => {
  it('takes trunks and boulders from the plan, and ignores grass, bushes and pebbles', () => {
    const plan = new Map([
      ['CommonTree_2', [{ x: 0, y: 0, z: 0, rotY: 0, scale: 2 }]],
      ['Boulder_Large', [{ x: 20, y: 0, z: 0, rotY: 0, scale: 3 }]],
      ['Stone_Small', [{ x: 5, y: 0, z: 0, rotY: 0, scale: 0.2 }]],
      ['Bush_Common', [{ x: 9, y: 0, z: 0, rotY: 0, scale: 1 }]],
      ['Grass_Common_Tall', [{ x: 7, y: 0, z: 0, rotY: 0, scale: 0.5 }]],
    ]);
    const obstacles = obstaclesFrom(plan);
    expect(obstacles).toEqual([{ x: 0, z: 0, radius: 0.44 }, { x: 20, z: 0, radius: 3 }]);
  });

  it('leaves a clear position alone and steps one inside an obstacle sideways to its edge', () => {
    const field = new ObstacleField([{ x: 0, z: 0, radius: 1 }]);
    expect(field.deflect(5, 5, 0.5, 0)).toEqual({ x: 5, z: 5 });
    // Walking along +z (heading 0) level with the trunk: stepped along x only, to the edge.
    const out = field.deflect(0.3, 0, 0.5, 0);
    expect(out.z).toBeCloseTo(0); expect(Math.hypot(out.x, out.z)).toBeCloseTo(1.5);
    const centre = field.deflect(0, 0, 0.5, 0);
    expect(Number.isFinite(centre.x) && Math.hypot(centre.x, centre.z)).toBeCloseTo(1.5);
  });

  it('bends a head-on or glancing walk round a trunk without a jump', () => {
    const field = new ObstacleField([{ x: 0, z: 0, radius: 1 }]);
    for (const lateral of [0, 0.2, -0.7, 1.4]) {
      for (const heading of [Math.PI / 2, 0.4]) {
        const fx = Math.sin(heading), fz = Math.cos(heading), step = 0.05;
        let previous: { x: number; z: number } | null = null;
        for (let s = -4; s <= 4; s += step) {
          const x = fx * s + fz * lateral, z = fz * s - fx * lateral;
          const at = field.deflect(x, z, 0.5, heading);
          expect(Math.hypot(at.x, at.z)).toBeGreaterThanOrEqual(1.5 - 1e-9);
          if (previous) expect(Math.hypot(at.x - previous.x, at.z - previous.z)).toBeLessThan(step * 1.3);
          previous = at;
        }
      }
    }
  });

  it('settles between two neighbouring obstacles and finds ones across cell borders', () => {
    const field = new ObstacleField([{ x: 7.9, z: 0, radius: 1 }, { x: 10.5, z: 0, radius: 1 }]);
    const at = field.deflect(8.1, 0.1, 0.3, 0);
    expect(Math.hypot(at.x - 7.9, at.z)).toBeGreaterThanOrEqual(1.3 - 1e-9);
    expect(field.size).toBe(2);
  });
});
