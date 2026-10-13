import { worldGrid } from './worldGrid.js';
import type { Drives } from './protocol.js';
import { patchCentre, subPatchOffset } from './space.js';
import { isMovementTrace, positionInPatch, treeAnchorGeometry, type MovementTrace, type WorldPosition } from '@vana/shared';

export interface LifeTrackPoint {
  worldTime: number; patchId: number; state: string; goal: string; drives: Drives;
  position?: WorldPosition;
  /** Optional server-recorded height; absent historical samples remain ground/unknown. */
  altitudeM?: number;
}

export interface LifeMoment { worldTime: number; text: string; eventId: string; narrated?: boolean }

export interface Life {
  id: string; speciesId: string; alive: boolean; bornAt: number; departedAt: number | null;
  track: LifeTrackPoint[]; moments: LifeMoment[];
  /** Validated separately; legacy records may not include paired trajectories or species. */
  encounters?: unknown[];
  /** Explicitly selected retained tree recording; never derived from the sparse track. */
  climbs?: unknown[];
}

export interface RecordedClimb {
  eventId: string; outcome: 'success' | 'interrupted'; trace: MovementTrace;
  direction: 'ascend' | 'descend'; reason: string; treeAnchorId: string; verticalDistanceM: number;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A ground approach with zero vertical motion is a valid failed attempt, not a climb pose. */
export function isRecordedClimb(value: unknown): value is RecordedClimb {
  if (!record(value) || typeof value.eventId !== 'string' || !value.eventId
    || !isMovementTrace(worldGrid(), value.trace) || (value.direction !== 'ascend' && value.direction !== 'descend')
    || !['local_threat', 'threat_gone', 'canopy_lost', 'urgent_need'].includes(String(value.reason))
    || value.outcome !== (value.trace.completed ? 'success' : 'interrupted')) return false;
  const anchor = treeAnchorGeometry(worldGrid(), value.trace.destinationPatchId);
  if (!anchor || value.treeAnchorId !== anchor.id
    || value.trace.goal !== (value.direction === 'ascend' ? 'flee' : 'rest')
    || typeof value.verticalDistanceM !== 'number' || !Number.isFinite(value.verticalDistanceM)
    || value.verticalDistanceM < 0 || value.verticalDistanceM > anchor.climbHeightM) return false;
  let travelled = 0, previous = value.trace.samples[0]!.altitudeM ?? 0;
  for (const sample of value.trace.samples) {
    const altitude = sample.altitudeM ?? 0, delta = altitude - previous;
    if (altitude > anchor.climbHeightM || altitude > 0
      && Math.hypot(sample.position.x - anchor.x, sample.position.z - anchor.z) > 1e-6
      || value.direction === 'ascend' && delta < -1e-6 || value.direction === 'descend' && delta > 1e-6) return false;
    travelled += Math.abs(delta); previous = altitude;
  }
  return Math.abs(travelled - value.verticalDistanceM) <= 1e-6;
}

export function climbMoment(recording: RecordedClimb, seconds: number): string {
  const vertical = recording.verticalDistanceM > 0;
  const atEnd = seconds >= recording.trace.samples.at(-1)!.seconds;
  if (!vertical) return recording.direction === 'ascend'
    ? atEnd ? 'Recorded approach ended; no vertical climb occurred' : 'Recorded approach to tree'
    : atEnd ? 'Recorded descent attempt ended; no vertical movement occurred' : 'Recorded descent attempt';
  if (recording.direction === 'ascend' && !atEnd) {
    const firstVertical = recording.trace.samples.findIndex((sample, i) => i > 0
      && (sample.altitudeM ?? 0) > (recording.trace.samples[i - 1]!.altitudeM ?? 0));
    if (firstVertical > 0 && seconds < recording.trace.samples[firstVertical - 1]!.seconds)
      return 'Recorded approach to tree';
  }
  const action = recording.direction === 'ascend' ? 'ascent' : 'descent';
  return atEnd ? `Recorded tree ${action} · ${recording.outcome}` : `Recorded tree ${action}`;
}

/** Last recorded moment at the playhead; logarithmic even for very long paged biographies. */
export function momentAt(moments: readonly LifeMoment[], worldTime: number): LifeMoment | undefined {
  let low = 0, high = moments.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (moments[mid]!.worldTime <= worldTime) low = mid + 1; else high = mid;
  }
  return low > 0 ? moments[low - 1] : undefined;
}

const FIVE_YEARS = 5 * 365 * 86_400;

/** Do not turn a migrated world into a claim of precise historical tracking. */
export function trackPrecision(track: readonly LifeTrackPoint[]): string {
  const recorded = track.filter((p) => positionInPatch(worldGrid(), p.position, p.patchId)).length;
  if (recorded === 0) return 'Legacy patch-only record: positions and paths are approximate.';
  if (recorded < track.length) return 'Mixed record: older positions are approximate; paths between samples are interpolated.';
  return 'Server-recorded positions; paths between samples are interpolated, not collision-aware.';
}

/** Five years in two minutes (spec §11); a short life still gets twenty seconds to be seen. */
export function replayDurationMs(spanSeconds: number): number {
  return Math.round(Math.min(120_000, Math.max(20_000, (spanSeconds / FIVE_YEARS) * 120_000)));
}

/**
 * Where the animal was at `worldTime`: eased between recorded positions when present; old
 * patch-only samples use the explicitly approximate legacy offset. Before the first sample it stands at
 * the first; after the last, at the last. State and drives are those of the last sample passed.
 */
export function pointAt(track: readonly LifeTrackPoint[], id: string, worldTime: number): {
  x: number; z: number; heading: number; moving: boolean; altitudeM?: number;
  state: string; drives: Drives;
} {
  const offset = subPatchOffset(worldGrid(), id);
  let i = 0;
  while (i + 1 < track.length && track[i + 1]!.worldTime <= worldTime) i++;
  const here = track[i]!;
  const next = track[i + 1];
  const resolved = (point: LifeTrackPoint): WorldPosition => positionInPatch(worldGrid(), point.position, point.patchId)
    ? point.position : { x: patchCentre(worldGrid(), point.patchId).x + offset.x, z: patchCentre(worldGrid(), point.patchId).z + offset.z, heading: 0 };
  const from = resolved(here);
  if (next === undefined || worldTime <= here.worldTime) {
    return { ...from, moving: false, state: here.state, drives: here.drives,
      ...(here.altitudeM === undefined ? {} : { altitudeM: here.altitudeM }) };
  }
  const to = resolved(next);
  const t = (worldTime - here.worldTime) / (next.worldTime - here.worldTime);
  const eased = t * t * (3 - 2 * t);
  return {
    x: from.x + (to.x - from.x) * eased,
    z: from.z + (to.z - from.z) * eased,
    heading: from.x === to.x && from.z === to.z ? from.heading
      : Math.atan2(to.x - from.x, to.z - from.z),
    moving: from.x !== to.x || from.z !== to.z
      || here.altitudeM !== undefined && next.altitudeM !== undefined && here.altitudeM !== next.altitudeM,
    ...(here.altitudeM === undefined ? {} : { altitudeM: next.altitudeM === undefined
      ? here.altitudeM : here.altitudeM + (next.altitudeM - here.altitudeM) * eased }),
    state: here.state,
    drives: here.drives,
  };
}

/** The moments the playhead crossed between two frames, each shown once. */
export function momentsBetween(moments: readonly LifeMoment[], from: number, to: number): LifeMoment[] {
  return moments.filter((m) => m.worldTime > from && m.worldTime <= to);
}
