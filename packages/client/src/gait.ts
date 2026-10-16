/**
 * Legs that keep pace with the ground. A locomotion clip is one or more stride cycles; played at
 * its authored rate, a chasing tiger's legs turn over like a walk while its body covers 12 m a
 * second. Here the shown speed picks the gait (walk, trot, gallop) and sets the stride rate.
 *
 * Stride length follows Alexander's dynamic-similarity relation for legged animals,
 * λ / h = 2.3 (u² / g h)^0.3, with h the hip height and u the speed; walk-trot and trot-gallop
 * transitions fall near Froude numbers 0.5 and 2.5. Presentation only: the simulation's speeds
 * and positions are untouched.
 */
import * as THREE from 'three';

export type Gait = 'walk' | 'trot' | 'gallop';

const G = 9.81;
/** Froude numbers u²/gh where quadrupeds change gait, with a margin so a gait does not flicker. */
const TROT_FROM = 0.5, GALLOP_FROM = 2.5, HYSTERESIS = 0.15;
/** Stride rate is held to this range of the clip's own rate; beyond it a clip stops reading as itself. */
const MIN_RATE = 0.35, MAX_RATE = 3.2;

/**
 * Hip height from the drawn height (top of the back or head): legs are most of it, 0.85 of it in a
 * crouching cat or deer. A species can give its own share (species.ts hipFraction): an elephant
 * stands on columns under a deep body, its hip joint near half its height.
 */
export function hipHeightM(drawnHeightM: number, hipFraction = 0.85): number {
  return Math.max(0.05, drawnHeightM * hipFraction);
}

export function froude(speedMs: number, hipM: number): number {
  return speedMs * speedMs / (G * hipM);
}

/** Distance covered by one full stride cycle, in metres. */
export function strideLengthM(speedMs: number, hipM: number): number {
  if (speedMs <= 0) return 0;
  return 2.3 * hipM * Math.pow(froude(speedMs, hipM), 0.3);
}

/** Stride cycles per second needed to cover the ground at this speed. */
export function strideHz(speedMs: number, hipM: number): number {
  return speedMs <= 0 ? 0 : speedMs / strideLengthM(speedMs, hipM);
}

export function gaitFor(speedMs: number, hipM: number, previous: Gait | null = null): Gait {
  const fr = froude(speedMs, hipM);
  const up = 1 + HYSTERESIS, down = 1 - HYSTERESIS;
  const gallopAt = GALLOP_FROM * (previous === 'gallop' ? down : up);
  const trotAt = TROT_FROM * (previous === 'walk' ? up : down);
  if (fr >= gallopAt) return 'gallop';
  return fr >= trotAt ? 'trot' : 'walk';
}

/** States drawn with a stride cycle whose rate should follow the ground speed. */
const STRIDING = new Set(['travelling', 'chasing', 'fleeing', 'stalking']);
const GAIT_CLIPS: Record<Gait, readonly string[]> = {
  walk: ['Walk'],
  // No trot or run clip: a slowed gallop (a bounding canter) before an overspeed walk.
  trot: ['Trot', 'Run', 'Gallop', 'Walk'],
  gallop: ['Gallop', 'Run', 'Trot', 'Walk'],
};

/**
 * The clip for a moving animal at its shown speed, or null to keep the state's own choice.
 * A stalk keeps its sneak, however quick; a chase or flight that has not yet picked up speed
 * shows the gait it is actually moving at.
 */
export function clipForGait(state: string, gait: Gait | null, availableClips: readonly string[]): string | null {
  if (gait === null || !STRIDING.has(state) || state === 'stalking') return null;
  // An animal "travelling" at a gallop is hurrying; one chasing at a walk is still closing in.
  for (const wanted of GAIT_CLIPS[gait]) {
    const found = availableClips.find((clip) => clip.toLowerCase() === wanted.toLowerCase());
    if (found) return found;
  }
  return null;
}

/** Below this shown ground speed a stride reads as walking on the spot, so the animal stands. */
export const STAND_BELOW_MS = 0.12;

/** A striding state on a body that has all but stopped is shown standing. */
export function stateAtSpeed(state: string, clock: GaitClock): string {
  return STRIDING.has(state) && clock.gait !== null && clock.speedMs < STAND_BELOW_MS ? 'standing' : state;
}

export function isStrideClip(name: string): boolean {
  return /^(walk|trot|run|gallop|sneak)$/i.test(name);
}

