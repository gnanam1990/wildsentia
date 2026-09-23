import { describe, expect, it } from 'vitest';
import { clipForState } from '../src/animation.js';

const DEER_CLIPS = [
  'Attack_Headbutt', 'Attack_Kick', 'Death', 'Eating', 'Gallop', 'Gallop_Jump',
  'Idle', 'Idle_2', 'Idle_Headlow', 'Idle_HitReact1', 'Idle_HitReact2', 'Jump_toIdle', 'Walk',
];

describe('clipForState', () => {
  it('grazes with the eating clip, not a walk cycle', () => {
    expect(clipForState('grazing', DEER_CLIPS)).toBe('Eating');
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

