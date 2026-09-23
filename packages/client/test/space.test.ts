import { describe, expect, it } from 'vitest';
import { HOP_DURATION_MS, PositionTracker, patchCentre, subPatchOffset } from '../src/space.js';

describe('patchCentre', () => {
  it('spaces neighbouring patches by the patch size', () => {
    const a = patchCentre(0);
    const b = patchCentre(1);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(300, 5);
  });

  it('moves one row for a full grid width', () => {
    expect(patchCentre(20).z - patchCentre(0).z).toBeCloseTo(300, 5);
  });
});

describe('subPatchOffset', () => {
  it('is stable for an agent id', () => {
    expect(subPatchOffset('sambar_0001')).toEqual(subPatchOffset('sambar_0001'));
  });

  it('differs between agents', () => {
    expect(subPatchOffset('sambar_0001')).not.toEqual(subPatchOffset('sambar_0002'));
  });

  it('stays inside the patch', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const o = subPatchOffset(id);
      expect(Math.abs(o.x)).toBeLessThan(150);
      expect(Math.abs(o.z)).toBeLessThan(150);
    }
  });
});

describe('PositionTracker', () => {
  it('places a newly seen agent immediately, without a slide from the origin', () => {
    const t = new PositionTracker();
    t.update('a', 42, 0);
    const p = t.positionAt('a', 0);
    const centre = patchCentre(42);
    const offset = subPatchOffset('a');
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
    const target = patchCentre(1);
    const offset = subPatchOffset('a');
    expect(far.x).toBeCloseTo(target.x + offset.x, 5);
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

