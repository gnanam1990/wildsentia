import { ISLAND_GRID, isWorldPosition, type WorldGrid, type WorldPosition } from './grid.js';
import type { CommunityState, HumanAction } from './types/community.js';

export interface HumanMotionSample {
  seconds: number;
  position: WorldPosition;
  alive: boolean;
  action: HumanAction | null;
  phase: 'travel' | 'work' | null;
  taskEventId: string | null;
}
/** Last completed hour (or shorter initial step), generated from actual executed segments. */
export interface CommunityMotion {
  version: 1;
  startWorldTime: number;
  endWorldTime: number;
  tracks: Array<{ personId: string; samples: HumanMotionSample[] }>;
}
export const MAX_HUMAN_MOTION_SAMPLES = 1024;
const actions = new Set(['gather_food', 'collect_water', 'gather_timber', 'gather_fibre', 'deliver', 'eat',
  'drink', 'sleep', 'build', 'rest', 'fish', 'cook', 'repair', 'seek_resources', 'hunt', 'care_child']);
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function isCommunityMotion(value: unknown, community: Pick<CommunityState, 'people' | 'updatedAt' | 'foundedAt'>, grid: WorldGrid = ISLAND_GRID): value is CommunityMotion {
  if (!record(value) || value.version !== 1 || !finite(value.startWorldTime) || !finite(value.endWorldTime)
    || value.startWorldTime < community.foundedAt || value.endWorldTime !== community.updatedAt
    || value.endWorldTime <= value.startWorldTime || value.endWorldTime - value.startWorldTime > 3600
    || !Array.isArray(value.tracks) || value.tracks.length !== community.people.length) return false;
  const ids = new Set<string>(), duration = value.endWorldTime - value.startWorldTime;
  for (const track of value.tracks) {
    if (!record(track) || typeof track.personId !== 'string' || ids.has(track.personId)
      || !Array.isArray(track.samples) || track.samples.length < 2 || track.samples.length > MAX_HUMAN_MOTION_SAMPLES) return false;
    const person = community.people.find(p => p.id === track.personId); if (!person) return false;
    ids.add(track.personId); let previous: HumanMotionSample | null = null;
    for (const sample of track.samples) {
      if (!record(sample) || !finite(sample.seconds) || sample.seconds < 0 || sample.seconds > duration
        || !isWorldPosition(grid, sample.position) || typeof sample.alive !== 'boolean'
        || !(sample.action === null || typeof sample.action === 'string' && actions.has(sample.action))
        || !(sample.phase === null || sample.phase === 'travel' || sample.phase === 'work')
        || !(sample.taskEventId === null || typeof sample.taskEventId === 'string' && sample.taskEventId.length > 0 && sample.taskEventId.length <= 128)
        || (sample.action === null) !== (sample.phase === null) || (sample.phase === null) !== (sample.taskEventId === null)
        || !sample.alive && sample.action !== null) return false;
      if (previous) {
        const dt = sample.seconds - previous.seconds, gap = Math.hypot(sample.position.x - previous.position.x, sample.position.z - previous.position.z);
        if (dt <= 0 || !previous.alive && sample.alive || gap > dt * 1.1 + 1e-5
          || gap > 1e-6 && previous.phase !== 'travel') return false;
      } else if (sample.seconds !== 0) return false;
      if (sample.alive !== (person.diedAt === null || value.startWorldTime + sample.seconds < person.diedAt)
        || person.task && sample.taskEventId === person.task.eventId && value.startWorldTime + sample.seconds + 1e-8 < person.task.startedAt) return false;
      previous = sample as unknown as HumanMotionSample;
    }
    const last = previous!;
    if (last.seconds !== duration || last.alive !== person.alive || last.action !== (person.task?.kind ?? null)
      || last.phase !== (person.task?.phase ?? null) || last.taskEventId !== (person.task?.eventId ?? null)
      || Math.hypot(last.position.x - person.position.x, last.position.z - person.position.z) > 1e-6
      || Math.abs(last.position.heading - person.position.heading) > 1e-6) return false;
  }
  return true;
}

/** Outgoing sample owns each interval. Work/death transitions never appear before their time. */
export function humanMotionAt(samples: readonly HumanMotionSample[], seconds: number): HumanMotionSample & { moving: boolean } {
  if (!Number.isFinite(seconds) || samples.length < 2) throw new Error('Invalid human motion playhead');
  let low = 0, high = samples.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (samples[mid]!.seconds <= seconds) low = mid; else high = mid - 1; }
  const a = samples[low]!, b = samples[low + 1];
  if (seconds < 0 || !b) return { ...a, position: { ...a.position }, moving: false };
  const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
  const moving = a.alive && a.phase === 'travel' && (dx !== 0 || dz !== 0);
  const t = Math.max(0, Math.min(1, (seconds - a.seconds) / (b.seconds - a.seconds)));
  return { ...a, position: moving ? { x: a.position.x + dx * t, z: a.position.z + dz * t, heading: Math.atan2(dx, dz) } : { ...a.position }, moving };
}
