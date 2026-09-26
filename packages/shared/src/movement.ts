import { isWorldPosition, patchAtPosition, type WorldPosition } from './spatial.js';
import { isGoalId, type GoalId } from './types/agent.js';
import { PATCH_COUNT } from './types/patch.js';
import type { EncounterAppearance } from './encounter.js';
import { atRecordedWaterAccess } from './waterAccess.js';

/** Server-produced route, not a client-authored interpolation. */
export interface MovementTrace {
  version: 1;
  actorId: string;
  startWorldTime: number;
  destinationPatchId: number;
  goal: GoalId;
  samples: Array<{ seconds: number; position: WorldPosition; altitudeM?: number }>;
  completed: boolean;
}

export const MAX_LIVE_MOVEMENTS = 2048;
export const MAX_MOVEMENT_SAMPLES = 2048;
export const MAX_LIVE_MOVEMENT_SAMPLES = 32_768;
export interface LiveMovement {
  eventId: string;
  actor: EncounterAppearance;
  trace: MovementTrace;
  /** A held observed position for a stationary drinker; not a fabricated movement event. */
  stationary?: true;
  /** Recorded aggregate action window, not sip-by-sip animation timing. */
  activity?: DrinkingActivity;
}

export interface DrinkingActivity {
  type: 'drinking';
  eventId: string;
  startSeconds: number;
  endSeconds: number;
  position: WorldPosition;
  litres: number;
}

export function isDrinkingActivity(value: unknown): value is DrinkingActivity {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return a.type === 'drinking' && typeof a.eventId === 'string' && !!a.eventId
    && typeof a.startSeconds === 'number' && Number.isFinite(a.startSeconds) && a.startSeconds >= 0
    && typeof a.endSeconds === 'number' && Number.isFinite(a.endSeconds)
    && a.endSeconds > a.startSeconds && a.endSeconds <= 3600
    && typeof a.litres === 'number' && Number.isFinite(a.litres) && a.litres > 0
    // Recordings may predate sim_0.30.0, when the access point was the patch centre.
    && isWorldPosition(a.position) && atRecordedWaterAccess(a.position, patchAtPosition(a.position));
}

/** Routes belong to one hourly decision. Reject teleports hidden behind equal timestamps. */
export function isMovementTrace(value: unknown): value is MovementTrace {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  if (t.version !== 1 || typeof t.actorId !== 'string' || !t.actorId
    || typeof t.startWorldTime !== 'number' || !Number.isSafeInteger(t.startWorldTime) || t.startWorldTime < 0
    || typeof t.destinationPatchId !== 'number' || !Number.isInteger(t.destinationPatchId)
    || t.destinationPatchId < 0 || t.destinationPatchId >= PATCH_COUNT
    || typeof t.goal !== 'string' || !isGoalId(t.goal) || typeof t.completed !== 'boolean'
    || !Array.isArray(t.samples) || t.samples.length < 1 || t.samples.length > MAX_MOVEMENT_SAMPLES) return false;
  let previous = -1;
  for (const sample of t.samples) {
    if (typeof sample !== 'object' || sample === null || typeof sample.seconds !== 'number'
      || !Number.isFinite(sample.seconds) || sample.seconds < 0 || sample.seconds > 3600
      || sample.seconds <= previous || !isWorldPosition(sample.position)
      || sample.altitudeM !== undefined && (typeof sample.altitudeM !== 'number'
        || !Number.isFinite(sample.altitudeM) || sample.altitudeM < 0 || sample.altitudeM > 2_000)) return false;
    previous = sample.seconds;
  }
  if (t.samples[0].seconds !== 0) return false;
  return !t.completed || patchAtPosition(t.samples.at(-1).position) === t.destinationPatchId;
}

/** Piecewise linear time interpolation preserves the route's corners and speed changes. */
export function movementAt(trace: MovementTrace, seconds: number) {
  if (!Number.isFinite(seconds)) throw new Error('invalid movement playhead');
  let low = 0, high = trace.samples.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (trace.samples[mid]!.seconds <= seconds) low = mid; else high = mid - 1;
  }
  const a = trace.samples[low]!, b = trace.samples[low + 1];
  if (seconds < 0 || !b) return { ...a.position, moving: false,
    ...(a.altitudeM === undefined ? {} : { altitudeM: a.altitudeM }) };
  const t = Math.max(0, Math.min(1, (seconds - a.seconds) / (b.seconds - a.seconds)));
  const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
  const horizontal = dx !== 0 || dz !== 0;
  const altitudeA = a.altitudeM, altitudeB = b.altitudeM;
  const moving = horizontal || (altitudeA ?? 0) !== (altitudeB ?? 0);
  const result = { x: a.position.x + dx * t, z: a.position.z + dz * t,
    heading: horizontal ? Math.atan2(dx, dz) : a.position.heading, moving };
  if (altitudeA !== undefined || altitudeB !== undefined) {
    return { ...result, altitudeM: (altitudeA ?? 0) + ((altitudeB ?? 0) - (altitudeA ?? 0)) * t };
  }
  return result;
}
