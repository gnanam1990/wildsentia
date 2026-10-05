import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clipForGait, GaitClock, gaitFor, hipHeightM, strideCycles, strideHz, strideLengthM, strideRate } from '../src/gait.js';

const TIGER_CLIPS = ['Death', 'Drinking', 'Eating', 'Gallop', 'Idle', 'Resting', 'Run', 'Sneak', 'Walk'];
const DEER_CLIPS = ['Death', 'Eating', 'Gallop', 'Gallop_Jump', 'Idle', 'Idle_2', 'Idle_Headlow', 'Walk'];
const tigerHip = hipHeightM(1.0), chitalHip = hipHeightM(0.9), elephantHip = hipHeightM(2.7);

/** A clip whose one bone swings through `cycles` full strides. */
function swinging(cycles: number, duration = 1, samples = 61): THREE.AnimationClip {
  const times: number[] = [], values: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t = duration * i / (samples - 1);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5 * Math.sin(2 * Math.PI * cycles * t / duration));
    times.push(t); values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.AnimationClip('Walk', duration, [new THREE.QuaternionKeyframeTrack('leg.quaternion', times, values)]);
}

describe('stride length and rate', () => {
  it('turns a walking tiger over about once a second and a sprinting one more than twice', () => {
    expect(strideHz(1.3, tigerHip)).toBeGreaterThan(0.8);
    expect(strideHz(1.3, tigerHip)).toBeLessThan(1.15);
    // Big cats gallop at roughly 2–2.7 strides a second, covering 4–6 m a stride.
    expect(strideHz(11.8, tigerHip)).toBeGreaterThan(2.0);
    expect(strideHz(11.8, tigerHip)).toBeLessThan(2.8);
    expect(strideLengthM(11.8, tigerHip)).toBeGreaterThan(4);
    expect(strideLengthM(11.8, tigerHip)).toBeLessThan(6);
  });
  it('lets a large animal take longer, slower strides than a small one at the same speed', () => {
    expect(strideHz(1.3, elephantHip)).toBeLessThan(strideHz(1.3, chitalHip));
    expect(strideLengthM(1.3, elephantHip)).toBeGreaterThan(strideLengthM(1.3, chitalHip));
  });
  it('speeds a clip up for a fast animal and holds it within a believable range', () => {
    const gallop = swinging(1, 1);
    expect(strideRate(gallop, 1, 11.8, tigerHip)).toBeGreaterThan(2);
    expect(strideRate(gallop, 1, 60, tigerHip)).toBe(3.2);
    expect(strideRate(gallop, 1, 0.01, tigerHip)).toBe(0.35);
    expect(strideRate(gallop, 1, 0, tigerHip)).toBe(1);
  });
  it('plays a six-second, three-stride walk at the same rate as a two-second, one-stride walk', () => {
    const rate = strideRate(swinging(3, 6), 3, 1.3, elephantHip);
    expect(rate).toBeCloseTo(strideRate(swinging(1, 2), 1, 1.3, elephantHip), 6);
    // The Asian elephants' authored walk already suits their walking pace.
    expect(rate).toBeGreaterThan(0.8);
    expect(rate).toBeLessThan(1.25);
  });
});

describe('strideCycles', () => {
  it('reads how many strides a clip holds from its own motion', () => {
    expect(strideCycles(swinging(1))).toBe(1);
    expect(strideCycles(swinging(3, 6))).toBe(3);
    expect(strideCycles(new THREE.AnimationClip('Idle', 2, []))).toBe(1);
  });
});

describe('gait choice', () => {
  it('walks, trots and gallops at the Froude numbers quadrupeds change gait', () => {
    expect(gaitFor(1.3, tigerHip)).toBe('walk');
    expect(gaitFor(3.5, tigerHip)).toBe('trot');
    expect(gaitFor(11.8, tigerHip)).toBe('gallop');
  });
  it('does not flicker between gaits at a transition speed', () => {
    const edge = Math.sqrt(2.5 * 9.81 * tigerHip);
    expect(gaitFor(edge, tigerHip, 'trot')).toBe('trot');
    expect(gaitFor(edge, tigerHip, 'gallop')).toBe('gallop');
  });
  it('gallops a chasing tiger flat out, not its trot, and walks it while it is still slow', () => {
    expect(clipForGait('chasing', 'gallop', TIGER_CLIPS)).toBe('Gallop');
    expect(clipForGait('chasing', 'trot', TIGER_CLIPS)).toBe('Run');
    expect(clipForGait('chasing', 'walk', TIGER_CLIPS)).toBe('Walk');
    expect(clipForGait('fleeing', 'gallop', DEER_CLIPS)).toBe('Gallop');
    expect(clipForGait('fleeing', 'trot', DEER_CLIPS)).toBe('Walk');
  });
  it('leaves a stalk, a still animal and non-moving states to their own clips', () => {
    expect(clipForGait('stalking', 'gallop', TIGER_CLIPS)).toBeNull();
    expect(clipForGait('chasing', null, TIGER_CLIPS)).toBeNull();
    expect(clipForGait('grazing', 'walk', TIGER_CLIPS)).toBeNull();
    expect(clipForGait('chasing', 'gallop', ['Idle', 'Fly'])).toBeNull();
  });
});

describe('GaitClock', () => {
  it('measures shown speed from drawn positions and picks the gait', () => {
    const clock = new GaitClock();
    for (let i = 0; i <= 60; i++) clock.observe(11.8 * i / 60, 0, i / 60, tigerHip);
    expect(clock.speedMs).toBeGreaterThan(11);
    expect(clock.speedMs).toBeLessThan(12.5);
    expect(clock.gait).toBe('gallop');
  });
  it('treats a jump in position or time as a fresh start, not a sprint', () => {
    const clock = new GaitClock();
    clock.observe(0, 0, 0, tigerHip);
    clock.observe(0.02, 0, 1 / 60, tigerHip);
    clock.observe(500, 0, 2 / 60, tigerHip);
    expect(clock.speedMs).toBe(0);
    expect(clock.gait).toBeNull();
    clock.observe(500, 0, 10, tigerHip);
    expect(clock.speedMs).toBe(0);
  });
  it('advances the stride clock by the observed interval and wraps it to the clip', () => {
    const clock = new GaitClock();
    clock.observe(0, 0, 0, tigerHip);
    clock.observe(0.2, 0, 0.1, tigerHip);
    expect(clock.advance(2, 1)).toBeCloseTo(0.2, 6);
    for (let i = 0; i < 6; i++) clock.advance(2, 1);
    expect(clock.clipSeconds).toBeGreaterThanOrEqual(0);
    expect(clock.clipSeconds).toBeLessThan(1);
    // A paused replay (no time passing) holds the pose.
    clock.observe(0.2, 0, 0.1, tigerHip);
    const held = clock.clipSeconds;
    expect(clock.advance(2, 1)).toBe(held);
  });
});