/**
 * How many stride cycles a clip holds, read from its own motion: the most-moving rotation track
 * repeats once per cycle. Most clips are one cycle; the Asian elephants' walk is three.
 */
export function strideCycles(clip: THREE.AnimationClip): number {
  let best: THREE.KeyframeTrack | null = null, bestVariance = 0;
  for (const track of clip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack) || track.times.length < 8) continue;
    const n = track.times.length, mean = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) mean[k]! += track.values[i * 4 + k]! / n;
    let variance = 0;
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) variance += (track.values[i * 4 + k]! - mean[k]!) ** 2;
    if (variance > bestVariance) { bestVariance = variance; best = track; }
  }
  if (best === null || bestVariance < 1e-6) return 1;
  const n = best.times.length, v = best.values;
  const means = [0, 1, 2, 3].map((k) => mean4(v, n, k));
  const at = (i: number, k: number) => v[i * 4 + k]! - means[k]!;
  const correlation = (lag: number) => {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i + lag < n; i++) for (let k = 0; k < 4; k++) {
      const a = at(i, k), b = at(i + lag, k);
      ab += a * b; aa += a * a; bb += b * b;
    }
    return ab / (Math.sqrt(aa * bb) || 1);
  };
  // The first strong repeat, at least a sixth of the clip in: shorter lags are the same stride.
  const minLag = Math.max(2, Math.floor(n / 6));
  let previous = correlation(minLag - 1);
  for (let lag = minLag; lag < n - 2; lag++) {
    const here = correlation(lag), next = correlation(lag + 1);
    if (here > 0.8 && here >= previous && here >= next) {
      const period = best.times[lag]! - best.times[0]!;
      return Math.max(1, Math.round(clip.duration / period));
    }
    previous = here;
  }
  return 1;
}

function mean4(values: ArrayLike<number>, n: number, k: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i * 4 + k]!;
  return sum / n;
}

/** Clip seconds per shown second, so the stride cycle matches ground speed. */
export function strideRate(clip: THREE.AnimationClip, cycles: number, speedMs: number, hipM: number, maxRate = MAX_RATE): number {
  const natural = cycles / clip.duration;
  const wanted = strideHz(speedMs, hipM);
  if (!(natural > 0) || !(wanted > 0)) return 1;
  return Math.min(maxRate, Math.max(MIN_RATE, wanted / natural));
}

/** The fastest a rig's stride clip may be played: an animal whose only stride is its walk (a
 * crocodile lunging, an elephant hurrying) scurries it, rather than letting its feet slide. */
export function strideCeiling(clipNames: readonly string[]): number {
  return clipNames.some((n) => /^(trot|run|gallop)$/i.test(n)) ? MAX_RATE : 5;
}

/**
 * One animal's shown ground speed and stride clock. Speed is smoothed from successive drawn
 * positions; a jump (a teleport, a seek) or a long gap restarts it rather than reading as a sprint.
 */
export class GaitClock {
  speedMs = 0;
  gait: Gait | null = null;
  /** Seconds of clip time advanced by the stride rate; replay poses sample the clip here. */
  clipSeconds = 0;
  #x = 0; #z = 0; #t: number | null = null; #dt = 0;

  /** Feeds a drawn position at time `t` (seconds on any steady clock); returns the elapsed time. */
  observe(x: number, z: number, t: number, hipM: number): number {
    const last = this.#t;
    this.#t = t;
    const dx = x - this.#x, dz = z - this.#z;
    this.#x = x; this.#z = z;
    this.#dt = 0;
    if (last === null) return 0;
    const dt = t - last;
    if (dt <= 0) return 0;
    const distance = Math.hypot(dx, dz);
    // Nothing on the island moves 40 m/s: that is a seek or a re-placement, not motion.
    if (dt > 1.5 || distance > 40 * dt) { this.speedMs = 0; this.gait = null; return 0; }
    const blend = 1 - Math.exp(-dt / 0.25);
    this.speedMs += (distance / dt - this.speedMs) * blend;
    this.gait = gaitFor(this.speedMs, hipM, this.gait);
    this.#dt = dt;
    return dt;
  }

  /** Advances the stride clock by the last observed interval at `rate`, wrapped to the clip. */
  advance(rate: number, duration: number): number {
    if (duration > 0) this.clipSeconds = ((this.clipSeconds + this.#dt * rate) % duration + duration) % duration;
    return this.clipSeconds;
  }
}
