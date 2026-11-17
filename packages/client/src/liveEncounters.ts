import { worldGrid } from './worldGrid.js';
import { patchAtPosition, isMovementTrace, isDrinkingActivity, movementAt, treeAnchorGeometry, MAX_LIVE_MOVEMENTS, MAX_LIVE_MOVEMENT_SAMPLES, LIFE_STAGES, type EncounterAppearance, type LiveEncounterFrame } from '@vana/shared';
import { encounterAt, isRecordedEncounter } from './encounterReplay.js';
import type { AnimalState } from './protocol.js';
import type { RenderPosition } from './space.js';
import { climbs, flies, type ClimbVisualPhase, type FlightVisualPhase } from './animation.js';
import type { MovementTrace } from '@vana/shared';
import { displaySecondAt, paceEncounter, paceMovement, recordedSecondAt, walkingPace, type Pacing } from '@vana/shared';
import { huntMoment } from './huntActs.js';
import { naturalMovementAt, wanderSeed } from './naturalPath.js';

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
    // Level and moving across is a glide; level and still (a bird sitting on its perch) is not.
    const across = Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z) > 1e-6;
    return a.altitudeM > 0 && across ? 'gliding' : null;
  }
  return null;
}

/** Only adjacent saved altitude samples at the shared trunk can authorize a climb pose. */
export function recordedClimbPhase(trace: MovementTrace, seconds: number): ClimbVisualPhase | null {
  if (!Number.isFinite(seconds) || seconds >= trace.samples.at(-1)!.seconds) return null;
  const anchor = treeAnchorGeometry(worldGrid(), trace.destinationPatchId);
  if (!anchor) return null;
  for (let i = 0; i < trace.samples.length - 1; i++) {
    const a = trace.samples[i]!, b = trace.samples[i + 1]!;
    if (seconds < a.seconds || seconds >= b.seconds) continue;
    // Aloft at both ends and moving across: a canopy dweller crossing to the next tree.
    if ((a.altitudeM ?? 0) > 0 && (b.altitudeM ?? 0) > 0
      && Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z) > 1e-6) return 'crossing';
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
        || !isMovementTrace(worldGrid(), m.trace) || m.trace.startWorldTime !== value.startWorldTime
        || !record(m.actor) || typeof m.actor.speciesId !== 'string' || !m.actor.speciesId
        || !appearance(m.actor, m.trace.actorId, m.actor.speciesId) || ids.has(m.trace.actorId)) return false;
      ids.add(m.trace.actorId); events.add(m.eventId);
      if (m.stationary !== undefined && m.stationary !== true) return false;
      if (m.activity !== undefined) {
        const activity = m.activity;
        if (!isDrinkingActivity(worldGrid(), activity) || !m.trace.completed || m.trace.goal !== 'find_water') return false;
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

/** On-screen speed, as a multiple of walking pace, above which a recorded route is run. */
const HURRIED_FACTOR = 1.8;

export interface LivePose {
  kind?: 'encounter' | 'movement';
  animal: AnimalState;
  position: RenderPosition;
  seconds: number;
  /**
   * Real seconds into the shown hour, for the animation clip. Recorded seconds race along
   * at the world's rate (12x, faster still through compressed idle time), so a grazing or
   * resting animal driven by them moved its head and legs frantically.
   */
  clipSeconds?: number;
  /**
   * Moving on screen well above walking pace: an hour holding a longer route than fits at
   * a walk plays it faster, and a walk cycle at that speed looks like fast-forward, so the
   * rig runs instead. Clip choice only.
   */
  hurried?: boolean;
  /** Real seconds into a hunt act (huntActs.ts), and a struggling prey's remaining strength. */
  act?: number;
  actWeight?: number;
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
  /** Presentation pacing per recorded trace; see pacing.ts. Rebuilt with each new frame. */
  #pacing = new WeakMap<object, Pacing>();

  /** Set while the connection is down: nothing is played, but the shown hour's clock runs on. */
  #offline = false;

  clear(): void { this.#frame = null; this.#offline = false; }

  /**
   * The connection dropped. Recorded animals leave the screen, but the island's clock keeps
   * playing the same hour: falling back to the newest saved hour would jump it ahead, and the
   * reconnect would then jump it back.
   */
  disconnect(): void { if (this.#frame) this.#offline = true; }

  current(nowMs: number): LiveEncounterFrame | null {
    return this.#frame && !this.#offline && this.elapsed(nowMs) < 3600 ? this.#frame : null;
  }

  apply(value: unknown, nowMs: number): boolean {
    if (value === null) { this.clear(); return true; }
    if (!isLiveEncounterFrame(value) || !finite(nowMs)) return false;
    // Repeated/delayed broadcasts never rewind or restart an encounter. A new process has
    // a new stream ID, so legitimate recovery to an older checkpoint is also supported.
    this.#elapsed = this.#frame?.id === value.id
      ? Math.max(this.elapsed(nowMs), value.elapsedWorldSeconds) : value.elapsedWorldSeconds;
    this.#receivedAt = nowMs;
    if (this.#frame !== value) this.#pacing = new WeakMap();
    this.#frame = value; this.#offline = false;
    return true;
  }

  /**
   * The island's time as shown: the hour being played, advancing with it. The server works
   * each hour out ahead and the browser plays it through, so this — not the newest saved
   * hour's end — is "now" for everything on screen: clock, light, weather and feed.
   */
  worldTimeAt(nowMs: number): number | null {
    const frame = this.#frame;
    if (!frame || !finite(nowMs)) return null;
    return Math.min(frame.endWorldTime, frame.startWorldTime + Math.max(0, this.elapsed(nowMs)));
  }

  elapsed(nowMs: number): number {
    return this.#elapsed + Math.max(0, nowMs - this.#receivedAt) * (this.#frame?.rate ?? 0) / 1000;
  }

  poses(nowMs: number, reducedMotion = false): Map<string, LivePose> {
    const result = new Map<string, LivePose>();
    const frame = this.#frame;
    if (!frame || this.#offline || !finite(nowMs) || reducedMotion) return result;
    const shown = this.elapsed(nowMs);
    if (shown >= 3600) return result; // No unlimited extrapolation after disconnection/stall.
    const clipSeconds = shown / frame.rate;
    const paced = (trace: object, build: () => Pacing, later = 0): number => {
      let pacing = this.#pacing.get(trace);
      if (pacing === undefined) { pacing = build(); this.#pacing.set(trace, pacing); }
      return recordedSecondAt(pacing, shown + later);
    };
    for (const e of frame.encounters) {
      const seconds = paced(e.trace, () => paceEncounter(e.trace, frame.rate));
      const at = encounterAt(e.trace, seconds);
      // Acts (the spring, the hold, the prey's fall) keep real time, whatever pace the hour plays at.
      const pacing = this.#pacing.get(e.trace)!;
      const moment = huntMoment(e.trace, e.outcome, seconds,
        { phase: at.phase, predatorMoving: at.predator.moving, preyMoving: at.prey.moving, finished: at.finished },
        (recorded) => clipSeconds - displaySecondAt(pacing, recorded) / frame.rate);
      const predatorAt = moment.facePrey
        ? { ...at.predator, heading: Math.atan2(at.prey.x - at.predator.x, at.prey.z - at.predator.z) } : at.predator;
      const add = (body: EncounterAppearance, position: RenderPosition, act: { state: string; act?: number; weight?: number },
        partnerId: string, stooping = false): void => {
        result.set(body.id, { animal: { ...body, patchId: patchAtPosition(worldGrid(), position), position,
          state: act.state, currentGoal: '', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } },
          position, seconds: Math.min(seconds, e.trace.samples.at(-1)!.seconds), clipSeconds, partnerId,
          ...(act.act === undefined ? {} : { act: act.act }), ...(act.weight === undefined ? {} : { actWeight: act.weight }),
          eventId: e.eventId, phase: at.finished ? `recorded ${e.outcome}` : at.phase,
          ...(stooping ? { flightVisualPhase: 'descending' as const } : {}) });
      };
      // A flier hunts from the air: while it closes it is drawn stooping, higher the farther its
      // prey (up to 12 m), down at contact; on foot it covered 18 m a second at a walk.
      const stoop = flies(e.predator.speciesId) && predatorAt.moving && !at.finished;
      const gap = Math.hypot(at.prey.x - predatorAt.x, at.prey.z - predatorAt.z);
      add(e.predator, stoop ? { ...predatorAt, altitudeM: Math.min(12, gap * 0.4) } : predatorAt, moment.predator, e.prey.id, stoop);
      add(e.prey, at.prey, moment.prey, e.predator.id);
    }
    for (const m of frame.movements ?? []) {
      const seconds = paced(m.trace, () => paceMovement(m.trace, m.actor.speciesId, frame.rate));
      // Drawn along a smooth, gently wandering line through the recorded points (naturalPath.ts).
      let position = naturalMovementAt(m.trace, seconds, wanderSeed(m.actor.id), flies(m.actor.speciesId));
      // On-screen speed over the next real second of display.
      const ahead = naturalMovementAt(m.trace, paced(m.trace, () => paceMovement(m.trace, m.actor.speciesId, frame.rate), frame.rate),
        wanderSeed(m.actor.id), flies(m.actor.speciesId));
      const hurried = position.moving && Math.hypot(ahead.x - position.x, ahead.z - position.z) > walkingPace(m.actor.speciesId) * HURRIED_FACTOR;
      const activity = m.activity;
      const drinking = activity !== undefined && seconds >= activity.startSeconds && seconds < activity.endSeconds;
      if (activity && seconds >= activity.startSeconds) position = { ...activity.position, moving: false };
      const flightVisualPhase = flies(m.actor.speciesId) && !drinking
        ? recordedFlightPhase(m.trace, seconds) : null;
      const climbVisualPhase = climbs(m.actor.speciesId) && !drinking
        ? recordedClimbPhase(m.trace, seconds) : null;
      // Only explicitly recorded drinking gets an action window. Other endpoints stay
      // neutral rather than displaying the newer checkpoint's unrecorded action early.
      // How it is carried, for the model drawn: on the wing only while a recorded flight segment
      // plays; still and above the ground it is on a branch (a perched eagle must not be drawn
      // with its wings spread, hanging in the air over its perch).
      const perched = !position.moving && ((position as { altitudeM?: number }).altitudeM ?? 0) > 0.5;
      const locomotionMode = flightVisualPhase !== null ? 'flight' as const : climbVisualPhase !== null || perched ? 'climb' as const : undefined;
      result.set(m.actor.id, { kind: 'movement', animal: { ...m.actor, patchId: patchAtPosition(worldGrid(), position), position,
        ...(locomotionMode === undefined ? {} : { locomotionMode }),
        state: drinking ? 'drinking' : position.moving ? m.trace.goal === 'flee' ? 'fleeing' : 'travelling' : 'resting',
        currentGoal: m.trace.goal, drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } },
        position, seconds: Math.min(seconds, activity?.endSeconds ?? m.trace.samples.at(-1)!.seconds), clipSeconds,
        ...(hurried && !drinking ? { hurried: true } : {}), partnerId: '',
        eventId: drinking ? activity!.eventId : m.eventId,
        phase: drinking ? 'recorded drinking window' : activity && seconds >= activity.endSeconds ? 'recorded drinking completed'
          : climbVisualPhase === 'crossing' ? 'recorded canopy crossing'
          : climbVisualPhase ? `recorded tree ${climbVisualPhase === 'ascending' ? 'ascent' : 'descent'}`
          : position.moving ? 'recorded route' : m.trace.completed ? 'route endpoint' : 'partial route endpoint',
        ...(flightVisualPhase === null ? {} : { flightVisualPhase }),
        ...(climbVisualPhase === null ? {} : { climbVisualPhase }) });
    }
    return result;
  }
}
