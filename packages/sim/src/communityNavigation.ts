import { ISLAND_GRID, islandHeightAt, ISLAND_STEP_M, landWalkable, patchAtPosition, patchCentre, type HumanAction, type HumanTask, type MicroEcologyState, type Patch, type Person, type WorldPosition } from '@vana/shared';
import { approachContact } from './agents/movement.js';

const EPS = 1e-8;
const distance = (a: WorldPosition, b: WorldPosition) => Math.hypot(a.x - b.x, a.z - b.z);
export const humanWalkable = (p: Patch | undefined): boolean => landWalkable(p) && p?.habitat !== 'water';
const cost = (p: Patch) => p.habitat === 'marsh' ? 2.5 : p.habitat === 'shola' ? 1.35 : 1;
const adjacent = (a: number, b: number) => {
  const x = patchCentre(ISLAND_GRID, a), y = patchCentre(ISLAND_GRID, b);
  return Math.abs(x.x - y.x) + Math.abs(x.z - y.z) === ISLAND_GRID.patchM;
};
const neighbours = (id: number, patches: readonly Patch[]) => [...patches[id]!.neighbours]
  .filter(next => adjacent(id, next) && humanWalkable(patches[next])).sort((a, b) => a - b);

/** Patch masks are the broad routing graph. Check the walked line as well: a stale/mismatched
 * island mask must not let a route cross submerged mesh or a water cell between endpoints. */
function footSegment(from: WorldPosition, to: WorldPosition, patches: readonly Patch[]): boolean {
  const length = distance(from, to);
  const samples = Math.max(1, Math.ceil(length / ISLAND_STEP_M));
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
    const patch = patches[patchAtPosition(ISLAND_GRID, { x, z, heading: 0 })];
    if (!humanWalkable(patch) || patch!.islandSeed !== undefined
      && islandHeightAt(patch!.islandSeed, x, z) < 2 - 1e-6) return false;
  }
  return true;
}
const terrainNeighbours = (id: number, patches: readonly Patch[]) => neighbours(id, patches)
  .filter(next => footSegment({ ...patchCentre(ISLAND_GRID, id), heading: 0 }, { ...patchCentre(ISLAND_GRID, next), heading: 0 }, patches));

/** Static terrain knowledge only. Resource perception below is restricted to neighbouring cells.
 * Core island land is wholly above sea; deep-water/coast cells are not footpaths. */
export function humanRoute(from: WorldPosition, destination: WorldPosition, patches: readonly Patch[]): WorldPosition[] | null {
  const start = patchAtPosition(ISLAND_GRID, from), end = patchAtPosition(ISLAND_GRID, destination);
  if (!humanWalkable(patches[start]) || !humanWalkable(patches[end])) return null;
  if (start === end) return footSegment(from, destination, patches) ? [{ ...destination }] : null;
  const startCentre = { ...patchCentre(ISLAND_GRID, start), heading: 0 }, endCentre = { ...patchCentre(ISLAND_GRID, end), heading: 0 };
  if (!footSegment(from, startCentre, patches) || !footSegment(endCentre, destination, patches)) return null;
  const queue = [{ id: start, cost: 0 }], costs = new Map([[start, 0]]), parents = new Map<number, number>();
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || a.id - b.id);
    const current = queue.shift()!;
    if (current.cost !== costs.get(current.id)) continue;
    if (current.id === end) {
      const ids = [end]; let id = end;
      while (id !== start) { id = parents.get(id)!; ids.push(id); }
      return [...ids.reverse().map(id => ({ ...patchCentre(ISLAND_GRID, id), heading: 0 })), { ...destination }];
    }
    for (const next of terrainNeighbours(current.id, patches)) {
      const value = current.cost + (cost(patches[current.id]!) + cost(patches[next]!)) * ISLAND_GRID.patchM / 2;
      if (value >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, value); parents.set(next, current.id); queue.push({ id: next, cost: value });
    }
  }
  return null;
}

