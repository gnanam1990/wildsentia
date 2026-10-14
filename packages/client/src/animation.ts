/**
 * Maps a server-reported agent state to an animation clip, in order of preference.
 *
 * A model lacking the preferred clip falls back down the list; a model matching nothing gets
 * null, and the caller stops the previous clip. An animal
 * must never play a walk cycle while the server says it is grazing — that mismatch between
 * shown behaviour and actual state is the defect this module exists to prevent.
 */
import * as THREE from 'three';
import { ACT_STATES, POUNCE_S } from './huntActs.js';

export const CLIP_PREFERENCES: Record<string, readonly string[]> = {
  resting:    ['Resting', 'Idle', 'Idle_2'],
  // Paused on its feet: never a lying-down rest clip, never a stride.
  standing:   ['Idle', 'Idle_2', 'Resting'],
  grazing:    ['Eating', 'TrunkReach', 'Idle_Headlow', 'Idle_2_HeadLow', 'Idle'],
  drinking:   ['Drinking', 'TrunkReach', 'Idle_Headlow', 'Idle_2_HeadLow', 'Eating', 'Idle'],
  travelling: ['Walk', 'Gallop', 'Idle'],
  // A stalk is a slow, deliberate walk; a chase and a flight are flat out.
  stalking:   ['Sneak', 'Walk', 'Idle'],
  chasing:    ['Run', 'Gallop', 'Walk', 'Idle'],
  fleeing:    ['Run', 'Gallop', 'Walk', 'Idle'],
  feeding:    ['Eating', 'TrunkReach', 'Idle_Headlow', 'Idle_2_HeadLow', 'Idle'],
  dead:       ['Death', 'Dead'],
  // A hunt's acts (huntActs.ts): the spring, the hold, and the prey struck, falling, struggling.
  pouncing:   ['Pounce', 'Gallop_Jump', 'Gallop', 'Run'],
  holding:    ['Bite', 'Attack', 'Eating', 'Idle'],
  struck:     ['Idle_HitReact1', 'Idle_HitReact2', 'Injured', 'Idle'],
  falling:    ['Death', 'Dead'],
  struggling: ['Struggle', 'Death', 'Dead'],
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

/** A well-mixed 0..1 value from an animal's seed, one per `salt`. */
function unit(seed: number, salt: number): number {
  let h = Math.imul((seed >>> 0) ^ Math.imul(salt + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Where in a looping clip this animal is, so a herd or a line at the water does not move in unison. */
export function clipPhase(seed: number, duration: number): number {
  return duration > 0 ? unit(seed, 0) * duration : 0;
}

const VIGILANT = new Set(['drinking', 'grazing', 'feeding']);

/**
 * How far an animal at water or forage has lifted its head to look round, 0 (head down) to 1.
 * Animals do not drink or graze with their heads down throughout: they stop, look up and scan,
 * and go back to it. Each animal keeps its own rhythm: a look of 2.4–3.2 s every 8–13 s,
 * about a fifth to a third of the time, eased over 0.6 s at either end.
 */
export function vigilance(state: string, seconds: number, seed: number): number {
  if (!VIGILANT.has(state) || !Number.isFinite(seconds)) return 0;
  const period = 8 + unit(seed, 1) * 5, look = 2.4 + unit(seed, 2) * 0.8, ramp = 0.6;
  const t = ((seconds + unit(seed, 3) * period) % period + period) % period;
  if (t >= look) return 0;
  const ease = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
  return Math.min(ease(t / ramp), ease((look - t) / ramp));
}

/** Clip time for a hunt act: the spring fitted to its window, a stagger or fall played once, a hold looped. */
export function actClipTime(state: string, duration: number, act: number): number {
  if (!(duration > 0) || !Number.isFinite(act)) return 0;
  const a = Math.max(0, act);
  if (state === 'pouncing') return Math.min(duration, a / POUNCE_S * duration);
  if (state === 'struck' || state === 'falling') return Math.min(duration, a);
  return a % duration;
}

/**
 * A downed animal's struggle, made from its own rig: the last pose of its Death clip (lying on
 * its side) with the legs kicking and the head lifting. Each leg kicks about the axis it swings
 * on in the animal's own gait, so the motion suits the rig whatever its bone layout.
 */
export function struggleClip(death: THREE.AnimationClip, gait: THREE.AnimationClip | null): THREE.AnimationClip {
  const duration = 1.2, fps = 30, steps = Math.round(duration * fps);
  const times = Float32Array.from({ length: steps + 1 }, (_, i) => duration * i / steps);
  const gaitTracks = new Map((gait?.tracks ?? []).filter((t) => t instanceof THREE.QuaternionKeyframeTrack).map((t) => [t.name, t]));
  const tracks = death.tracks.map((track) => {
    const width = track.getValueSize();
    const last = Array.from(track.values.slice(track.values.length - width));
    const values = new Float32Array(times.length * width);
    const bone = track.name.split('.').slice(0, -1).join('.');
    const swing = track instanceof THREE.QuaternionKeyframeTrack ? gaitTracks.get(track.name) : undefined;
    // Limb bones of every rig: the Quaternius legs, the old big-cat 'front.'/'back.' chain, and the
    // big-cat rig's own (tools/art/rig_big_cat.py), named as three.js loads them, without dots.
    const limb = /leg|paw|foot|thigh|shin|arm|hand|finger|toe|scapula|front\.|back\./i.test(bone) && !/ik|pole/i.test(bone);
    const lifts = /neck|head/i.test(bone) && !/ik/i.test(bone);
    const axis = swing && (limb || lifts) ? swingAxis(swing) : null;
    const base = new THREE.Quaternion().fromArray(last), q = new THREE.Quaternion(), turn = new THREE.Quaternion();
    // Legs kick out of step with each other; the head lifts and drops more slowly.
    let phase = 0; for (const c of bone) phase = (phase * 31 + c.charCodeAt(0)) % 997;
    for (let i = 0; i < times.length; i++) {
      if (axis) {
        const w = 2 * Math.PI * times[i]! / duration;
        const angle = limb ? 0.45 * Math.sin(2 * w + phase) : 0.18 * Math.sin(w + phase);
        q.copy(base).multiply(turn.setFromAxisAngle(axis, angle));
        values.set([q.x, q.y, q.z, q.w], i * width);
      } else values.set(last, i * width);
    }
    const copy = track.clone();
    copy.times = times.slice(); copy.values = values;
    return copy;
  });
  return new THREE.AnimationClip('Struggle', duration, tracks);
}

/** The local axis a bone mostly turns about in a clip (the axis of its largest swings from the mean). */
function swingAxis(track: THREE.KeyframeTrack): THREE.Vector3 | null {
  const n = track.times.length;
  if (n < 2) return null;
  const mean = new THREE.Quaternion(0, 0, 0, 0);
  const qs = Array.from({ length: n }, (_, i) => new THREE.Quaternion().fromArray(track.values as unknown as number[], i * 4));
  for (const q of qs) { const s = q.dot(qs[0]!) < 0 ? -1 : 1; mean.x += q.x * s; mean.y += q.y * s; mean.z += q.z * s; mean.w += q.w * s; }
  mean.normalize();
  const inverse = mean.clone().invert(), sum = new THREE.Vector3(), v = new THREE.Vector3();
  let reference: THREE.Vector3 | null = null;
  for (const q of qs) {
    const d = inverse.clone().multiply(q); if (d.w < 0) { d.x = -d.x; d.y = -d.y; d.z = -d.z; d.w = -d.w; }
    v.set(d.x, d.y, d.z);
    if (v.lengthSq() < 1e-10) continue;
    reference ??= v.clone();
    sum.addScaledVector(v, v.dot(reference) < 0 ? -1 : 1);
  }
  return sum.lengthSq() > 1e-10 ? sum.normalize() : null;
}

/** A replay seek samples a pose directly; a corpse must not freeze on frame zero of Death. */
export function replayClipTime(state: string, duration: number, seconds: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(seconds)) return 0;
  return state === 'dead' ? duration : ((seconds % duration) + duration) % duration;
}

/** States whose clip is a stride cycle, which only reads right on a body covering ground. */
const STRIDING_STATES = ['travelling', 'chasing', 'fleeing', 'stalking'];

/**
 * Keep chase/stalk/death semantics while the animal moves. One that is not covering ground
 * stands: between live hours, or with motion reduced, every animal keeps its saved
 * "travelling" or "fleeing" state where it stopped, and a stride clip on a still body
 * walks it on the spot.
 */
export function renderStateFor(state: string, moving: boolean): string {
  if (state === 'dead' || ACT_STATES.has(state)) return state;
  if (STRIDING_STATES.includes(state)) return moving ? state : 'standing';
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

/** Species that climb their patch's tree in the simulation; the leopard climbs to escape tigers (sim_0.37). */
export const CLIMBERS: ReadonlySet<string> = new Set(['langur', 'squirrel', 'leopard']);
export const climbs = (speciesId: string): boolean => CLIMBERS.has(speciesId);

/** Trunk radius the climber is held clear of; drawn anchor trees are broadleaf trunks of about this size. */
export const CLIMB_TRUNK_CLEARANCE_M = 0.32;

/**
 * How a climbing langur or squirrel is turned on its trunk. The model faces +Z (its belly -Y);
 * pitched upright, the belly faces the trunk ahead, the body is lifted so its hind feet are at the
 * recorded altitude, and it is held one trunk radius out from the trunk's centre. Langurs come
 * down tail first (head still up); squirrels and leopards come down head first.
 */
export function climbPose(speciesId: string, phase: ClimbVisualPhase | null, bodyLengthM: number):
  { pitch: number; back: number; lift: number } {
  if (phase === null) return { pitch: 0, back: 0, lift: 0 };
  const headFirstDown = phase === 'descending' && (speciesId === 'squirrel' || speciesId === 'leopard');
  return headFirstDown
    // Head down turns the belly backwards, so the body is held out on the other side.
    ? { pitch: Math.PI / 2, back: CLIMB_TRUNK_CLEARANCE_M, lift: bodyLengthM / 2 }
    : { pitch: -Math.PI / 2, back: -CLIMB_TRUNK_CLEARANCE_M, lift: bodyLengthM / 2 };
}
