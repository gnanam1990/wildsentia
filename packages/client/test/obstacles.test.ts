import { describe, expect, it } from 'vitest';
import { ObstacleField, obstaclesFrom, separateBodies } from '../src/obstacles.js';

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

describe('keeping animals and people apart', () => {
  const body = (id: string, x: number, z: number, radius = 0.5, extra = {}) => ({ id, x, z, radius, heading: 0, ...extra });

  it('draws two overlapping animals apart, the smaller giving way more', () => {
    const out = separateBodies([body('elephant', 0, 0, 1.5), body('hare', 1, 0, 0.3)]);
    const e = out.get('elephant')!, h = out.get('hare')!;
    expect(Math.hypot(h.x - e.x, h.z - e.z)).toBeGreaterThanOrEqual(1.8 - 1e-6);
    expect(Math.abs(e.x)).toBeLessThan(Math.abs(h.x - 1));
  });

  it('separates animals given the very same spot, the same way every frame', () => {
    const a = separateBodies([body('a', 5, 5), body('b', 5, 5)]), b = separateBodies([body('a', 5, 5), body('b', 5, 5)]);
    expect(Math.hypot(a.get('a')!.x - a.get('b')!.x, a.get('a')!.z - a.get('b')!.z)).toBeCloseTo(1);
    expect(a).toEqual(b);
  });

  it('leaves a recorded predator and prey free to meet, and never moves people', () => {
    const out = separateBodies([body('tiger', 0, 0, 0.6, { partnerId: 'sambar' }), body('sambar', 0.5, 0, 0.6, { partnerId: 'tiger' })]);
    expect(out.get('tiger')).toEqual({ x: 0, z: 0 });
    const person = { x: 10, z: 0, radius: 0.35 };
    const boar = separateBodies([body('boar', 10.2, 0, 0.5)], [person]).get('boar')!;
    expect(Math.hypot(boar.x - 10, boar.z)).toBeCloseTo(0.85);
    expect(person).toEqual({ x: 10, z: 0, radius: 0.35 });
  });

  it('leaves animals that are already apart exactly where they were', () => {
    const out = separateBodies([body('a', 0, 0), body('b', 3, 0)], [{ x: -5, z: 0, radius: 0.35 }]);
    expect(out.get('a')).toEqual({ x: 0, z: 0 }); expect(out.get('b')).toEqual({ x: 3, z: 0 });
  });

  it('spreads a crowd at a drinking point so no two bodies overlap', () => {
    const crowd = Array.from({ length: 8 }, (_, i) => body(`c${i}`, Math.cos(i) * 0.4, Math.sin(i) * 0.4, 0.45));
    const out = [...separateBodies(crowd).values()];
    let worst = Infinity;
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++)
      worst = Math.min(worst, Math.hypot(out[i]!.x - out[j]!.x, out[i]!.z - out[j]!.z));
    expect(worst).toBeGreaterThan(0.75); // Three passes: close to the 0.9 m of full clearance.
  });
});
