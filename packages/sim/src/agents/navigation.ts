import { congoRiverAt, fliesSpecies, terrainCostFor, initialPosition, inCongoChannel, patchAtPosition, patchCentre, positionInPatch, landWalkable, spatialHash,
  type WorldGrid, type Agent, type Patch, type SpeciesConfig, type WorldPosition, type MovementTrace, type GoalId } from '@vana/shared';
import { approachContact } from './movement.js';
import { locateAgent } from './spatial.js';
import { locomotionFactor } from './needs.js';

type Piece = { target: WorldPosition; cost: number };

/** The dry ground of a Congo river patch: points on a 10 m lattice outside the channel, found once a
 * patch (warmDryGround finds them all when a world is made, so no hour pays for them). */
const dryCache = new Map<string, Float64Array>();
function dryGround(grid: WorldGrid, seed: number, patchId: number): Float64Array {
  const key = `${seed}:${grid.cols}x${grid.rows}:${patchId}`;
  let dry = dryCache.get(key);
  if (!dry) {
    const c = patchCentre(grid, patchId), half = grid.patchM / 2 - 1, points: number[] = [];
    for (let x = c.x - half + 4; x <= c.x + half; x += 10) for (let z = c.z - half + 4; z <= c.z + half; z += 10)
      if (!inCongoChannel(grid, seed, x, z)) points.push(x, z);
    dryCache.set(key, dry = Float64Array.from(points));
  }
  return dry;
}

/** Whether a river patch is all channel: its centre lies deeper in the channel than its corner is
 * from its centre (one river lookup, cached). */
const channelCache = new Map<string, Uint8Array>();
function allChannel(grid: WorldGrid, seed: number, patchId: number): boolean {
  const key = `${seed}:${grid.cols}x${grid.rows}`;
  let flags = channelCache.get(key);
  if (!flags) channelCache.set(key, flags = new Uint8Array(grid.cols * grid.rows));
  // 0 unknown, 1 has dry ground, 2 all channel.
  if (flags[patchId] === 0) {
    const c = patchCentre(grid, patchId), at = congoRiverAt(grid, seed, c.x, c.z);
    flags[patchId] = at.distanceM + grid.patchM * Math.SQRT1_2 <= at.halfM ? 2 : 1;
  }
  return flags[patchId] === 2;
}

/** Finds every Congo river patch's dry ground once, when a world is made (about 2 s for seed 7). */
export function warmDryGround(grid: WorldGrid, patches: readonly Pick<Patch, 'id' | 'habitat' | 'congoSeed'>[]): void {
  for (const p of patches) if (p.habitat === 'water' && p.congoSeed !== undefined && !allChannel(grid, p.congoSeed, p.id)) dryGround(grid, p.congoSeed, p.id);
}

/** A land animal that does not swim and finds water hard going (crossing it costs 3 or more: the
 * duikers, the cats, the buffalo, the mangabey) cannot cross a river patch that is all channel. */
function crossesRivers(cfg: SpeciesConfig): boolean {
  return cfg.locomotion.swims !== undefined || fliesSpecies(cfg) || (cfg.locomotion.terrainCost.water ?? Infinity) < 3;
}

/**
 * Where an animal stands in a patch when no exact endpoint is asked for: its own fixed spot,
 * moved to the nearest dry ground for a land animal where a Congo river's channel crosses the
 * patch (blue duikers grazed standing in the river). A swimmer or a flier keeps its spot.
 */
