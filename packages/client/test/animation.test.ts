import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { actClipTime, clipPhase, climbPose, climbs, struggleClip, CLIMB_TRUNK_CLEARANCE_M, clipForClimbPhase, clipForObservedMotion, clipForState, elephantTrunkReach, renderStateFor, vigilance } from '../src/animation.js';

const DEER_CLIPS = [
  'Attack_Headbutt', 'Attack_Kick', 'Death', 'Eating', 'Gallop', 'Gallop_Jump',
  'Idle', 'Idle_2', 'Idle_Headlow', 'Idle_HitReact1', 'Idle_HitReact2', 'Jump_toIdle', 'Walk',
];

describe('clipForState', () => {
  it('uses recorded vulture ascent/descent for Flap and level flight for Glide only', () => {
    const clips = ['Idle', 'Walk', 'Flap', 'Glide'];
    expect(clipForObservedMotion('travelling', clips, 'ascending')).toBe('Flap');
    expect(clipForObservedMotion('travelling', clips, 'gliding')).toBe('Glide');
    expect(clipForObservedMotion('travelling', clips, 'descending')).toBe('Flap');
    expect(clipForObservedMotion('travelling', clips)).toBe('Walk');
    expect(clipForObservedMotion('travelling', clips, null, true)).toBeNull();
    expect(clipForObservedMotion('travelling', ['Idle', 'Walk'], 'ascending')).toBeNull();
  });
  it('uses a real climb clip if present, else the walk cycle as gripping on the upright body, else idle', () => {
    expect(clipForClimbPhase('ascending', ['Walk', 'Idle', 'ClimbUp'])).toBe('ClimbUp');
    expect(clipForClimbPhase('descending', ['Walk', 'Idle', 'ClimbDown'])).toBe('ClimbDown');
    expect(clipForObservedMotion('travelling', ['Idle', 'Walk'], null, false, 'ascending')).toBe('Walk');
    expect(clipForObservedMotion('travelling', ['Idle'], null, false, 'descending')).toBe('Idle');
    expect(clipForObservedMotion('fleeing', ['Walk', 'Run'], null, false, 'descending')).toBe('Walk');
    expect(clipForObservedMotion('fleeing', ['Run'], null, false, 'descending')).toBeNull();
    expect(clipForObservedMotion('travelling', ['Idle', 'Walk'], null, true)).toBeNull();
    expect(clipForObservedMotion('travelling', ['Idle', 'Walk'])).toBe('Walk');
  });
  it('prefers locally authored state-specific clips', () => {
    const clips = ['Idle', 'Walk', 'Gallop', 'Run', 'Sneak', 'Drinking', 'Eating', 'Injured'];
    expect(clipForState('stalking', clips)).toBe('Sneak');
    expect(clipForState('chasing', clips)).toBe('Run');
    expect(clipForState('fleeing', clips)).toBe('Run');
    expect(clipForState('drinking', clips)).toBe('Drinking');
    expect(clipForState('injured', clips)).toBe('Injured');
  });
  it('preserves authoritative hunt and death states while the animal is moving', () => {
    for (const state of ['stalking', 'chasing', 'fleeing', 'dead']) expect(renderStateFor(state, true)).toBe(state);
    expect(renderStateFor('dead', false)).toBe('dead');
    expect(renderStateFor('grazing', true)).toBe('travelling');
    expect(renderStateFor('grazing', false)).toBe('grazing');
  });
  it('stands an animal that is not covering ground, instead of walking or running on the spot', () => {
    // Between two live hours every animal still carries its saved "travelling" or "fleeing"
    // state while it stands where it arrived; a stride clip then plays on a motionless body.
    for (const state of ['travelling', 'stalking', 'chasing', 'fleeing']) {
      expect(renderStateFor(state, false)).toBe('standing');
      expect(clipForState(renderStateFor(state, false), DEER_CLIPS)).toBe('Idle');
      expect(clipForState(renderStateFor(state, false), ['Idle', 'Walk', 'Run', 'Resting'])).toBe('Idle');
    }
  });
  it('grazes with the eating clip, not a walk cycle', () => {
    expect(clipForState('grazing', DEER_CLIPS)).toBe('Eating');
  });

  it('uses a closed, illustrative trunk-ground reach when detailed elephant has no eating clip', () => {
    const source = new THREE.AnimationClip('SprayWater', 1, [
      new THREE.NumberKeyframeTrack('trunk.position[y]', [0, .28, 1], [1, 0, 1]),
    ]);
    const reach = elephantTrunkReach(source);
    expect(reach.name).toBe('TrunkReach');
    expect(clipForState('grazing', ['Idle', reach.name])).toBe('TrunkReach');
    expect(clipForState('drinking', ['Idle', reach.name])).toBe('TrunkReach');
    const track = reach.tracks[0]!;
    expect(track.values[0]).toBeCloseTo(track.values.at(-1)!, 6);
    expect(Math.min(...track.values)).toBeCloseTo(0, 2);
    expect(Array.from(track.values).every(Number.isFinite)).toBe(true);
  });

  it('travels with walk', () => {
    expect(clipForState('travelling', DEER_CLIPS)).toBe('Walk');
  });

  it('rests with idle', () => {
    expect(clipForState('resting', DEER_CLIPS)).toBe('Idle');
  });

  it('drinks with a head-down clip when one exists', () => {
    expect(clipForState('drinking', DEER_CLIPS)).toBe('Idle_Headlow');
  });

  it('uses the death clip when dead', () => {
    expect(clipForState('dead', DEER_CLIPS)).toBe('Death');
    expect(clipForState('dead', ['Idle', 'Walk'])).toBeNull();
  });

  it('falls back through the preference list when the preferred clip is absent', () => {
    expect(clipForState('drinking', ['Idle', 'Walk'])).toBe('Idle');
    expect(clipForState('grazing', ['Idle', 'Walk'])).toBe('Idle');
  });

  it('returns null rather than guessing when nothing matches', () => {
    expect(clipForState('grazing', [])).toBeNull();
    expect(clipForState('grazing', ['SomeUnrelatedClip'])).toBeNull();
  });

  it('matches clip names case-insensitively', () => {
    expect(clipForState('travelling', ['walk'])).toBe('walk');
  });

  it('handles an unknown server state by idling', () => {
    expect(clipForState('brooding', DEER_CLIPS)).toBe('Idle');
  });

  it('has a clip for every state the simulation reports, hunting and feeding included', () => {
    // Stalking, chasing and feeding had no entry, so a hunting tiger played whatever it last had.
    const FOX_CLIPS = ['Attack', 'Death', 'Eating', 'Gallop', 'Idle', 'Idle_2_HeadLow', 'Walk'];
    expect(clipForState('stalking', FOX_CLIPS)).toBe('Walk');
    expect(clipForState('chasing', FOX_CLIPS)).toBe('Gallop');
    expect(clipForState('feeding', FOX_CLIPS)).toBe('Eating');
    expect(clipForState('drinking', FOX_CLIPS)).toBe('Idle_2_HeadLow');
  });

  it('matches clip names whatever their case, as packs name them differently', () => {
    expect(clipForState('travelling', ['idle', 'walk', 'dead'])).toBe('walk');
    expect(clipForState('dead', ['idle', 'walk', 'dead'])).toBe('dead');
  });
});

