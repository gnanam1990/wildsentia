import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { climbPose, CLIMB_TRUNK_CLEARANCE_M, clipForClimbPhase, clipForObservedMotion, clipForState, elephantTrunkReach, renderStateFor } from '../src/animation.js';

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
