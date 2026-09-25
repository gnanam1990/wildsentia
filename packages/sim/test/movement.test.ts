import { describe, expect, it } from 'vitest';
import { approachContact } from '../src/agents/movement.js';

const from = { x: 0, z: 0, heading: 0 };
const target = { x: 10, z: 0, heading: 0 };
describe('time-bounded local contact approach', () => {
  it('cannot teleport or overshoot and does not mutate either endpoint', () => {
    const result = approachContact(from, target, 2, 3, 1);
    expect(result).toEqual({ position: { x: 6, z: 0, heading: Math.PI / 2 }, distanceM: 6, seconds: 3, arrived: false });
    const next = approachContact(result.position, target, 2, 3, 1);
    expect(next).toEqual({ position: { x: 9, z: 0, heading: Math.PI / 2 }, distanceM: 3, seconds: 1.5, arrived: true });
    expect(from).toEqual({ x: 0, z: 0, heading: 0 });
    expect(target).toEqual({ x: 10, z: 0, heading: 0 });
  });
  it('uses no time if already within reach, and no distance without time', () => {
    expect(approachContact(from, target, 2, 0, 1)).toMatchObject({ distanceM: 0, seconds: 0, arrived: false });
    expect(approachContact(from, target, 2, 1, 10)).toMatchObject({ distanceM: 0, seconds: 0, arrived: true });
    expect(approachContact(from, from, 2, 1, 0).position).toEqual(from);
  });
  it('rejects invalid inputs instead of producing non-finite world state', () => {
    for (const value of [NaN, Infinity, 0, -1]) expect(() => approachContact(from, target, value, 1, 1)).toThrow();
    for (const value of [NaN, Infinity, -1]) {
      expect(() => approachContact(from, target, 1, value, 1)).toThrow();
      expect(() => approachContact(from, target, 1, 1, value)).toThrow();
    }
    expect(() => approachContact({ ...from, x: -151 }, target, 1, 1, 1)).toThrow();
  });
});
