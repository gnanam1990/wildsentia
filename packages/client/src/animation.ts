/**
 * Maps a server-reported agent state to an animation clip, in order of preference.
 *
 * A model lacking the preferred clip falls back down the list; a model matching nothing gets
 * null, and the caller stops the previous clip. An animal
 * must never play a walk cycle while the server says it is grazing — that mismatch between
 * shown behaviour and actual state is the defect this module exists to prevent.
 */
import * as THREE from 'three';

export const CLIP_PREFERENCES: Record<string, readonly string[]> = {
  resting:    ['Resting', 'Idle', 'Idle_2'],
  grazing:    ['Eating', 'TrunkReach', 'Idle_Headlow', 'Idle_2_HeadLow', 'Idle'],
  drinking:   ['Drinking', 'TrunkReach', 'Idle_Headlow', 'Idle_2_HeadLow', 'Eating', 'Idle'],
  travelling: ['Walk', 'Gallop', 'Idle'],
  // A stalk is a slow, deliberate walk; a chase and a flight are flat out.
  stalking:   ['Sneak', 'Walk', 'Idle'],
  chasing:    ['Run', 'Gallop', 'Walk', 'Idle'],
  fleeing:    ['Run', 'Gallop', 'Walk', 'Idle'],
  feeding:    ['Eating', 'TrunkReach', 'Idle_Headlow', 'Idle_2_HeadLow', 'Idle'],
  dead:       ['Death', 'Dead'],
  injured:    ['Injured', 'Idle_HitReact1', 'Idle'],
};

/** Visual-only grounded reach from the licensed elephant's existing SprayWater
 * start to its recorded trunk-to-ground sample and back. It is not a claim of
 * mouth contact or a simulated feeding/drinking outcome. */
export function elephantTrunkReach(source: THREE.AnimationClip): THREE.AnimationClip {
  const down = 0.28, hold = 0.42, duration = down * 2 + hold, fps = 30;
  if (source.name !== 'SprayWater' || source.duration < down) throw new Error('Expected elephant SprayWater source clip');
  const steps = Math.ceil(duration * fps);
  const times = Float32Array.from({ length: steps + 1 }, (_, i) => duration * i / steps);
  const tracks = source.tracks.map(track => {
    const interpolant = track.createInterpolant();
    const width = track.getValueSize();
    const values = new Float32Array(times.length * width);
    for (let i = 0; i < times.length; i++) {
      const time = times[i]!;
      const fromSource = time < down ? time : time < down + hold ? down : Math.max(0, duration - time);
      values.set(interpolant.evaluate(fromSource), i * width);
    }
    const copy = track.clone();
    copy.times = times.slice(); copy.values = values;
    return copy;
  });
  return new THREE.AnimationClip('TrunkReach', duration, tracks);
}

/** Visual slope of a saved flight trace, never a client-authored movement outcome. */
export type FlightVisualPhase = 'ascending' | 'gliding' | 'descending';
export type ClimbVisualPhase = 'ascending' | 'descending';

/** The local vulture has Flap and Glide, but no separate takeoff or landing clips. */
export function clipForFlightPhase(phase: FlightVisualPhase, availableClips: readonly string[]): string | null {
  const wanted = phase === 'gliding' ? 'Glide' : 'Flap';
  return availableClips.find(clip => clip.toLowerCase() === wanted.toLowerCase()) ?? null;
}

/**
 * A real climbing clip is preferred. The local rigs have none, so the walk cycle, played with the
 * body turned upright against the trunk (see climbPose), stands in for hand-over-hand gripping.
 */
export function clipForClimbPhase(phase: ClimbVisualPhase, availableClips: readonly string[]): string | null {
  const choices = phase === 'ascending' ? ['ClimbUp', 'Climb_Up', 'Climb', 'Walk', 'Idle']
    : ['ClimbDown', 'Climb_Down', 'Climb', 'Walk', 'Idle'];
  for (const wanted of choices) {
    const found = availableClips.find((clip) => clip.toLowerCase() === wanted.toLowerCase());
    if (found) return found;
  }
  return null;
}

/** Missing altitude context must not turn an unknown flight interval into walking or wingbeats. */
export function clipForObservedMotion(state: string, availableClips: readonly string[],
  flightPhase: FlightVisualPhase | null = null, unknownAirborne = false,
  climbPhase: ClimbVisualPhase | null = null): string | null {
  if (unknownAirborne) return null;
  if (flightPhase !== null) return clipForFlightPhase(flightPhase, availableClips);
  if (climbPhase !== null) return clipForClimbPhase(climbPhase, availableClips);
  return clipForState(state, availableClips);
}

const FALLBACK: readonly string[] = ['Idle'];

/** A replay seek samples a pose directly; a corpse must not freeze on frame zero of Death. */
export function replayClipTime(state: string, duration: number, seconds: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(seconds)) return 0;
  return state === 'dead' ? duration : ((seconds % duration) + duration) % duration;
}

/** Keep chase/stalk/death semantics even while interpolating between server patches. */
export function renderStateFor(state: string, moving: boolean): string {
  if (['dead', 'chasing', 'fleeing', 'stalking'].includes(state)) return state;
  return moving ? 'travelling' : state;
}

export function clipForState(state: string, availableClips: readonly string[]): string | null {
  const preferences = CLIP_PREFERENCES[state] ?? FALLBACK;
  for (const wanted of preferences) {
    const match = availableClips.find((clip) => clip.toLowerCase() === wanted.toLowerCase());
    if (match !== undefined) return match;
  }
  return null;
}

/** Trunk radius the climber is held clear of; drawn anchor trees are broadleaf trunks of about this size. */
export const CLIMB_TRUNK_CLEARANCE_M = 0.32;

/**
 * How a climbing langur or squirrel is turned on its trunk. The model faces +Z (its belly -Y);
 * pitched upright, the belly faces the trunk ahead, the body is lifted so its hind feet are at the
 * recorded altitude, and it is held one trunk radius out from the trunk's centre. Langurs come
 * down tail first (head still up); squirrels come down head first.
 */
export function climbPose(speciesId: string, phase: ClimbVisualPhase | null, bodyLengthM: number):
  { pitch: number; back: number; lift: number } {
  if (phase === null) return { pitch: 0, back: 0, lift: 0 };
  const headFirstDown = phase === 'descending' && speciesId === 'squirrel';
  return headFirstDown
    // Head down turns the belly backwards, so the body is held out on the other side.
    ? { pitch: Math.PI / 2, back: CLIMB_TRUNK_CLEARANCE_M, lift: bodyLengthM / 2 }
    : { pitch: -Math.PI / 2, back: -CLIMB_TRUNK_CLEARANCE_M, lift: bodyLengthM / 2 };
}
