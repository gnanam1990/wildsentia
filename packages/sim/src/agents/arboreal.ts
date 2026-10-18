import { validSubmerged } from './aquatic.js';
import { type WorldGrid, inCongoChannel, isMovementTrace, positionInPatch, treeAnchorForPatch, treeAnchorGeometry, treeAnchorRemnantForPatch,
  type Agent, type GoalId, type MovementTrace, type TreeAnchorPatch } from '@vana/shared';

/** Explicit, uncalibrated simulation policy; not a species-specific observed climb speed. */
export const TREE_VERTICAL_SPEED_MPS = 0.25;
const CONTACT_EPSILON_M = 1e-6;

/** Checkpoints and callers that predate the species flag (sim_0.37.0 `locomotion.climbsTrees`). */
const legacyClimber = (speciesId: string): boolean => speciesId === 'langur' || speciesId === 'squirrel';
const HEIGHT_EPSILON_M = 1e-9;

/** Check persisted vertical fields without creating a climb or changing a living world.
 * Ground-only v0.23 snapshots need no new fields; existing vulture flight remains valid.
 * A depleted canopy may retain an occupied remnant for timed descent. */
export function validateVerticalCheckpoint(grid: WorldGrid, agent: Agent, patch: TreeAnchorPatch | undefined,
  climbs = legacyClimber(agent.speciesId), flies = agent.speciesId === 'vulture'): void {
  const altitude = agent.altitudeM, mode = agent.locomotionMode, anchorId = agent.treeAnchorId;
  // Congo 1B: a diver saved under water: a finite surfacing time, no height, no tree.
  if (mode === 'submerged') { if (!validSubmerged(agent)) throw new Error('invalid vertical checkpoint'); return; }
  if (agent.submergedUntil !== undefined) throw new Error('invalid vertical checkpoint');
  if (altitude === undefined && mode === undefined && anchorId === undefined) return;
  if (altitude !== undefined && (!Number.isFinite(altitude) || altitude < 0 || altitude > 2_000))
    throw new Error('invalid vertical checkpoint');
  if (mode === 'flight') {
    if (!flies || altitude === undefined || anchorId !== undefined)
      throw new Error('invalid vertical checkpoint');
    return;
  }
  if (mode === 'climb') {
    const geometry = treeAnchorGeometry(grid, agent.patchId);
    if (!geometry || !climbs
      || altitude === undefined || altitude <= 0 || altitude > (flies ? Math.max(geometry.climbHeightM, geometry.perchHeightM) : geometry.climbHeightM)
      || anchorId !== geometry.id || !patch || patch.id !== agent.patchId
      || (!treeAnchorForPatch(grid, patch) && !treeAnchorRemnantForPatch(grid, patch))
      || !positionInPatch(grid, agent.position, agent.patchId)
      || Math.hypot(agent.position.x - geometry.x, agent.position.z - geometry.z) > CONTACT_EPSILON_M)
      throw new Error('invalid vertical checkpoint');
    return;
  }
  if ((mode !== undefined && mode !== 'ground') || anchorId !== undefined
    || altitude !== undefined && altitude !== 0)
    throw new Error('invalid vertical checkpoint');
}

export interface VerticalTravel {
  trace: MovementTrace;
  seconds: number;
  distanceM: number;
  unreachable: boolean;
}

/**
 * Only vertical movement at an already reached, exact shared trunk. The caller must first
 * route the animal across the ground and must decide when/why to call this function.
 * Ground contact, predation, food and event publication are deliberately outside this helper.
 */
export function advanceTreeVertical(grid: WorldGrid, agent: Agent, patch: TreeAnchorPatch,
  direction: 'ascend' | 'descend', goal: GoalId, startWorldTime: number,
  secondsAvailable: number, climbs = legacyClimber(agent.speciesId), heightM?: number): VerticalTravel {
  if (!Number.isSafeInteger(startWorldTime) || startWorldTime < 0
    || !Number.isFinite(secondsAvailable) || secondsAvailable < 0 || secondsAvailable > 3600)
    throw new Error('invalid tree travel time budget');
  if (!agent.position || !positionInPatch(grid, agent.position, agent.patchId))
    throw new Error('missing or invalid tree travel position');
  const geometry = treeAnchorGeometry(grid, patch.id);
  const current = agent.altitudeM ?? 0;
  if (!Number.isFinite(current) || current < 0 || current > (geometry?.climbHeightM ?? 6)
    || (current > 0 && (agent.treeAnchorId !== geometry?.id || agent.locomotionMode !== 'climb'))
    || (current === 0 && (agent.treeAnchorId !== undefined
      || agent.locomotionMode !== undefined && agent.locomotionMode !== 'ground')))
    throw new Error('invalid arboreal vertical state');
  const position = agent.position;
  const trace: MovementTrace = { version: 1, actorId: agent.id, startWorldTime,
    destinationPatchId: patch.id, goal,
    samples: [{ seconds: 0, position: { ...position }, altitudeM: current }],
    completed: false };
  const validContact = geometry && position && positionInPatch(grid, position, patch.id)
    && agent.patchId === patch.id
    && Math.hypot(position.x - geometry.x, position.z - geometry.z) <= CONTACT_EPSILON_M;
  const supported = agent.alive && climbs;
  const eligible = direction === 'descend' ? current > 0 : treeAnchorForPatch(grid, patch) !== null;
  if (!validContact || !supported || !eligible) return { trace, seconds: 0, distanceM: 0, unreachable: true };

  // Up to the climber's own height (locomotion.climbHeightM), at most the tree's.
  const target = direction === 'ascend' ? Math.min(geometry.climbHeightM, heightM ?? geometry.climbHeightM) : 0;
  const remaining = Math.abs(target - current);
  if (remaining <= HEIGHT_EPSILON_M) {
    trace.completed = true;
    return { trace, seconds: 0, distanceM: 0, unreachable: false };
  }
  if (secondsAvailable === 0) return { trace, seconds: 0, distanceM: 0, unreachable: false };
  const seconds = Math.min(secondsAvailable, remaining / TREE_VERTICAL_SPEED_MPS);
  const distanceM = Math.min(remaining, seconds * TREE_VERTICAL_SPEED_MPS);
  const next = direction === 'ascend' ? current + distanceM : current - distanceM;
  trace.samples.push({ seconds, position: { ...position }, altitudeM: next });
  trace.completed = Math.abs(target - next) <= HEIGHT_EPSILON_M;
  if (!isMovementTrace(grid, trace)) throw new Error('invalid tree travel trace');
  if (trace.completed && direction === 'descend') {
    delete agent.altitudeM; delete agent.locomotionMode; delete agent.treeAnchorId;
  } else {
    agent.altitudeM = trace.completed ? target : next;
    agent.locomotionMode = 'climb';
    agent.treeAnchorId = geometry.id;
  }
  agent.state = 'travelling';
  return { trace, seconds, distanceM, unreachable: false };
}