describe('climbPose', () => {
  it('stands a climber upright against its trunk, belly to the bark, hind feet at the recorded height', () => {
    expect(climbPose('langur', null, 0.8)).toEqual({ pitch: 0, back: 0, lift: 0 });
    expect(climbPose('langur', 'ascending', 0.8)).toEqual({ pitch: -Math.PI / 2, back: -CLIMB_TRUNK_CLEARANCE_M, lift: 0.4 });
    // Langurs come down tail first, head still up; squirrels come down head first.
    expect(climbPose('langur', 'descending', 0.8).pitch).toBe(-Math.PI / 2);
    expect(climbPose('squirrel', 'descending', 0.4)).toEqual({ pitch: Math.PI / 2, back: CLIMB_TRUNK_CLEARANCE_M, lift: 0.2 });
  });
});

describe('vigilance', () => {
  const share = (seed: number, state = 'drinking') => {
    let up = 0; const n = 6000;
    for (let i = 0; i < n; i++) up += vigilance(state, i * 0.05, seed);
    return up / n;
  };
  it('has a drinking or grazing animal lift its head to look round for part of the time', () => {
    for (const seed of [1, 77, 4021, 99991]) {
      expect(share(seed)).toBeGreaterThan(0.12);
      expect(share(seed)).toBeLessThan(0.35);
      expect(share(seed, 'grazing')).toBeGreaterThan(0.12);
    }
  });
  it('never looks up while resting, travelling or dead', () => {
    for (const state of ['resting', 'travelling', 'dead', 'chasing']) expect(share(5, state)).toBe(0);
  });
  it('raises and lowers the head smoothly, never in one frame', () => {
    for (let i = 1; i < 6000; i++) expect(Math.abs(vigilance('drinking', i / 60, 321) - vigilance('drinking', (i - 1) / 60, 321))).toBeLessThan(0.05);
  });
  it('keeps neighbours out of step', () => {
    let same = 0;
    for (let i = 0; i < 2000; i++) if ((vigilance('drinking', i * 0.1, 11) > 0.5) === (vigilance('drinking', i * 0.1, 12345) > 0.5)) same++;
    expect(same / 2000).toBeLessThan(0.9);
  });
});

describe('clipPhase', () => {
  it('starts each animal at its own point in a clip, so a herd does not move in unison', () => {
    const phases = [1, 2, 3, 4, 5, 1000, 31337].map((seed) => clipPhase(seed, 2));
    expect(new Set(phases.map((p) => p.toFixed(3))).size).toBe(phases.length);
    for (const p of phases) { expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThan(2); }
  });
});

