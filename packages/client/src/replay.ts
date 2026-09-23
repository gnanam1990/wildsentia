import type { Drives } from './protocol.js';
import { patchCentre, subPatchOffset } from './space.js';

export interface LifeTrackPoint {
  worldTime: number; patchId: number; state: string; goal: string; drives: Drives;
}

export interface LifeMoment { worldTime: number; text: string; eventId: string; narrated?: boolean }

export interface Life {
  id: string; speciesId: string; alive: boolean; bornAt: number; departedAt: number | null;
  track: LifeTrackPoint[]; moments: LifeMoment[];
}

const FIVE_YEARS = 5 * 365 * 86_400;

/** Five years in two minutes (spec §11); a short life still gets twenty seconds to be seen. */
export function replayDurationMs(spanSeconds: number): number {
  return Math.round(Math.min(120_000, Math.max(20_000, (spanSeconds / FIVE_YEARS) * 120_000)));
}

/**
 * Where the animal was at `worldTime`: eased between the two recorded samples either side, at
 * the same stable offset inside a patch the live view uses. Before the first sample it stands at
 * the first; after the last, at the last. State and drives are those of the last sample passed.
 */
export function pointAt(track: readonly LifeTrackPoint[], id: string, worldTime: number): {
  x: number; z: number; heading: number; moving: boolean; state: string; drives: Drives;
} {
  const offset = subPatchOffset(id);
  let i = 0;
  while (i + 1 < track.length && track[i + 1]!.worldTime <= worldTime) i++;
  const here = track[i]!;
  const next = track[i + 1];
  const from = patchCentre(here.patchId);
  if (next === undefined || worldTime <= here.worldTime) {
    return { x: from.x + offset.x, z: from.z + offset.z, heading: 0, moving: false, state: here.state, drives: here.drives };
  }
  const to = patchCentre(next.patchId);
  const t = (worldTime - here.worldTime) / (next.worldTime - here.worldTime);
  const eased = t * t * (3 - 2 * t);
  return {
    x: from.x + (to.x - from.x) * eased + offset.x,
    z: from.z + (to.z - from.z) * eased + offset.z,
    heading: Math.atan2(to.x - from.x, to.z - from.z),
    moving: next.patchId !== here.patchId,
    state: here.state,
    drives: here.drives,
  };
}

/** The moments the playhead crossed between two frames, each shown once. */
export function momentsBetween(moments: readonly LifeMoment[], from: number, to: number): LifeMoment[] {
  return moments.filter((m) => m.worldTime > from && m.worldTime <= to);
}
