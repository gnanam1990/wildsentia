import { validSubmerged } from './aquatic.js';
import { type WorldGrid, isMovementTrace, positionInPatch, treeAnchorForPatch, treeAnchorGeometry, treeAnchorRemnantForPatch,
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
      || altitude === undefined || altitude <= 0 || altitude > geometry.climbHeightM
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