describe('hunt act clips', () => {
  it('fits the spring to its window, plays a stagger or fall once, and loops a hold', () => {
    expect(actClipTime('pouncing', 0.8, 0.35)).toBeCloseTo(0.4);
    expect(actClipTime('pouncing', 0.8, 5)).toBe(0.8);
    expect(actClipTime('falling', 1, 0.3)).toBeCloseTo(0.3);
    expect(actClipTime('falling', 1, 4)).toBe(1);
    expect(actClipTime('holding', 2, 5)).toBeCloseTo(1);
  });
  it('makes a struggle from the animal\'s own death pose, kicking its legs about their gait swing axis', () => {
    const axisX = new THREE.Vector3(1, 0, 0);
    const q = (angle: number, axis = axisX) => new THREE.Quaternion().setFromAxisAngle(axis, angle).toArray();
    const lying = q(1.2, new THREE.Vector3(0, 0, 1));
    const death = new THREE.AnimationClip('Death', 1, [
      new THREE.QuaternionKeyframeTrack('FrontUpperLeg.L.quaternion', [0, 1], [...q(0), ...lying]),
      new THREE.QuaternionKeyframeTrack('Torso.quaternion', [0, 1], [...q(0), ...lying]),
      new THREE.VectorKeyframeTrack('Body.position', [0, 1], [0, 1, 0, 0, 0.3, 0]),
    ]);
    const gait = new THREE.AnimationClip('Gallop', 1, [
      new THREE.QuaternionKeyframeTrack('FrontUpperLeg.L.quaternion', [0, 0.25, 0.5, 0.75, 1],
        [...q(0), ...q(0.5), ...q(0), ...q(-0.5), ...q(0)]),
    ]);
    const clip = struggleClip(death, gait);
    expect(clip.name).toBe('Struggle');
    const leg = clip.tracks.find((t) => t.name === 'FrontUpperLeg.L.quaternion')!;
    const torso = clip.tracks.find((t) => t.name === 'Torso.quaternion')!;
    const body = clip.tracks.find((t) => t.name === 'Body.position')!;
    const at = (track: THREE.KeyframeTrack, i: number) => new THREE.Quaternion().fromArray(track.values as unknown as number[], i * 4);
    const base = new THREE.Quaternion().fromArray(lying);
    let kick = 0;
    for (let i = 0; i < leg.times.length; i++) {
      const rel = base.clone().invert().multiply(at(leg, i));
      kick = Math.max(kick, base.angleTo(at(leg, i)));
      // The kick is about the leg's own swing axis (x), on top of the lying pose.
      if (rel.lengthSq() > 0 && Math.abs(rel.w) < 0.9999) expect(Math.abs(new THREE.Vector3(rel.x, rel.y, rel.z).normalize().x)).toBeGreaterThan(0.99);
    }
    expect(kick).toBeGreaterThan(0.3);
    for (let i = 0; i < torso.times.length; i++) expect(at(torso, i).angleTo(base)).toBeLessThan(1e-5);
    expect(Array.from(body.values.slice(0, 3))).toEqual([0, expect.closeTo(0.3, 6), 0]);
  });
  it('kicks the big-cat rig\'s limbs too, by their names as three.js loads them (dots dropped)', () => {
    const q = (angle: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle).toArray();
    const limbs = ['scapulaL', 'upperarmR', 'forearmL', 'handR', 'fingersL', 'thighR', 'shinL', 'footR', 'toesL'];
    const death = new THREE.AnimationClip('Death', 1, limbs.map((b) => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, [0, 1], [...q(0), ...q(0)])));
    const gait = new THREE.AnimationClip('Gallop', 1, limbs.map((b) => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, [0, 0.25, 0.5, 0.75, 1],
      [...q(0), ...q(0.5), ...q(0), ...q(-0.5), ...q(0)])));
    const clip = struggleClip(death, gait);
    for (const b of limbs) {
      const track = clip.tracks.find((t) => t.name === `${b}.quaternion`)!;
      const kick = Math.max(...Array.from({ length: track.times.length }, (_, i) => new THREE.Quaternion().angleTo(new THREE.Quaternion().fromArray(track.values as unknown as number[], i * 4))));
      expect(kick, b).toBeGreaterThan(0.3);
    }
  });
});

describe('leopard climbing', () => {
  it('treats the leopard as a climber that, like a squirrel, comes down its tree head first', () => {
    expect(climbs('leopard')).toBe(true);
    expect(climbs('tiger')).toBe(false);
    expect(climbPose('leopard', 'descending', 1.4)).toEqual(climbPose('squirrel', 'descending', 1.4));
    expect(climbPose('leopard', 'ascending', 1.4)).toEqual(climbPose('langur', 'ascending', 1.4));
    expect(climbPose('leopard', 'descending', 1.4).pitch).toBeGreaterThan(0);
  });
});
