import { initialPosition, patchAtPosition, patchCentre, positionInPatch, PATCH_METRES, landWalkable,
  type Agent, type Patch, type SpeciesConfig, type WorldPosition, type MovementTrace, type GoalId } from '@vana/shared';
import { approachContact } from './movement.js';
import { locateAgent } from './spatial.js';
import { locomotionFactor } from './needs.js';

type Piece = { target: WorldPosition; cost: number };
const distance = (a: WorldPosition, b: WorldPosition): number => Math.hypot(a.x - b.x, a.z - b.z);
const costOf = (p: Patch, cfg: SpeciesConfig): number => {
  if (!landWalkable(p)) return Infinity;
  const value = cfg.locomotion.terrainCost[p.habitat];
  return Number.isFinite(value) && value > 0 ? value : Infinity;
};

/** Split each cardinal edge at its real patch boundary, charging the terrain actually crossed. */
function pieces(from: WorldPosition, fromId: number, toId: number, id: string, patches: Patch[], cfg: SpeciesConfig, endpoint?: WorldPosition): Piece[] {
  const target = endpoint ?? initialPosition(id, toId);
  if (fromId === toId) return [{ target, cost: costOf(patches[toId]!, cfg) }];
  const a = patchCentre(fromId); const b = patchCentre(toId);
  if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== PATCH_METRES) throw new Error('non-cardinal route edge');
  const axis = a.x === b.x ? 'z' : 'x';
  const boundary = (a[axis] + b[axis]) / 2;
  const fraction = (boundary - from[axis]) / (target[axis] - from[axis]);
  const edge = { x: from.x + (target.x - from.x) * fraction,
    z: from.z + (target.z - from.z) * fraction, heading: from.heading };
  return [{ target: edge, cost: costOf(patches[fromId]!, cfg) }, { target, cost: costOf(patches[toId]!, cfg) }];
}

/** Deterministic least-cost search over the static terrain graph. It knows terrain, not animals.
 * Costs are metres weighted by species terrain cost; actual speeds are applied during travel.
 * No decorative tree/rock collision or shoreline topology is claimed. */
export function planRoute(agent: Agent, destination: number, patches: Patch[], cfg: SpeciesConfig, endpoint?: WorldPosition): number[] | null {
  if (endpoint && !positionInPatch(endpoint, destination)) throw new Error('route endpoint outside destination');
  const start = agent.patchId; const origin = locateAgent(agent);
  if (!patches[destination] || !Number.isFinite(costOf(patches[destination]!, cfg))) return null;
  if (start === destination) return [destination];
  const costs = new Map<number, number>([[start, 0]]); const parents = new Map<number, number>();
  const queue: Array<{ id: number; cost: number }> = [{ id: start, cost: 0 }];
  // At most 400 cells. Stable tie-breaking makes replay independent of neighbour-array order.
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || a.id - b.id);
    const current = queue.shift()!;
    if (current.cost !== costs.get(current.id)) continue;
    if (current.id === destination) {
      const route: number[] = []; let id = destination;
      while (id !== start) { route.push(id); id = parents.get(id)!; }
      return route.reverse();
    }
    const point = current.id === start ? origin : initialPosition(agent.id, current.id);
    for (const next of [...patches[current.id]!.neighbours].sort((a, b) => a - b)) {
      if (!patches[next]) continue;
      let length = 0; let last = point;
      for (const piece of pieces(point, current.id, next, agent.id, patches, cfg, next === destination ? endpoint : undefined)) {
        length += distance(last, piece.target) * piece.cost; last = piece.target;
      }
      const value = current.cost + length;
      if (!Number.isFinite(value) || value >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, value); parents.set(next, current.id); queue.push({ id: next, cost: value });
    }
  }
  return null;
}

