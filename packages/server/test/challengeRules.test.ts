import { describe, expect, it } from 'vitest';
import { HERD_GRACE_MS, RuleWatch, type RuleView } from '../src/challenges/rules.js';

const view = (over: Partial<RuleView> = {}): RuleView =>
  ({ position: { x: 0, z: 0 }, gait: 'walk', moving: true, nearestKinM: 10, ...over });

describe('rule watch', () => {
  it('breaks a zone just outside its radius', () => {
    const w = new RuleWatch([{ type: 'zone', x: 100, z: 0, radiusM: 200 }]);
    expect(w.check(view({ position: { x: 300, z: 0 } }), 0)).toBeNull();
    expect(w.check(view({ position: { x: 300.5, z: 0 } }), 0)).toBe('rule_zone');
  });

  it('breaks "never run" only while moving at a run', () => {
    const w = new RuleWatch([{ type: 'noRun' }]);
    expect(w.check(view({ gait: 'trot' }), 0)).toBeNull();
    expect(w.check(view({ gait: 'run', moving: false }), 0)).toBeNull();
    expect(w.check(view({ gait: 'run' }), 0)).toBe('rule_no_run');
  });

  it("counts a committed hunt's sprint as running", () => {
    // The hunt loop sets the avatar's gait to run while it charges; the engine's view reports it as is.
    const w = new RuleWatch([{ type: 'noRun' }]);
    expect(w.check({ position: { x: 5, z: 5 }, gait: 'run', moving: true, nearestKinM: null }, 0)).toBe('rule_no_run');
  });

  it('catches a sprint that began and ended between two checks', () => {
    const w = new RuleWatch([{ type: 'noRun' }]);
    expect(w.check(view({ gait: 'walk', moving: false, sprinted: true }), 0)).toBe('rule_no_run');
    expect(new RuleWatch([]).check(view({ sprinted: true }), 0)).toBeNull();
  });

  it('catches a command to run under "never run" the moment it is given', () => {
    expect(new RuleWatch([{ type: 'noRun' }]).commandBreaks('move', { gait: 'run' })).toBe('rule_no_run');
    expect(new RuleWatch([{ type: 'noRun' }]).commandBreaks('move', { gait: 'trot' })).toBeNull();
    expect(new RuleWatch([]).commandBreaks('move', { gait: 'run' })).toBeNull();
  });

  it('allows a minute apart from the herd, and rejoining resets the clock', () => {
    const w = new RuleWatch([{ type: 'herd', maxDistanceM: 50 }]);
    expect(w.herdDistance()).toBe(50);
    expect(w.check(view({ nearestKinM: 80 }), 0)).toBeNull();
    expect(w.check(view({ nearestKinM: null }), HERD_GRACE_MS)).toBeNull();
    expect(w.check(view({ nearestKinM: 40 }), HERD_GRACE_MS + 1)).toBeNull();
    expect(w.check(view({ nearestKinM: 80 }), HERD_GRACE_MS + 2)).toBeNull();
    expect(w.check(view({ nearestKinM: 80 }), 2 * HERD_GRACE_MS + 2)).toBeNull();
    expect(w.check(view({ nearestKinM: 80 }), 2 * HERD_GRACE_MS + 3)).toBe('rule_herd');
    expect(new RuleWatch([]).herdDistance()).toBeNull();
  });
});
