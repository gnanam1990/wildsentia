import { describe, expect, it } from 'vitest';
import { bankAngle, leapingClip, MAX_BANK } from '../src/animation.js';

const CLIPS = ['Gallop', 'Gallop_Jump', 'Walk', 'Idle'];

describe('a fleeing duiker bounds', () => {
  it('breaks its gallop with a leap every few seconds, in its own rhythm', () => {
    let leaps = 0, frames = 0;
    for (let t = 0; t < 30; t += 0.05) { frames++; if (leapingClip('fleeing', 'Gallop', CLIPS, 'blue_duiker', t, 123_457, 0.7) === 'Gallop_Jump') leaps++; }
    const share = leaps / frames;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.35);
    // Two duikers do not leap in step.
    const a = [0.2, 0.9, 1.6, 2.3].map((t) => leapingClip('fleeing', 'Gallop', CLIPS, 'blue_duiker', t, 11, 0.7));
    const b = [0.2, 0.9, 1.6, 2.3].map((t) => leapingClip('fleeing', 'Gallop', CLIPS, 'blue_duiker', t, 50_021, 0.7));
    expect(a).not.toEqual(b);
  });
  it('leaves other states, other animals and models without a jump clip alone', () => {
    expect(leapingClip('travelling', 'Gallop', CLIPS, 'blue_duiker', 0, 1, 0.7)).toBeNull();
    expect(leapingClip('fleeing', 'Gallop', CLIPS, 'forest_buffalo', 0, 1, 0.7)).toBeNull();
    expect(leapingClip('fleeing', 'Walk', CLIPS, 'blue_duiker', 0, 1, 0.7)).toBeNull();
    expect(leapingClip('fleeing', 'Gallop', ['Gallop'], 'blue_duiker', 0, 1, 0.7)).toBeNull();
  });
});

describe('a bird on the wing banks into its turns', () => {
  it('tips its inside wing down, more in a sharper turn, never past the limit', () => {
    expect(bankAngle(0)).toBeCloseTo(0);
    expect(bankAngle(0.2)).toBeLessThan(0);
    expect(bankAngle(-0.2)).toBeGreaterThan(0);
    expect(Math.abs(bankAngle(0.4))).toBeGreaterThan(Math.abs(bankAngle(0.1)));
    expect(Math.abs(bankAngle(3))).toBeCloseTo(MAX_BANK);
  });
});
