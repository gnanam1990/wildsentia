import { describe, expect, it } from 'vitest';
import { isMovementTrace, movementAt, type MovementTrace } from '../src/movement.js';

const p = (x: number, z: number, heading = 0) => ({ x, z, heading });
const route = (): MovementTrace => ({ version: 1, actorId: 's', startWorldTime: 0, destinationPatchId: 0,
  goal: 'find_water', completed: true, samples: [
    { seconds: 0, position: p(0, 0) }, { seconds: 10, position: p(100, 0) },
    { seconds: 30, position: p(100, 100, 1) },
  ] });
describe('recorded route interpolation', () => {
  it('retains interrupted flight altitude at/beyond the endpoint and before the trace starts', () => {
    const t = route(); t.completed = false;
    t.samples = [{ seconds: 0, position: p(0, 0, 1), altitudeM: 12 },
      { seconds: 10, position: p(100, 0, 1), altitudeM: 40 }];
    expect(movementAt(t, -1)).toEqual({ ...p(0, 0, 1), moving: false, altitudeM: 12 });
    expect(movementAt(t, 5).altitudeM).toBe(26);
    for (const time of [10, 11, 3600]) expect(movementAt(t, time)).toEqual({ ...p(100, 0, 1), moving: false, altitudeM: 40 });
    t.samples = [t.samples[1]!]; t.samples[0]!.seconds = 0;
    expect(movementAt(t, 0).altitudeM).toBe(40);
  });
  it('interpolates vertical movement without changing heading and treats omitted height as ground', () => {
    const t = route(); t.samples = [{ seconds: 0, position: p(0, 0, 1), altitudeM: 12 },
      { seconds: 10, position: p(0, 0, 1) }];
    expect(movementAt(t, 5)).toEqual({ ...p(0, 0, 1), moving: true, altitudeM: 6 });
    expect(movementAt(t, 10)).toEqual({ ...p(0, 0, 1), moving: false });
  });
  it('preserves turns, section speed, exact endpoints and heading without easing the route', () => {
    const t = route(); expect(isMovementTrace(t)).toBe(true);
    expect(movementAt(t, 5)).toEqual({ ...p(50, 0, Math.PI / 2), moving: true });
    expect(movementAt(t, 10)).toEqual({ ...p(100, 0), moving: true });
    expect(movementAt(t, 20)).toEqual({ ...p(100, 50), moving: true });
    expect(movementAt(t, 30)).toEqual({ ...p(100, 100, 1), moving: false });
    expect(movementAt(t, 100)).toEqual(movementAt(t, 30));
    expect(movementAt(t, -1)).toEqual({ ...p(0, 0), moving: false });
  });
  it('accepts stationary and unfinished routes without pretending they arrived', () => {
    const t = route(); t.completed = false; t.destinationPatchId = 399;
    t.samples = [t.samples[0]!];
    expect(isMovementTrace(t)).toBe(true);
    expect(movementAt(t, 0).moving).toBe(false);
    t.completed = true; expect(isMovementTrace(t)).toBe(false);
  });
  it('rejects malformed, out-of-world, duplicate/reversed timestamps and excessive payloads', () => {
    const mutate = (fn: (t: MovementTrace) => void) => { const t = route(); fn(t); expect(isMovementTrace(t)).toBe(false); };
    mutate((t) => { t.samples[1]!.seconds = 0; });
    mutate((t) => { t.samples[2]!.seconds = 9; });
    mutate((t) => { t.samples[2]!.seconds = 3601; });
    mutate((t) => { t.samples[0]!.seconds = 1; });
    mutate((t) => { t.samples[1]!.position.x = Infinity; });
    mutate((t) => { t.samples[1]!.position.z = 99999; });
    mutate((t) => { t.startWorldTime = NaN; });
    mutate((t) => { t.destinationPatchId = -1; });
    mutate((t) => { t.samples = Array(2049).fill(t.samples[0]); });
    expect(() => movementAt(route(), NaN)).toThrow('invalid movement playhead');
    expect(isMovementTrace(null)).toBe(false);
    expect(isMovementTrace({ ...route(), goal: 'user-command' })).toBe(false);
  });
});
