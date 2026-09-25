import { patchAtPosition, isMovementTrace, isDrinkingActivity, movementAt, treeAnchorGeometry,
  MAX_LIVE_MOVEMENTS, MAX_LIVE_MOVEMENT_SAMPLES, LIFE_STAGES,
  type EncounterAppearance, type LiveEncounterFrame } from '@vana/shared';
import { encounterAt, isRecordedEncounter } from './encounterReplay.js';
import type { AnimalState } from './protocol.js';
import type { RenderPosition } from './space.js';
import type { ClimbVisualPhase, FlightVisualPhase } from './animation.js';
import type { MovementTrace } from '@vana/shared';

/** A wing pose may follow only two explicit adjacent altitude samples from the saved route. */
export function recordedFlightPhase(trace: MovementTrace, seconds: number): FlightVisualPhase | null {
  if (!Number.isFinite(seconds)) return null;
  const samples = trace.samples;
  const last = samples.at(-1)!;
  // A held partial-route endpoint records altitude, not a continuing wingbeat/glide.
  if (seconds >= last.seconds) return null;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]!, b = samples[i + 1]!;
    if (seconds < a.seconds || seconds >= b.seconds) continue;
    if (a.altitudeM === undefined || b.altitudeM === undefined) return null;
    if (b.altitudeM > a.altitudeM) return 'ascending';
    if (b.altitudeM < a.altitudeM) return 'descending';
    return a.altitudeM > 0 ? 'gliding' : null;
  }
  return null;
}