/** Consume exactly the route distance affordable in this decision's time budget. */
export function navigate(
  agent: Agent, cfg: SpeciesConfig, patches: Patch[], destination: number, goal: GoalId,
  startWorldTime: number, secondsAvailable: number, fleeing = false, endpoint?: WorldPosition,
): { trace: MovementTrace; distanceM: number; seconds: number; sprintSeconds: number; unreachable: boolean } {
  if (!Number.isFinite(secondsAvailable) || secondsAvailable < 0 || !Number.isFinite(startWorldTime)) throw new Error('invalid navigation budget');
  if (endpoint && !positionInPatch(endpoint, destination)) throw new Error('route endpoint outside destination');
  if (cfg.archetype === 'scavenger_flyer') {
    return navigateFlight(agent, cfg, patches, destination, goal, startWorldTime, secondsAvailable, endpoint);
  }
  const from = { ...locateAgent(agent) };
  const trace: MovementTrace = { version: 1, actorId: agent.id, startWorldTime, destinationPatchId: destination,
    goal, samples: [{ seconds: 0, position: from }], completed: false };
  const existing = agent.journey;
  let route = existing?.goal === goal && existing.destinationPatchId === destination ? [...existing.route] : null;
  // A hunt/parent interaction can move the actor off a saved route. Replan only that invalid path.
  let last = agent.patchId;
  if (route && (route.length === 0 || route.at(-1) !== destination || route.some((next) => {
    const valid = landWalkable(patches[next]) && (last === next || patches[last]?.neighbours.includes(next)); last = next; return !valid;
  }))) route = null;
  route ??= planRoute(agent, destination, patches, cfg, endpoint);
  if (!route) { delete agent.journey; return { trace, distanceM: 0, seconds: 0, sprintSeconds: 0, unreachable: true }; }
  const condition = locomotionFactor(agent, cfg) * Math.max(0.15, 1 - agent.drives.fatigue * 0.5);
  const sprintBudget = fleeing ? Math.min(secondsAvailable, cfg.locomotion.sprintStaminaS * (agent.stamina ?? 1)) : 0;
  let seconds = 0; let distanceM = 0; let position = from;
  while (route.length && seconds < secondsAvailable) {
    const next = route[0]!;
    let reached = true;
    for (const piece of pieces(position, patchAtPosition(position), next, agent.id, patches, cfg, next === destination ? endpoint : undefined)) {
      if (!Number.isFinite(piece.cost)) { reached = false; break; }
      // Sprint -> trot is a real speed transition, also recorded in the trace.
      while (distance(position, piece.target) > 1e-8 && seconds < secondsAvailable) {
        const sprint = seconds < sprintBudget;
        const budget = Math.min(secondsAvailable - seconds, sprint ? sprintBudget - seconds : Infinity);
        const speed = (fleeing ? sprint ? cfg.locomotion.sprintMs : cfg.locomotion.trotMs : cfg.locomotion.walkMs) * condition / piece.cost;
        const result = approachContact(position, piece.target, speed, budget, 0);
        seconds += result.seconds; distanceM += result.distanceM; position = result.position;
        trace.samples.push({ seconds, position: { ...position } });
        if (result.arrived) break;
        // The time budget may end exactly at the sprint boundary; continue at trot if possible.
        if (seconds >= secondsAvailable) break;
      }
      if (distance(position, piece.target) > 1e-8) { reached = false; break; }
    }
    if (!reached) break;
    route.shift();
  }
  agent.position = position;
  const finalPatch = patchAtPosition(position);
  if (finalPatch !== agent.patchId) { agent.previousPatchId = agent.patchId; agent.patchId = finalPatch; }
  trace.completed = route.length === 0;
  if (trace.completed) delete agent.journey;
  else agent.journey = { goal, destinationPatchId: destination, route };
  return { trace, distanceM, seconds, sprintSeconds: Math.min(seconds, sprintBudget), unreachable: false };
}

