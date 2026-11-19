/**
 * Soft strides for the big cats. Their gaits (tools/art/rig_big_cat.py) were baked at 30 frames a
 * second, 24 keys for a walk and 13 for a gallop, joined by straight lines. A cat's paw folds and
 * swings through in a few of those frames, so the wrist and hock kink from key to key (a forearm
 * turns 56° in one walk frame) and every footfall reads as a hard step once the clip is played at
 * a stride rate of two or three.
 *
 * Each stride track is redrawn as a closed Catmull-Rom curve through its own keys (every authored
 * pose kept), resampled densely round its loop, then given a light circular Gaussian whose width is
 * a fraction of the cycle, so the softening holds at any stride rate. The swing keeps its lift and a
 * planted paw moves a few millimetres at most. Presentation only: length, footfall timing and
 * stride count are kept.
 */
import * as THREE from 'three';

/** The big-cat rig's stride clips; other rigs' gaits are dense enough as authored. */
export const SOFT_STRIDE_CLIPS: ReadonlySet<string> = new Set(['Walk', 'Run', 'Gallop', 'Sneak']);
/** The models built on that rig. */
export const BIG_CAT_MODELS: ReadonlySet<string> = new Set(['/assets/animals/AfricanLeopard.glb',
  '/assets/animals/AfricanGoldenCat.glb', '/assets/animals/TigerCat.glb']);

export interface SoftStrideOptions {
  /** Samples per loop of the clip. */
  samples?: number;
  /** Gaussian width, as a fraction of the loop. */
  sigma?: number;
}

/**
 * A copy of a looping stride clip: each track drawn through its own keys as a closed Catmull-Rom
 * curve (every authored pose kept, no corner between them), densely resampled, then smoothed with
 * a circular Gaussian `sigma` of the cycle wide.
 */
export function softStride(clip: THREE.AnimationClip, { samples = 96, sigma = 0.02 }: SoftStrideOptions = {}): THREE.AnimationClip {
  const duration = clip.duration;
  if (!(duration > 0)) return clip;
  const times = Float32Array.from({ length: samples + 1 }, (_, i) => duration * i / samples);
  const tracks = clip.tracks.map((track) =>
    // A channel the exporter shortened to its ends holds still: nothing to soften.
    track.times.length < 4 ? track : resampled(track, duration, times, sigma * samples));
  return new THREE.AnimationClip(clip.name, duration, tracks);
}

/** A model's clips with a big-cat rig's strides softened; any other model's as they were. */
export function softenStrides(file: string, clips: THREE.AnimationClip[]): THREE.AnimationClip[] {
  if (!BIG_CAT_MODELS.has(file)) return clips;
  // The sneak is slow and its keys close together: a lighter pass keeps its careful, low lift.
  return clips.map((clip) => (SOFT_STRIDE_CLIPS.has(clip.name) ? softStride(clip, clip.name === 'Sneak' ? { sigma: 0.01 } : {}) : clip));
}

/** One track as a closed curve through its keys, sampled at `times` (the last closing the loop). */
function resampled(track: THREE.KeyframeTrack, duration: number, times: Float32Array, sigma: number): THREE.KeyframeTrack {
  const samples = times.length - 1, width = track.getValueSize();
  const quaternion = track instanceof THREE.QuaternionKeyframeTrack;
  const keys = track.times.length - 1; // the last key repeats the first
  const step = duration / keys;
  const even = Array.from(track.times).every((t, i) => Math.abs(t - i * step) < step * 0.05);
  const interpolant = track.createInterpolant();
  const raw = new Float32Array(samples * width);
  const p = [0, 0, 0, 0].map(() => new Float32Array(width));
  for (let i = 0; i < samples; i++) {
    if (!even) { raw.set(interpolant.evaluate(times[i]!), i * width); continue; }
    const u = times[i]! / step, at = Math.floor(u), f = u - at;
    for (let m = 0; m < 4; m++) {
      const key = ((at - 1 + m) % keys + keys) % keys;
      for (let k = 0; k < width; k++) p[m]![k] = track.values[key * width + k]!;
    }
    // Each neighbour on the same side of the 4-sphere as the key the sample starts from.
    if (quaternion) for (const m of [0, 2, 3]) if (dot(p[m]!, p[1]!) < 0) for (let k = 0; k < 4; k++) p[m]![k] = -p[m]![k]!;
    const f2 = f * f, f3 = f2 * f;
    for (let k = 0; k < width; k++) {
      const a = p[0]![k]!, b = p[1]![k]!, c = p[2]![k]!, d = p[3]![k]!;
      raw[i * width + k] = 0.5 * (2 * b + (c - a) * f + (2 * a - 5 * b + 4 * c - d) * f2 + (3 * b - a - 3 * c + d) * f3);
    }
  }
  const out = new Float32Array((samples + 1) * width);
  const radius = Math.min(samples >> 1, Math.ceil(sigma * 3));
  for (let i = 0; i < samples; i++) {
    let total = 0;
    for (let j = -radius; j <= radius; j++) {
      const w = sigma > 0 ? Math.exp(-(j * j) / (2 * sigma * sigma)) : j === 0 ? 1 : 0, at = ((i + j) % samples + samples) % samples;
      // A quaternion and its negation are the same turn: average each on the centre's side.
      const flip = quaternion && dot4(raw, at * 4, i * 4) < 0 ? -1 : 1;
      for (let k = 0; k < width; k++) out[i * width + k]! += w * flip * raw[at * width + k]!;
      total += w;
    }
    for (let k = 0; k < width; k++) out[i * width + k]! /= total;
    if (quaternion) {
      const o = i * 4, length = Math.hypot(out[o]!, out[o + 1]!, out[o + 2]!, out[o + 3]!) || 1;
      for (let k = 0; k < 4; k++) out[o + k]! /= length;
    }
  }
  // The loop closes on its own first pose.
  out.copyWithin(samples * width, 0, width);
  const copy = track.clone();
  copy.times = times.slice();
  copy.values = out;
  return copy;
}

const dot = (a: Float32Array, b: Float32Array) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
const dot4 = (v: Float32Array, a: number, b: number) => v[a]! * v[b]! + v[a + 1]! * v[b + 1]! + v[a + 2]! * v[b + 2]! + v[a + 3]! * v[b + 3]!;