/** Work positions remain abstract representative gathering/water sites, not individual fruit trees. */
export function nearbyResource(person: Person, kind: HumanAction, patches: readonly Patch[], micro?: MicroEcologyState): number | null {
  const candidates = [person.patchId, ...terrainNeighbours(person.patchId, patches)];
  const available = (patch: Patch): boolean => {
    if (kind === 'collect_water') return patch.waterVolume >= 1;
    if (kind === 'fish') return patch.waterVolume >= 20 && ['riparian', 'marsh'].includes(patch.habitat)
      && (micro?.patches.find(p => p.patchId === patch.id)?.fishBiomassKg ?? 0) >= .05;
    if (kind === 'gather_fibre') return patch.plant.grass >= .5;
    if (kind === 'gather_timber') return patch.plant.browse >= .5;
    return kind === 'gather_food' && patch.plant.browse >= .25;
  };
  return candidates.filter(id => humanWalkable(patches[id]) && available(patches[id]!)
      && humanRoute(person.position, { ...patchCentre(ISLAND_GRID, id), heading: 0 }, patches) !== null)
    .sort((a, b) => distance(person.position, { ...patchCentre(ISLAND_GRID, a), heading: 0 })
      - distance(person.position, { ...patchCentre(ISLAND_GRID, b), heading: 0 }) || a - b)[0] ?? null;
}

/** Search nearest unvisited accessible land; after coverage revisit the oldest observation.
 * No resource values of distant cells are inspected. Bounded by the 400-cell world. */
export function explorationSite(person: Person, patches: readonly Patch[]): number | null {
  const visited = new Map(person.visitedSites?.map(s => [s.patchId, s.at]));
  if (!footSegment(person.position, { ...patchCentre(ISLAND_GRID, person.patchId), heading: 0 }, patches)) return null;
  const queue = [person.patchId], depth = new Map([[person.patchId, 0]]);
  for (let i = 0; i < queue.length; i++) for (const next of terrainNeighbours(queue[i]!, patches)) {
    if (!depth.has(next)) { depth.set(next, depth.get(queue[i]!)! + 1); queue.push(next); }
  }
  return queue.filter(id => id !== person.patchId).sort((a, b) => {
    const av = visited.get(a), bv = visited.get(b);
    if (av === undefined || bv === undefined) return Number(av !== undefined) - Number(bv !== undefined)
      || depth.get(a)! - depth.get(b)! || a - b;
    return av - bv || depth.get(a)! - depth.get(b)! || a - b;
  })[0] ?? null;
}

/** Contact and distance are paid before task work. Remaining waypoints survive checkpoints. */
export function travelHuman(person: Person, task: HumanTask, patches: readonly Patch[], availableSeconds: number,
  observe?: (spentSeconds: number) => void): number {
  const points = task.journey!.waypoints;
  if (!points.length || patchAtPosition(ISLAND_GRID, task.destination) !== task.journey!.destinationPatchId
    || points.at(-1)!.x !== task.destination.x || points.at(-1)!.z !== task.destination.z)
    throw new Error('invalid human land route');
  // Validate the whole remaining chain before mutating position. A malformed checkpoint must
  // not advance partway and then discover a diagonal jump or blocked waypoint.
  let prior = person.patchId;
  for (const point of points) {
    const next = patchAtPosition(ISLAND_GRID, point);
    if (!humanWalkable(patches[prior]) || !humanWalkable(patches[next])
      || prior !== next && !neighbours(prior, patches).includes(next)) throw new Error('invalid human land route');
    prior = next;
  }
  let spent = 0;
  while (points.length && availableSeconds - spent > EPS) {
    const next = points[0]!, nextId = patchAtPosition(ISLAND_GRID, next), here = patches[person.patchId]!;
    if (!humanWalkable(here) || !humanWalkable(patches[nextId])
      || person.patchId !== nextId && !neighbours(person.patchId, patches).includes(nextId))
      throw new Error('invalid human land route');
    // Charge the slower side of a boundary for this short movement slice. No free terrain transition.
    const speed = 1.1 * (.6 + .4 * person.health) / Math.max(cost(here), cost(patches[nextId]!));
    const movement = approachContact(ISLAND_GRID, person.position, next, speed, availableSeconds - spent, 0);
    if (!footSegment(person.position, movement.position, patches)) throw new Error('invalid human land route');
    person.position = movement.position; person.patchId = patchAtPosition(ISLAND_GRID, person.position); spent += movement.seconds;
    observe?.(spent);
    if (!movement.arrived) break;
    points.shift();
  }
  return spent;
}