/** Vultures travel above the terrain graph, with an explicit climb/cruise/landing trace. */
function navigateFlight(
  agent: Agent, cfg: SpeciesConfig, patches: Patch[], destination: number, goal: GoalId,
  startWorldTime: number, secondsAvailable: number, endpoint?: WorldPosition,
): { trace: MovementTrace; distanceM: number; seconds: number; sprintSeconds: number; unreachable: boolean } {
  if (!patches[destination] || !landWalkable(patches[destination]!)) {
    return { trace: { version: 1, actorId: agent.id, startWorldTime, destinationPatchId: destination,
      goal, samples: [{ seconds: 0, position: { ...locateAgent(agent) } }], completed: false },
    distanceM: 0, seconds: 0, sprintSeconds: 0, unreachable: true };
  }
  const from = { ...locateAgent(agent) }, target = endpoint ?? initialPosition(agent.id, destination);
  const gap = distance(from, target);
  if (gap <= 1e-8) {
    delete agent.altitudeM; delete agent.locomotionMode; delete agent.journey;
    return { trace: { version: 1, actorId: agent.id, startWorldTime, destinationPatchId: destination,
      goal, samples: [{ seconds: 0, position: from, altitudeM: 0 }], completed: true },
    distanceM: 0, seconds: 0, sprintSeconds: 0, unreachable: false };
  }
  const condition = locomotionFactor(agent, cfg) * Math.max(0.15, 1 - agent.drives.fatigue * 0.5);
  const speed = Math.max(1, cfg.locomotion.sprintMs * condition);
  const travelSeconds = Math.min(secondsAvailable, gap / speed);
  const fraction = Math.min(1, travelSeconds * speed / gap);
  const position = {
    x: from.x + (target.x - from.x) * fraction,
    z: from.z + (target.z - from.z) * fraction,
    heading: Math.atan2(target.x - from.x, target.z - from.z),
  };
  const cruise = Math.max(20, Math.min(120, cfg.escape.flightInitiationM * 1.5));
  const completed = fraction >= 1 - 1e-9;
  const altitudeAt = (seconds: number): number => {
    const climbSeconds = Math.min(20, Math.max(4, gap / speed * 0.15));
    if (completed && seconds >= travelSeconds - climbSeconds) {
      const landing = Math.max(0, (travelSeconds - seconds) / climbSeconds);
      return cruise * landing;
    }
    return cruise * Math.min(1, seconds / climbSeconds);
  };
  const samples = [{ seconds: 0, position: from, altitudeM: agent.altitudeM ?? 0 }];
  // A completed flight starts and ends on the ground. Recording only those endpoints erased
  // the entire airborne interval on playback. Keep the altitude breakpoints as authoritative
  // route samples, within the already allocated horizontal travel time (not extra physics).
  const rampSeconds = Math.min(20, Math.max(4, gap / speed * 0.15));
  const riseEnd = completed ? Math.min(rampSeconds, travelSeconds / 2) : rampSeconds;
  const fallStart = completed ? Math.max(riseEnd, travelSeconds - rampSeconds) : travelSeconds;
  // Short local hops use a low triangular profile, not a full-height cruise in milliseconds.
  const peak = completed ? Math.max(agent.altitudeM ?? 0, cruise * Math.min(1, travelSeconds / (2 * rampSeconds))) : cruise;
  for (const seconds of new Set([riseEnd, fallStart])) {
    if (seconds <= 0 || seconds >= travelSeconds) continue;
    const t = seconds * speed / gap;
    samples.push({ seconds, altitudeM: peak, position: {
      x: from.x + (target.x - from.x) * t, z: from.z + (target.z - from.z) * t,
      heading: position.heading,
    } });
  }
  if (travelSeconds > 0) samples.push({ seconds: travelSeconds, position, altitudeM: altitudeAt(travelSeconds) });
  agent.position = position;
  const finalPatch = patchAtPosition(position);
  if (finalPatch !== agent.patchId) { agent.previousPatchId = agent.patchId; agent.patchId = finalPatch; }
  if (completed) { delete agent.altitudeM; delete agent.locomotionMode; delete agent.journey; }
  else {
    agent.altitudeM = altitudeAt(travelSeconds); agent.locomotionMode = 'flight';
    agent.journey = { goal, destinationPatchId: destination, route: [destination] };
  }
  return { trace: { version: 1, actorId: agent.id, startWorldTime, destinationPatchId: destination,
    goal, samples, completed }, distanceM: gap * fraction, seconds: travelSeconds,
    sprintSeconds: travelSeconds, unreachable: false };
}
