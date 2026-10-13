import { describe, expect, it } from 'vitest';
import { HOP_DURATION_MS, PositionTracker, patchCentre, subPatchOffset } from '../src/space.js';
import { ISLAND_GRID } from '@vana/shared';

describe('patchCentre', () => {
  it('spaces neighbouring patches by the patch size', () => {
    const a = patchCentre(ISLAND_GRID, 0);
    const b = patchCentre(ISLAND_GRID, 1);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(300, 5);
  });

  it('moves one row for a full grid width', () => {
    expect(patchCentre(ISLAND_GRID, 20).z - patchCentre(ISLAND_GRID, 0).z).toBeCloseTo(300, 5);
  });
});

describe('subPatchOffset', () => {
  it('is stable for an agent id', () => {
    expect(subPatchOffset(ISLAND_GRID, 'sambar_0001')).toEqual(subPatchOffset(ISLAND_GRID, 'sambar_0001'));
  });

  it('differs between agents', () => {
    expect(subPatchOffset(ISLAND_GRID, 'sambar_0001')).not.toEqual(subPatchOffset(ISLAND_GRID, 'sambar_0002'));
  });

  it('spreads sequential herd IDs across both axes instead of drawing a line', () => {
    const offsets = Array.from({ length: 8 }, (_, i) => subPatchOffset(ISLAND_GRID, `elephant_${(0xf82 + i).toString(16)}`));
    for (const axis of ['x', 'z'] as const) {
      const values = offsets.map((p) => p[axis]);
      expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(100);
    }
  });

  it('stays inside the patch', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const o = subPatchOffset(ISLAND_GRID, id);
      expect(Math.abs(o.x)).toBeLessThan(150);
      expect(Math.abs(o.z)).toBeLessThan(150);
    }
  });
});

describe('PositionTracker', () => {
  it('uses server positions without adding an offset and tracks within-patch movement', () => {
    const t = new PositionTracker();
    t.update('a', 0, 0, { x: 3, z: 4, heading: 1 });
    expect(t.positionAt('a', 0)).toEqual({ x: 3, z: 4, heading: 1, moving: false });
    t.update('a', 0, 1000, { x: 13, z: 14, heading: 2 });
    const middle = 1000 + HOP_DURATION_MS / 2;
    expect(t.positionAt('a', middle).x).toBe(8);
    t.update('a', 0, middle, { x: 13, z: 14, heading: 2 });
    expect(t.positionAt('a', middle).x).toBe(8);
    expect(t.positionAt('a', 1000 + HOP_DURATION_MS)).toEqual({ x: 13, z: 14, heading: 2, moving: false });
  });
  it('interpolates an altitude-only checkpoint as movement without turning the animal or restarting descent', () => {
    const t = new PositionTracker();
    const trunk = { x: 10, z: 20, heading: 1.2 };
    t.update('langur', 0, 0, trunk, 0);
    t.update('langur', 0, 1000, trunk, 6);
    const middle = 1000 + HOP_DURATION_MS / 2;
    expect(t.positionAt('langur', middle)).toMatchObject({ x: 10, z: 20,
      heading: 1.2, altitudeM: 3, moving: true });
    expect(t.verticalPhaseAt('langur', middle)).toBe('ascending');
    expect(t.verticalPhaseAt('langur', 1000 + HOP_DURATION_MS)).toBeNull();
    t.update('langur', 0, middle, trunk, 6); // duplicate must not restart the same climb
    expect(t.positionAt('langur', middle).altitudeM).toBe(3);
    t.update('langur', 0, 1000 + HOP_DURATION_MS, trunk); // server clears altitude at ground destination
    const down = 1000 + HOP_DURATION_MS * 1.5;
    expect(t.positionAt('langur', down)).toMatchObject({ altitudeM: 3, moving: true });
    expect(t.verticalPhaseAt('langur', down)).toBe('descending');
    t.update('langur', 0, down, trunk); // absent and zero mean the same ground target
    expect(t.positionAt('langur', down).altitudeM).toBe(3);
    expect(t.positionAt('langur', 1000 + HOP_DURATION_MS * 2)).toMatchObject({ altitudeM: 0, moving: false });
  });
  it('falls back only for missing/invalid server coordinates', () => {
    const t = new PositionTracker();
    t.update('a', 0, 0, { x: NaN, z: 0, heading: 0 });
    expect(t.positionAt('a', 0).x).toBe(subPatchOffset(ISLAND_GRID, 'a').x);
  });
  it('places a newly seen agent immediately, without a slide from the origin', () => {
    const t = new PositionTracker();
    t.update('a', 42, 0);
    const p = t.positionAt('a', 0);
    const centre = patchCentre(ISLAND_GRID, 42);
    const offset = subPatchOffset(ISLAND_GRID, 'a');
    expect(p.x).toBeCloseTo(centre.x + offset.x, 5);
    expect(p.z).toBeCloseTo(centre.z + offset.z, 5);
    expect(p.moving).toBe(false);
  });

  it('eases between patches over the hop duration', () => {
    const t = new PositionTracker();
    t.update('a', 0, 0);
    t.update('a', 1, 1000);

    const start = t.positionAt('a', 1000);
    const middle = t.positionAt('a', 1000 + HOP_DURATION_MS / 2);
    const end = t.positionAt('a', 1000 + HOP_DURATION_MS);

    expect(middle.x).toBeGreaterThan(start.x);
    expect(middle.x).toBeLessThan(end.x);
    expect(middle.moving).toBe(true);
    expect(end.moving).toBe(false);
  });

  it('does not overshoot past the destination', () => {
    const t = new PositionTracker();
    t.update('a', 0, 0);
    t.update('a', 1, 0);
    const far = t.positionAt('a', HOP_DURATION_MS * 5);
    const target = patchCentre(ISLAND_GRID, 1);
    const offset = subPatchOffset(ISLAND_GRID, 'a');
    expect(far.x).toBeCloseTo(target.x + offset.x, 5);
  });

  it('does not teleport when a new patch arrives before the previous interpolation ends', () => {
    const t = new PositionTracker();
    t.update('a', 0, 0); t.update('a', 1, 1000);
    const now = 1000 + HOP_DURATION_MS / 2;
    const before = t.positionAt('a', now);
    t.update('a', 2, now);
    const after = t.positionAt('a', now);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
  });

  it('faces the direction of travel', () => {
    const t = new PositionTracker();
    t.update('a', 0, 0);
    t.update('a', 1, 0);
    expect(t.positionAt('a', HOP_DURATION_MS / 2).heading).toBeCloseTo(Math.PI / 2, 2);
  });

  it('forgets an agent that is no longer reported', () => {
    const t = new PositionTracker();
    t.update('a', 0, 0);
    t.forgetAllExcept(new Set(['b']));
    expect(t.has('a')).toBe(false);
  });

  it('walks a hop over exactly one world hour at whatever speed the server runs', () => {
    // A hop fixed at 150 s suited 24x only. At 12x the animal walked for 150 s and then stood
    // still for 150 s, every hour: stop-go instead of walking.
    const t = new PositionTracker();
    t.setWorldSpeed(12);
    t.update('a', 0, 0);
    t.update('a', 1, 1000);
    expect(t.positionAt('a', 1000 + 150_000).moving).toBe(true);
    expect(t.positionAt('a', 1000 + 300_000).moving).toBe(false);
    t.setWorldSpeed(24);
    t.update('a', 2, 400_000);
    expect(t.positionAt('a', 400_000 + 150_000).moving).toBe(false);
  });
});