export function standingPoint(grid: WorldGrid, id: string, patch: Pick<Patch, 'id' | 'congoSeed' | 'habitat'>, cfg: SpeciesConfig): WorldPosition {
  const spot = initialPosition(grid, id, patch.id), seed = patch.congoSeed;
  if (seed === undefined || patch.habitat !== 'water' || cfg.locomotion.swims || fliesSpecies(cfg) || !inCongoChannel(grid, seed, spot.x, spot.z)) return spot;
  const dry = dryGround(grid, seed, patch.id);
  let best = -1, bestD = Infinity;
  for (let i = 0; i < dry.length; i += 2) {
    const d = Math.hypot(dry[i]! - spot.x, dry[i + 1]! - spot.z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best < 0 ? spot : { x: dry[best]!, z: dry[best + 1]!, heading: 0 };
}

/** How strongly a species keeps to a habitat (locomotion.habitatPreference): 1 where unnamed. */
export function habitatWeight(cfg: SpeciesConfig, habitat: string): number {
  return cfg.locomotion.habitatPreference?.[habitat] ?? 1;
}

/** A flood-shy animal (crossing flooded forest costs it 3 or more: the duikers, the cats, the
 * buffalo) does not feed or rest standing in a flood; waders (sitatunga, chevrotain, hogs,
 * elephants) and swimmers do. */
export function floodShy(cfg: SpeciesConfig): boolean {
  return (cfg.locomotion.floodedTerrainCost?.flooded_forest ?? 0) >= 3;
}
const distance = (a: WorldPosition, b: WorldPosition): number => Math.hypot(a.x - b.x, a.z - b.z);
const costOf = (grid: WorldGrid, p: Patch, cfg: SpeciesConfig): number => {
  if (!landWalkable(p)) return Infinity;
  if (p.habitat === 'water' && p.congoSeed !== undefined && !crossesRivers(cfg) && allChannel(grid, p.congoSeed, p.id)) return Infinity;
  const value = terrainCostFor(cfg, p.habitat, p.flooded === true);
  return Number.isFinite(value) && value > 0 ? value : Infinity;
};

/** Split each cardinal edge at its real patch boundary, charging the terrain actually crossed. */
function pieces(grid: WorldGrid, from: WorldPosition, fromId: number, toId: number, id: string, patches: Patch[], cfg: SpeciesConfig, endpoint?: WorldPosition, final = false): Piece[] {
  // Only where the animal ends up needs dry footing; the patches it passes through keep their
  // fixed spots (finding a dry one for every patch a route search considers cost a second an hour).
  const target = endpoint ?? (final ? standingPoint(grid, id, patches[toId]!, cfg) : initialPosition(grid, id, toId));
  if (fromId === toId) return [{ target, cost: costOf(grid, patches[toId]!, cfg) }];
  const a = patchCentre(grid, fromId); const b = patchCentre(grid, toId);
  if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== grid.patchM) throw new Error('non-cardinal route edge');
  const axis = a.x === b.x ? 'z' : 'x';
  const boundary = (a[axis] + b[axis]) / 2;
  const fraction = (boundary - from[axis]) / (target[axis] - from[axis]);
  const edge = { x: from.x + (target.x - from.x) * fraction,
    z: from.z + (target.z - from.z) * fraction, heading: from.heading };
  return [{ target: edge, cost: costOf(grid, patches[fromId]!, cfg) }, { target, cost: costOf(grid, patches[toId]!, cfg) }];
}

/**
 * A binary min-heap of (cost, patch id), popping in exactly the order the route search used to
 * sort its whole queue into on every step: on the 25,600-patch Congo forest that sort was a third
 * of an hour's work.
 */
class RouteQueue {
  readonly #ids: number[] = []; readonly #costs: number[] = [];
  get size(): number { return this.#ids.length; }
  #less(a: number, b: number): boolean { return this.#costs[a]! < this.#costs[b]! || (this.#costs[a] === this.#costs[b] && this.#ids[a]! < this.#ids[b]!); }
  #swap(a: number, b: number): void {
    [this.#ids[a], this.#ids[b]] = [this.#ids[b]!, this.#ids[a]!]; [this.#costs[a], this.#costs[b]] = [this.#costs[b]!, this.#costs[a]!];
  }
  push(id: number, cost: number): void {
    this.#ids.push(id); this.#costs.push(cost);
    for (let i = this.#ids.length - 1; i > 0;) { const up = (i - 1) >> 1; if (!this.#less(i, up)) break; this.#swap(i, up); i = up; }
  }
  pop(): { id: number; cost: number } {
    const top = { id: this.#ids[0]!, cost: this.#costs[0]! }, last = this.#ids.length - 1;
    this.#swap(0, last); this.#ids.pop(); this.#costs.pop();
    for (let i = 0; ;) {
      const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < this.#ids.length && this.#less(l, m)) m = l;
      if (r < this.#ids.length && this.#less(r, m)) m = r;
      if (m === i) break; this.#swap(i, m); i = m;
    }
    return top;
  }
}

/** The cost of one route step: the same sum as walking `pieces`, without building them (the
 * route search prices every neighbour it considers). */
function stepCost(grid: WorldGrid, from: WorldPosition, fromId: number, toId: number, id: string, patches: Patch[], cfg: SpeciesConfig,
  endpoint: WorldPosition | undefined, final: boolean): number {
  const target = endpoint ?? (final ? standingPoint(grid, id, patches[toId]!, cfg) : initialPosition(grid, id, toId));
  const toCost = costOf(grid, patches[toId]!, cfg);
  if (fromId === toId) return distance(from, target) * toCost;
  const a = patchCentre(grid, fromId), b = patchCentre(grid, toId);
  if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== grid.patchM) throw new Error('non-cardinal route edge');
  const alongX = a.x !== b.x, boundary = alongX ? (a.x + b.x) / 2 : (a.z + b.z) / 2;
  const fraction = (boundary - (alongX ? from.x : from.z)) / ((alongX ? target.x : target.z) - (alongX ? from.x : from.z));
  const ex = from.x + (target.x - from.x) * fraction, ez = from.z + (target.z - from.z) * fraction;
  return Math.hypot(ex - from.x, ez - from.z) * costOf(grid, patches[fromId]!, cfg) + Math.hypot(target.x - ex, target.z - ez) * toCost;
}

/** Deterministic least-cost search over the static terrain graph. It knows terrain, not animals.
 * Costs are metres weighted by species terrain cost; actual speeds are applied during travel.
 * No decorative tree/rock collision or shoreline topology is claimed. */
export function planRoute(grid: WorldGrid, agent: Agent, destination: number, patches: Patch[], cfg: SpeciesConfig, endpoint?: WorldPosition): number[] | null {
  if (endpoint && !positionInPatch(grid, endpoint, destination)) throw new Error('route endpoint outside destination');
  const start = agent.patchId; const origin = locateAgent(grid, agent);
  if (!patches[destination] || !Number.isFinite(costOf(grid, patches[destination]!, cfg))) return null;
  if (start === destination) return [destination];
  const costs = new Map<number, number>([[start, 0]]); const parents = new Map<number, number>();
  const queue = new RouteQueue(); queue.push(start, 0);
  // Stable tie-breaking (cost, then patch id) makes replay independent of neighbour-array order.
  while (queue.size) {
    const current = queue.pop();
    if (current.cost !== costs.get(current.id)) continue;
    if (current.id === destination) {
      const route: number[] = []; let id = destination;
      while (id !== start) { route.push(id); id = parents.get(id)!; }
      return route.reverse();
    }
    const point = current.id === start ? origin : initialPosition(grid, agent.id, current.id);
    for (const next of [...patches[current.id]!.neighbours].sort((a, b) => a - b)) {
      if (!patches[next]) continue;
      const value = current.cost + stepCost(grid, point, current.id, next, agent.id, patches, cfg, next === destination ? endpoint : undefined, next === destination);
      if (!Number.isFinite(value) || value >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, value); parents.set(next, current.id); queue.push(next, value);
    }
  }
  return null;
}

/** Consume exactly the route distance affordable in this decision's time budget. */
export function navigate(
  grid: WorldGrid, agent: Agent, cfg: SpeciesConfig, patches: Patch[], destination: number, goal: GoalId,
  startWorldTime: number, secondsAvailable: number, fleeing = false, endpoint?: WorldPosition,
): { trace: MovementTrace; distanceM: number; seconds: number; sprintSeconds: number; unreachable: boolean } {
  if (!Number.isFinite(secondsAvailable) || secondsAvailable < 0 || !Number.isFinite(startWorldTime)) throw new Error('invalid navigation budget');
  if (endpoint && !positionInPatch(grid, endpoint, destination)) throw new Error('route endpoint outside destination');
  if (fliesSpecies(cfg)) {
    return navigateFlight(grid, agent, cfg, patches, destination, goal, startWorldTime, secondsAvailable, endpoint);
  }
  const from = { ...locateAgent(grid, agent) };
  const trace: MovementTrace = { version: 1, actorId: agent.id, startWorldTime, destinationPatchId: destination,
    goal, samples: [{ seconds: 0, position: from }], completed: false };
  const existing = agent.journey;
  let route = existing?.goal === goal && existing.destinationPatchId === destination ? [...existing.route] : null;
  // A hunt/parent interaction can move the actor off a saved route. Replan only that invalid path.
  let last = agent.patchId;
  if (route && (route.length === 0 || route.at(-1) !== destination || route.some((next) => {
    const valid = landWalkable(patches[next]) && Number.isFinite(costOf(grid, patches[next]!, cfg))
      && (last === next || patches[last]?.neighbours.includes(next)); last = next; return !valid;
  }))) route = null;
  route ??= planRoute(grid, agent, destination, patches, cfg, endpoint);
  if (!route) { delete agent.journey; return { trace, distanceM: 0, seconds: 0, sprintSeconds: 0, unreachable: true }; }
  const condition = locomotionFactor(agent, cfg) * Math.max(0.15, 1 - agent.drives.fatigue * 0.5);
  const sprintBudget = fleeing ? Math.min(secondsAvailable, cfg.locomotion.sprintStaminaS * (agent.stamina ?? 1)) : 0;
  let seconds = 0; let distanceM = 0; let position = from;
  while (route.length && seconds < secondsAvailable) {
    const next = route[0]!;
    let reached = true;
    for (const piece of pieces(grid, position, patchAtPosition(grid, position), next, agent.id, patches, cfg, next === destination ? endpoint : undefined, next === destination)) {
      if (!Number.isFinite(piece.cost)) { reached = false; break; }
      // Sprint -> trot is a real speed transition, also recorded in the trace.
      while (distance(position, piece.target) > 1e-8 && seconds < secondsAvailable) {
        const sprint = seconds < sprintBudget;
        const budget = Math.min(secondsAvailable - seconds, sprint ? sprintBudget - seconds : Infinity);
        const speed = (fleeing ? sprint ? cfg.locomotion.sprintMs : cfg.locomotion.trotMs : cfg.locomotion.walkMs) * condition / piece.cost;
        const result = approachContact(grid, position, piece.target, speed, budget, 0);
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
  const finalPatch = patchAtPosition(grid, position);
  if (finalPatch !== agent.patchId) { agent.previousPatchId = agent.patchId; agent.patchId = finalPatch; }
  trace.completed = route.length === 0;
  if (trace.completed) delete agent.journey;
  else agent.journey = { goal, destinationPatchId: destination, route };
  return { trace, distanceM, seconds, sprintSeconds: Math.min(seconds, sprintBudget), unreachable: false };
}

/** Vultures travel above the terrain graph, with an explicit climb/cruise/landing trace. */
function navigateFlight(
  grid: WorldGrid, agent: Agent, cfg: SpeciesConfig, patches: Patch[], destination: number, goal: GoalId,
  startWorldTime: number, secondsAvailable: number, endpoint?: WorldPosition,
): { trace: MovementTrace; distanceM: number; seconds: number; sprintSeconds: number; unreachable: boolean } {
  if (!patches[destination] || !landWalkable(patches[destination]!)) {
    return { trace: { version: 1, actorId: agent.id, startWorldTime, destinationPatchId: destination,
      goal, samples: [{ seconds: 0, position: { ...locateAgent(grid, agent) } }], completed: false },
    distanceM: 0, seconds: 0, sprintSeconds: 0, unreachable: true };
  }
  const from = { ...locateAgent(grid, agent) }, target = endpoint ?? initialPosition(grid, agent.id, destination);
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
  // sim_0.38.0: the climb starts from where the bird is. One already aloft that resumes with only
  // seconds to fly stayed on a climb from the ground and sank mid-air.
  const startAltitude = Math.min(cruise, agent.altitudeM ?? 0);
  const altitudeAt = (seconds: number): number => {
    const climbSeconds = Math.min(20, Math.max(4, gap / speed * 0.15));
    if (completed && seconds >= travelSeconds - climbSeconds) {
      const landing = Math.max(0, (travelSeconds - seconds) / climbSeconds);
      return Math.max(startAltitude, cruise) * landing;
    }
    return startAltitude + (cruise - startAltitude) * Math.min(1, seconds / climbSeconds);
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
  const finalPatch = patchAtPosition(grid, position);
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