/** A canopy crossing: samples every this many metres along the way from trunk to trunk. */
const CANOPY_SAMPLE_M = 30;

/**
 * Whether a canopy dweller up `from`'s tree can cross aloft to `to`'s: neighbouring patches, both
 * with a climbable tree, and no river channel under the way (the canopy does not meet over it).
 */
export function canopyLinked(grid: WorldGrid, from: TreeAnchorPatch, to: TreeAnchorPatch): boolean {
  if (from.id === to.id) return false;
  const dc = Math.abs((from.id % grid.cols) - (to.id % grid.cols)), dr = Math.abs(Math.floor(from.id / grid.cols) - Math.floor(to.id / grid.cols));
  if (dc > 1 || dr > 1) return false;
  const a = treeAnchorForPatch(grid, from), b = treeAnchorForPatch(grid, to);
  if (!a || !b) return false;
  const seed = to.congoSeed ?? from.congoSeed;
  if (seed === undefined) return true;
  // Whether a river runs between two neighbouring trunks is fixed for a world: found once a pair.
  if (overRiver.seed !== seed || overRiver.grid !== grid) Object.assign(overRiver, { seed, grid, pairs: new Map<number, boolean>() });
  const key = Math.min(from.id, to.id) * grid.cols * grid.rows + Math.max(from.id, to.id);
  let blocked = overRiver.pairs.get(key);
  if (blocked === undefined) {
    const length = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(length / CANOPY_SAMPLE_M));
    blocked = false;
    for (let k = 1; k < steps && !blocked; k++) {
      const t = k / steps;
      blocked = inCongoChannel(grid, seed, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    }
    overRiver.pairs.set(key, blocked);
  }
  return !blocked;
}
const overRiver = { seed: NaN, grid: null as WorldGrid | null, pairs: new Map<number, boolean>() };

/**
 * A canopy dweller crosses aloft from its tree to a neighbouring patch's, branch to branch at
 * `speedMps`, ending up that tree at its own climbing height. The whole way is above the ground,
 * so nothing on the ground can reach it there. Only a crossing it can finish this hour is made.
 */
export function advanceCanopyTraverse(grid: WorldGrid, agent: Agent, from: TreeAnchorPatch, to: TreeAnchorPatch,
  goal: GoalId, startWorldTime: number, secondsAvailable: number, speedMps: number, heightM?: number): { trace: MovementTrace; seconds: number; distanceM: number } | null {
  const a = treeAnchorGeometry(grid, from.id), b = treeAnchorForPatch(grid, to);
  const current = agent.altitudeM ?? 0;
  if (!a || !b || !agent.alive || !agent.position || current <= 0 || agent.locomotionMode !== 'climb'
    || agent.treeAnchorId !== a.id || agent.patchId !== from.id || !canopyLinked(grid, from, to)
    || Math.hypot(agent.position.x - a.x, agent.position.z - a.z) > CONTACT_EPSILON_M) return null;
  const target = Math.min(b.climbHeightM, heightM ?? b.climbHeightM);
  const horizontal = Math.hypot(b.x - a.x, b.z - a.z), distanceM = Math.hypot(horizontal, target - current);
  const seconds = distanceM / speedMps;
  if (!(speedMps > 0) || seconds > secondsAvailable || secondsAvailable > 3600) return null;
  const heading = Math.atan2(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(horizontal / CANOPY_SAMPLE_M));
  const trace: MovementTrace = { version: 1, actorId: agent.id, startWorldTime, destinationPatchId: to.id, goal,
    samples: [{ seconds: 0, position: { x: a.x, z: a.z, heading }, altitudeM: current }], completed: true };
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    trace.samples.push({ seconds: seconds * t, position: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading },
      altitudeM: current + (target - current) * t });
  }
  // The last sample is the far trunk exactly.
  trace.samples[trace.samples.length - 1] = { seconds, position: { x: b.x, z: b.z, heading }, altitudeM: target };
  if (!isMovementTrace(grid, trace)) throw new Error('invalid canopy travel trace');
  agent.position = { x: b.x, z: b.z, heading };
  if (to.id !== agent.patchId) { agent.previousPatchId = agent.patchId; agent.patchId = to.id; }
  agent.altitudeM = target; agent.locomotionMode = 'climb'; agent.treeAnchorId = b.id;
  agent.state = 'travelling';
  return { trace, seconds, distanceM };
}
