import { isWorldPosition, positionInPatch, type EncounterTrace, type WorldPosition } from '@vana/shared';

export interface RecordedEncounter {
  eventId: string;
  outcome: string;
  predatorSpecies: string;
  preySpecies: string;
  trace: EncounterTrace;
}
const phases = new Set(['approach', 'stalk', 'chase', 'contact', 'escape', 'abandon']);
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Reject incomplete/legacy traces instead of inventing the missing second actor or trajectory. */
export function isRecordedEncounter(value: unknown): value is RecordedEncounter {
  if (!record(value) || typeof value.eventId !== 'string' || typeof value.outcome !== 'string'
    || typeof value.predatorSpecies !== 'string' || !value.predatorSpecies
    || typeof value.preySpecies !== 'string' || !value.preySpecies || !record(value.trace)
    || !['success', 'failure', 'abandoned', 'interrupted'].includes(value.outcome)) return false;
  const t = value.trace;
  if (t.version !== 1 || typeof t.predatorId !== 'string' || typeof t.preyId !== 'string'
    || !t.predatorId || !t.preyId || t.predatorId === t.preyId
    || typeof t.startWorldTime !== 'number' || !Number.isFinite(t.startWorldTime)
    || typeof t.contactRadiusM !== 'number' || !Number.isFinite(t.contactRadiusM) || t.contactRadiusM <= 0
    || !Array.isArray(t.samples) || t.samples.length < 1 || t.samples.length > 10_000) return false;
  let previous = -1;
  for (const s of t.samples) {
    if (!record(s) || typeof s.seconds !== 'number' || !Number.isFinite(s.seconds)
      || s.seconds < 0 || s.seconds < previous || typeof s.phase !== 'string' || !phases.has(s.phase)
      || !isWorldPosition(s.predator) || !isWorldPosition(s.prey)) return false;
    previous = s.seconds;
  }
  const first = t.samples[0] as EncounterTrace['samples'][number];
  const last = t.samples.at(-1) as EncounterTrace['samples'][number];
  if (typeof t.patchId !== 'number' || !positionInPatch(first.predator, t.patchId)
    || !positionInPatch(first.prey, t.patchId) || first.seconds !== 0) return false;
  return value.outcome !== 'success' || (last.phase === 'contact'
    && Math.hypot(last.predator.x - last.prey.x, last.predator.z - last.prey.z) <= t.contactRadiusM + 1e-6);
}

/** Both actors are sampled at exactly the same elapsed time; no second interpolation clock. */
export function encounterAt(trace: EncounterTrace, seconds: number) {
  if (!Number.isFinite(seconds)) throw new Error('invalid encounter playhead');
  let i = 0;
  while (i + 1 < trace.samples.length && trace.samples[i + 1]!.seconds <= seconds) i++;
  const a = trace.samples[i]!; const b = trace.samples[i + 1] ?? a;
  const duration = b.seconds - a.seconds;
  const t = duration > 0 ? Math.max(0, Math.min(1, (seconds - a.seconds) / duration)) : 0;
  const at = (from: WorldPosition, to: WorldPosition) => {
    const moving = duration > 0 && (from.x !== to.x || from.z !== to.z);
    return { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t,
      heading: moving ? Math.atan2(to.x - from.x, to.z - from.z) : from.heading, moving };
  };
  return { phase: a.phase, predator: at(a.predator, b.predator), prey: at(a.prey, b.prey),
    finished: seconds >= trace.samples.at(-1)!.seconds };
}

/** Local playback only. Pausing/seeking never writes to simulation state. */
export class ReplayClock {
  elapsedMs = 0;
  paused = true;
  speed = 1;
  constructor(readonly durationMs: number) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('invalid replay duration');
  }
  get progress(): number { return this.elapsedMs / this.durationMs; }
  tick(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs < 0) throw new Error('invalid replay delta');
    if (this.paused) return;
    this.elapsedMs = Math.min(this.durationMs, this.elapsedMs + dtMs * this.speed);
    if (this.elapsedMs >= this.durationMs) this.paused = true;
  }
  seek(progress: number): void {
    if (!Number.isFinite(progress)) throw new Error('invalid replay seek');
    this.elapsedMs = Math.max(0, Math.min(1, progress)) * this.durationMs;
    this.paused = true;
  }
  play(): void {
    if (this.progress >= 1) this.elapsedMs = 0;
    this.paused = false;
  }
}