/** Only adjacent saved altitude samples at the shared trunk can authorize a climb pose. */
export function recordedClimbPhase(trace: MovementTrace, seconds: number): ClimbVisualPhase | null {
  if (!Number.isFinite(seconds) || seconds >= trace.samples.at(-1)!.seconds) return null;
  const anchor = treeAnchorGeometry(trace.destinationPatchId);
  if (!anchor) return null;
  for (let i = 0; i < trace.samples.length - 1; i++) {
    const a = trace.samples[i]!, b = trace.samples[i + 1]!;
    if (seconds < a.seconds || seconds >= b.seconds) continue;
    if (a.altitudeM === undefined || b.altitudeM === undefined
      || a.altitudeM < 0 || b.altitudeM < 0
      || a.altitudeM > anchor.climbHeightM || b.altitudeM > anchor.climbHeightM
      || Math.hypot(a.position.x - anchor.x, a.position.z - anchor.z) > 1e-6
      || Math.hypot(b.position.x - anchor.x, b.position.z - anchor.z) > 1e-6) return null;
    if (b.altitudeM > a.altitudeM) return 'ascending';
    if (b.altitudeM < a.altitudeM) return 'descending';
    return null;
  }
  return null;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function appearance(v: unknown, id: string, species: string): v is EncounterAppearance {
  return record(v) && v.id === id && v.speciesId === species && finite(v.sizeRatio)
    && v.sizeRatio > 0 && v.sizeRatio <= 10 && finite(v.coatVariant)
    && (v.sex === undefined || v.sex === 'male' || v.sex === 'female')
    && (v.lifeStage === undefined || LIFE_STAGES.includes(v.lifeStage as typeof LIFE_STAGES[number]));
}

export function isLiveEncounterFrame(value: unknown): value is LiveEncounterFrame {
  if (!record(value) || typeof value.id !== 'string' || !value.id
    || !finite(value.startWorldTime) || value.startWorldTime < 0 || !finite(value.endWorldTime)
    || value.endWorldTime - value.startWorldTime !== 3600 || !finite(value.rate) || value.rate <= 0
    || !finite(value.elapsedWorldSeconds) || value.elapsedWorldSeconds < 0 || value.elapsedWorldSeconds > 3600
    || !Array.isArray(value.encounters) || value.encounters.length > 128) return false;
  const ids = new Set<string>(), events = new Set<string>();
  let samples = 0;
  for (const e of value.encounters) {
    if (!isRecordedEncounter(e) || !record(e) || !e.eventId || events.has(e.eventId)
      || e.trace.startWorldTime !== value.startWorldTime || e.trace.samples.at(-1)!.seconds > 3600
      || !appearance(e.predator, e.trace.predatorId, e.predatorSpecies)
      || !appearance(e.prey, e.trace.preyId, e.preySpecies)) return false;
    events.add(e.eventId);
    for (const id of [e.trace.predatorId, e.trace.preyId]) { if (ids.has(id)) return false; ids.add(id); }
    samples += e.trace.samples.length;
    if (samples > 100_000) return false;
  }
  if (value.movements !== undefined) {
    if (!Array.isArray(value.movements) || value.movements.length > MAX_LIVE_MOVEMENTS) return false;
    let routeSamples = 0;
    for (const m of value.movements) {
      if (!record(m) || typeof m.eventId !== 'string' || !m.eventId || events.has(m.eventId)
        || !isMovementTrace(m.trace) || m.trace.startWorldTime !== value.startWorldTime
        || !record(m.actor) || typeof m.actor.speciesId !== 'string' || !m.actor.speciesId
        || !appearance(m.actor, m.trace.actorId, m.actor.speciesId) || ids.has(m.trace.actorId)) return false;
      ids.add(m.trace.actorId); events.add(m.eventId);
      if (m.stationary !== undefined && m.stationary !== true) return false;
      if (m.activity !== undefined) {
        const activity = m.activity;
        if (!isDrinkingActivity(activity) || !m.trace.completed || m.trace.goal !== 'find_water') return false;
        const last = m.trace.samples.at(-1)!;
        if (Math.hypot(last.position.x - activity.position.x, last.position.z - activity.position.z) > 1e-6
          || Math.abs(last.seconds - activity.startSeconds) > 1e-6) return false;
        if (m.stationary) {
          if (m.trace.samples.length !== 1 || activity.startSeconds !== 0 || m.eventId !== activity.eventId) return false;
        } else if (events.has(activity.eventId)) return false;
        events.add(activity.eventId);
      } else if (m.stationary) return false;
      routeSamples += m.trace.samples.length;
      if (routeSamples > MAX_LIVE_MOVEMENT_SAMPLES) return false;
    }
  }
  return true;
}

export interface LivePose {
  kind?: 'encounter' | 'movement';
  animal: AnimalState;
  position: RenderPosition;
  seconds: number;
  partnerId: string;
  eventId: string;
  phase: string;
  /** Clip choice only; position, timing and outcome remain the recorded server facts. */
  flightVisualPhase?: FlightVisualPhase;
  climbVisualPhase?: ClimbVisualPhase;
}

/** An older saved hour may omit demographic art metadata. Borrow only the same
 * animal's immutable sex and current stage; never borrow outcome, drives, pose
 * or body size from a later checkpoint. New recordings carry both fields. */
export function withRecordedVisualIdentity(recorded: AnimalState, current?: AnimalState): AnimalState {
  if (!current || current.speciesId !== recorded.speciesId) return recorded;
  return { ...recorded, sex: recorded.sex ?? current.sex,
    lifeStage: recorded.lifeStage ?? current.lifeStage };
}

/** Read-only delayed presentation of a checkpointed hour, not another simulation. */
export class LiveEncounterPlayer {
  #frame: LiveEncounterFrame | null = null;
  #receivedAt = 0;
  #elapsed = 0;

  clear(): void { this.#frame = null; }

  current(nowMs: number): LiveEncounterFrame | null {
    return this.#frame && this.elapsed(nowMs) < 3600 ? this.#frame : null;
  }

  apply(value: unknown, nowMs: number): boolean {
    if (value === null) { this.clear(); return true; }
    if (!isLiveEncounterFrame(value) || !finite(nowMs)) return false;
    // Repeated/delayed broadcasts never rewind or restart an encounter. A new process has
    // a new stream ID, so legitimate recovery to an older checkpoint is also supported.
    this.#elapsed = this.#frame?.id === value.id
      ? Math.max(this.elapsed(nowMs), value.elapsedWorldSeconds) : value.elapsedWorldSeconds;
    this.#receivedAt = nowMs;
    this.#frame = value;
    return true;
  }

  elapsed(nowMs: number): number {
    return this.#elapsed + Math.max(0, nowMs - this.#receivedAt) * (this.#frame?.rate ?? 0) / 1000;
  }

  poses(nowMs: number, reducedMotion = false): Map<string, LivePose> {
    const result = new Map<string, LivePose>();
    const frame = this.#frame;
    if (!frame || !finite(nowMs) || reducedMotion) return result;
    const seconds = this.elapsed(nowMs);
    if (seconds >= 3600) return result; // No unlimited extrapolation after disconnection/stall.
    for (const e of frame.encounters) {
      const at = encounterAt(e.trace, seconds);
      const add = (body: EncounterAppearance, position: RenderPosition, state: string, partnerId: string): void => {
        result.set(body.id, { animal: { ...body, patchId: patchAtPosition(position), position,
          state, currentGoal: '', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } },
          position, seconds: Math.min(seconds, e.trace.samples.at(-1)!.seconds), partnerId,
          eventId: e.eventId, phase: at.finished ? `recorded ${e.outcome}` : at.phase });
      };
      add(e.predator, at.predator, at.predator.moving ? at.phase === 'chase' ? 'chasing' : 'stalking' : 'resting', e.prey.id);
      add(e.prey, at.prey, at.finished && e.outcome === 'success' ? 'dead' : at.prey.moving ? 'fleeing' : 'resting', e.predator.id);
    }
    for (const m of frame.movements ?? []) {
      let position = movementAt(m.trace, seconds);
      const activity = m.activity;
      const drinking = activity !== undefined && seconds >= activity.startSeconds && seconds < activity.endSeconds;
      if (activity && seconds >= activity.startSeconds) position = { ...activity.position, moving: false };
      const flightVisualPhase = m.actor.speciesId === 'vulture' && !drinking
        ? recordedFlightPhase(m.trace, seconds) : null;
      const climbVisualPhase = (m.actor.speciesId === 'langur' || m.actor.speciesId === 'squirrel') && !drinking
        ? recordedClimbPhase(m.trace, seconds) : null;
      // Only explicitly recorded drinking gets an action window. Other endpoints stay
      // neutral rather than displaying the newer checkpoint's unrecorded action early.
      result.set(m.actor.id, { kind: 'movement', animal: { ...m.actor, patchId: patchAtPosition(position), position,
        state: drinking ? 'drinking' : position.moving ? m.trace.goal === 'flee' ? 'fleeing' : 'travelling' : 'resting',
        currentGoal: m.trace.goal, drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } },
        position, seconds: Math.min(seconds, activity?.endSeconds ?? m.trace.samples.at(-1)!.seconds), partnerId: '',
        eventId: drinking ? activity!.eventId : m.eventId,
        phase: drinking ? 'recorded drinking window' : activity && seconds >= activity.endSeconds ? 'recorded drinking completed'
          : climbVisualPhase ? `recorded tree ${climbVisualPhase === 'ascending' ? 'ascent' : 'descent'}`
          : position.moving ? 'recorded route' : m.trace.completed ? 'route endpoint' : 'partial route endpoint',
        ...(flightVisualPhase === null ? {} : { flightVisualPhase }),
        ...(climbVisualPhase === null ? {} : { climbVisualPhase }) });
    }
    return result;
  }
}
