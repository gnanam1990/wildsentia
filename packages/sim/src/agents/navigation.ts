import { congoRiverAt, fliesSpecies, terrainCostFor, initialPosition, inCongoChannel, patchAtPosition, patchCentre, positionInPatch, landWalkable, spatialHash, waterAccessPosition,
  CONGO_GRID, type WorldGrid, type Agent, type Patch, type SpeciesConfig, type WorldPosition, type MovementTrace, type GoalId } from '@vana/shared';
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

/** Whether a river's channel can reach into a patch: its centre is within the channel's half-width
 * and the patch's half-diagonal of the river's line (one lookup a patch, cached). A channel cut
 * through flooded-forest patches too, not only those classed as river. */
const touchCache = { seed: NaN, grid: null as WorldGrid | null, flags: new Uint8Array(0) };
function touchesChannel(grid: WorldGrid, seed: number, patchId: number): boolean {
  if (touchCache.seed !== seed || touchCache.grid !== grid) Object.assign(touchCache, { seed, grid, flags: new Uint8Array(grid.cols * grid.rows) });
  const flags = touchCache.flags;
  if (flags[patchId] === 0) {
    const c = patchCentre(grid, patchId), at = congoRiverAt(grid, seed, c.x, c.z);
    flags[patchId] = at.distanceM <= at.halfM + grid.patchM * Math.SQRT1_2 ? 2 : 1;
  }
  return flags[patchId] === 2;
}

/** A patch's waypoint on a route for an animal that does not cross rivers, the same for every animal
 * near a river (so whether a step crosses a channel is the patches' own, cached): in a patch a channel
 * touches, its dry point nearest the centre; in a patch beside one, its centre (dry, as the channel
 * does not reach it); elsewhere the animal's own fixed spot. */
const passCache = { seed: NaN, grid: null as WorldGrid | null, points: new Map<number, WorldPosition | null>() };
function passPoint(grid: WorldGrid, id: string, patch: Pick<Patch, 'id' | 'congoSeed' | 'habitat'>, cfg: SpeciesConfig): WorldPosition {
  const seed = patch.congoSeed;
  if (seed === undefined || crossesRivers(cfg)) return initialPosition(grid, id, patch.id);
  if (!touchesChannel(grid, seed, patch.id)) {
    const col = patch.id % grid.cols, row = Math.floor(patch.id / grid.cols);
    let beside = false;
    for (let dr = -1; dr <= 1 && !beside; dr++) for (let dc = -1; dc <= 1 && !beside; dc++) {
      const c = col + dc, r = row + dr;
      if ((dc || dr) && c >= 0 && r >= 0 && c < grid.cols && r < grid.rows) beside = touchesChannel(grid, seed, r * grid.cols + c);
    }
    return beside ? { ...patchCentre(grid, patch.id), heading: 0 } : initialPosition(grid, id, patch.id);
  }
  if (passCache.seed !== seed || passCache.grid !== grid) Object.assign(passCache, { seed, grid, points: new Map() });
  let point = passCache.points.get(patch.id);
  if (point === undefined) {
    const c = patchCentre(grid, patch.id), dry = dryGround(grid, seed, patch.id);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < dry.length; i += 2) { const d = Math.hypot(dry[i]! - c.x, dry[i + 1]! - c.z); if (d < bestD) { bestD = d; best = i; } }
    passCache.points.set(patch.id, point = best < 0 ? null : { x: dry[best]!, z: dry[best + 1]!, heading: 0 });
  }
  return point ?? initialPosition(grid, id, patch.id);
}

/** How far into a channel an animal can stand and still walk out (a river patch's drinking point
 * lies up to about 27 m inside it). */
const WADE_OUT_M = 30;

/** Whether a straight step crosses a river's channel (sampled every 15 m; cached by its ends). An
 * animal standing in the water walks out: until it reaches dry ground, water within its first 30 m
 * is not a crossing, nor is water that grows shallower as it goes (heading for the bank, not along
 * or across the river). Without this an animal that drank at a river could never leave it (133
 * duikers and buffalo starved standing there in 40 days), and one already far out in a river when
 * a world was saved stood there for good. */
const crossingCache = new Map<string, boolean>();
const inside = (grid: WorldGrid, seed: number, x: number, z: number) => { const at = congoRiverAt(grid, seed, x, z); return at.halfM + 3 - at.distanceM; };
function stepCrossesChannel(grid: WorldGrid, seed: number, a: WorldPosition, b: WorldPosition): boolean {
  const key = `${seed}:${a.x.toFixed(2)},${a.z.toFixed(2)}>${b.x.toFixed(2)},${b.z.toFixed(2)}`;
  let crosses = crossingCache.get(key);
  if (crosses === undefined) {
    const length = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(length / 15));
    let depth = inside(grid, seed, a.x, a.z), leaving = depth >= 0;
    crosses = false;
    for (let k = 1; k < steps && !crosses; k++) {
      const here = inside(grid, seed, a.x + (b.x - a.x) * k / steps, a.z + (b.z - a.z) * k / steps), wet = here >= 0;
      // Walking out: each sample at least 0.3 m shallower for each metre walked (within some 70° of straight out).
      if (leaving && (!wet || (length * k / steps > WADE_OUT_M && here > depth - 0.3 * length / steps))) leaving = false;
      depth = here;
      crosses = wet && !leaving;
    }
    if (crossingCache.size > 500_000) crossingCache.clear();
    crossingCache.set(key, crosses);
  }
  return crosses;
}

/** How far a straight line from `origin` along `heading` runs before it enters a river's channel
 * (4 m steps, up to 400 m): where a chase stops for an animal that does not swim. */
export function channelRayDistance(grid: WorldGrid, seed: number, origin: WorldPosition, heading: number): number {
  // No river within the ray's reach: one lookup, not a hundred.
  const near = congoRiverAt(grid, seed, origin.x, origin.z);
  if (near.distanceM - near.halfM - 3 > 400) return Infinity;
  const vx = Math.sin(heading), vz = Math.cos(heading);
  for (let d = 4; d <= 400; d += 4) if (inCongoChannel(grid, seed, origin.x + vx * d, origin.z + vz * d)) return Math.max(0, d - 4);
  return Infinity;
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
 * Whether an animal can drink a patch's water without being stranded. A Congo patch's drinking
 * point can lie far out in a river's channel (40-150 m in, measured), and an animal that does not
 * cross rivers that walked out there to drink could not step back out: 133 duikers and buffalo
 * starved standing in the river in 40 days. It drinks only where the point is within wading reach
 * of the bank (fixed for a world, found once a patch).
 */
const drinkCache = { seed: NaN, grid: null as WorldGrid | null, flags: new Uint8Array(0) };
export function waterInReach(grid: WorldGrid, p: Patch, patches: readonly Patch[], cfg: SpeciesConfig): boolean {
  const seed = p.congoSeed;
  if (seed === undefined || crossesRivers(cfg) || !touchesChannel(grid, seed, p.id)) return true;
  if (drinkCache.seed !== seed || drinkCache.grid !== grid) Object.assign(drinkCache, { seed, grid, flags: new Uint8Array(grid.cols * grid.rows) });
  if (drinkCache.flags[p.id] === 0) {
    const at = waterAccessPosition(grid, p.id, patches), river = congoRiverAt(grid, seed, at.x, at.z);
    drinkCache.flags[p.id] = river.halfM - river.distanceM > WADE_OUT_M ? 2 : 1;
  }
  return drinkCache.flags[p.id] === 1;
}

/** A Congo river patch is a place a land animal that does not cross rivers can go to (to drink at
 * its bank, or stand on its dry ground) but never through: its fixed spot on the way may lie in the
 * channel, and a duiker or a golden cat walked out into the middle of a 450 m river. */
function throughOnly(p: Pick<Patch, 'habitat' | 'congoSeed'>, cfg: SpeciesConfig): boolean {
  return p.habitat === 'water' && p.congoSeed !== undefined && !crossesRivers(cfg);
}

/**
 * Where an animal stands in a patch when no exact endpoint is asked for: its own fixed spot,
 * moved to the nearest dry ground for a land animal where a Congo river's channel crosses the
 * patch (blue duikers grazed standing in the river). A swimmer or a flier keeps its spot.
 */
export function standingPoint(grid: WorldGrid, id: string, patch: Pick<Patch, 'id' | 'congoSeed' | 'habitat'>, cfg: SpeciesConfig): WorldPosition {
  const spot = initialPosition(grid, id, patch.id), seed = patch.congoSeed;
  // A bird lands on dry ground too (one came down in the middle of a river and rested on it).
  if (seed === undefined || cfg.locomotion.swims || !touchesChannel(grid, seed, patch.id) || !inCongoChannel(grid, seed, spot.x, spot.z)) return spot;
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

/**
 * Each species' connected regions of a world's patches, built once: a patch counts as passable if
 * it is passable flooded or dry, so a destination outside the start's region cannot be reached in
 * any season. Without this a route search that could not arrive visited every patch it could reach
 * first (about 15,000 for a duiker), and a few such searches were most of a Congo hour's routing.
 * Terrain, surface and river channels are fixed when a world is made; only the flood changes.
 * Null where a patch's neighbours are not mutual, when the search is left to answer alone.
 */
const regionCache = new WeakMap<Patch[], WeakMap<SpeciesConfig, Int32Array | null>>();

function passableInAnySeason(grid: WorldGrid, p: Patch, cfg: SpeciesConfig): boolean {
  if (!landWalkable(p) || throughOnly(p, cfg)) return false;
  if (p.habitat === 'water' && p.congoSeed !== undefined && !crossesRivers(cfg) && allChannel(grid, p.congoSeed, p.id)) return false;
  return [false, true].some((flooded) => { const v = terrainCostFor(cfg, p.habitat, flooded); return Number.isFinite(v) && v > 0; });
}

function regionsOf(grid: WorldGrid, patches: Patch[], cfg: SpeciesConfig): Int32Array | null {
  let bySpecies = regionCache.get(patches);
  if (!bySpecies) regionCache.set(patches, bySpecies = new WeakMap());
  if (bySpecies.has(cfg)) return bySpecies.get(cfg)!;
  const regions = new Int32Array(patches.length).fill(-1), passable = patches.map((p) => passableInAnySeason(grid, p, cfg));
  let mutual = true, region = 0;
  for (let seed = 0; seed < patches.length && mutual; seed++) {
    if (!passable[seed] || regions[seed]! >= 0) continue;
    const stack = [seed]; regions[seed] = region;
    while (stack.length) {
      const id = stack.pop()!;
      for (const next of patches[id]!.neighbours) {
        if (!patches[next]!.neighbours.includes(id)) { mutual = false; break; }
        if (passable[next] && regions[next]! < 0) { regions[next] = region; stack.push(next); }
      }
    }
    region++;
  }
  const result = mutual ? regions : null;
  bySpecies.set(cfg, result);
  return result;
}

/** Whether no route can join two patches: the search expands from the start (passable or not)
 * into its passable neighbours, so a start standing on impassable ground reaches their regions. */
function beyondReach(grid: WorldGrid, patches: Patch[], cfg: SpeciesConfig, start: number, destination: number): boolean {
  const regions = regionsOf(grid, patches, cfg);
  if (!regions) return false;
  // A river patch it goes to but not through is reached from any neighbour in its regions.
  const targets = regions[destination]! >= 0 ? [regions[destination]!]
    : throughOnly(patches[destination]!, cfg) ? patches[destination]!.neighbours.map((n) => regions[n]!).filter((r) => r >= 0) : null;
  if (targets === null) return false;
  const from = regions[start]! >= 0 ? [regions[start]!] : patches[start]!.neighbours.map((n) => regions[n]!).filter((r) => r >= 0);
  return !from.some((r) => targets.includes(r));
}

/** Split each cardinal edge at its real patch boundary, charging the terrain actually crossed. */
function pieces(grid: WorldGrid, from: WorldPosition, fromId: number, toId: number, id: string, patches: Patch[], cfg: SpeciesConfig, endpoint?: WorldPosition, final = false): Piece[] {
  // Only where the animal ends up needs dry footing; the patches it passes through keep their
  // fixed spots (finding a dry one for every patch a route search considers cost a second an hour).
  const target = endpoint ?? (final ? standingPoint(grid, id, patches[toId]!, cfg) : passPoint(grid, id, patches[toId]!, cfg));
  // A step that would cross a channel is closed to an animal that does not cross rivers (an
  // explicit endpoint, at the water's edge or a kill, may step in).
  const blocked = !endpoint && wades(grid, from, target, fromId, toId, patches, cfg);
  if (fromId === toId) return [{ target, cost: blocked ? Infinity : costOf(grid, patches[toId]!, cfg) }];
  const a = patchCentre(grid, fromId); const b = patchCentre(grid, toId);
  if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== grid.patchM) throw new Error('non-cardinal route edge');
  const axis = a.x === b.x ? 'z' : 'x';
  const boundary = (a[axis] + b[axis]) / 2;
  const fraction = (boundary - from[axis]) / (target[axis] - from[axis]);
  const edge = { x: from.x + (target.x - from.x) * fraction,
    z: from.z + (target.z - from.z) * fraction, heading: from.heading };
  return [{ target: edge, cost: blocked ? Infinity : costOf(grid, patches[fromId]!, cfg) }, { target, cost: costOf(grid, patches[toId]!, cfg) }];
}

/** Whether the step between two patches' route waypoints crosses a channel, for an animal that does
 * not cross rivers: fixed for a world, found once a pair (the route search prices every neighbour). */
const pairCache = { seed: NaN, grid: null as WorldGrid | null, pairs: new Map<number, boolean>() };
function wadesBetween(grid: WorldGrid, fromId: number, toId: number, id: string, patches: Patch[], cfg: SpeciesConfig): boolean {
  const seed = patches[toId]!.congoSeed;
  if (seed === undefined || crossesRivers(cfg) || !touchesChannel(grid, seed, fromId) && !touchesChannel(grid, seed, toId)) return false;
  if (pairCache.seed !== seed || pairCache.grid !== grid) Object.assign(pairCache, { seed, grid, pairs: new Map() });
  const key = fromId * grid.cols * grid.rows + toId;
  let crosses = pairCache.pairs.get(key);
  if (crosses === undefined) {
    crosses = stepCrossesChannel(grid, seed, passPoint(grid, id, patches[fromId]!, cfg), passPoint(grid, id, patches[toId]!, cfg));
    pairCache.pairs.set(key, crosses);
  }
  return crosses;
}

/** Whether a step from `from` to `target` would take an animal that does not cross rivers through a channel. */
function wades(grid: WorldGrid, from: WorldPosition, target: WorldPosition, fromId: number, toId: number, patches: Patch[], cfg: SpeciesConfig): boolean {
  const seed = patches[toId]!.congoSeed;
  if (seed === undefined || crossesRivers(cfg) || !touchesChannel(grid, seed, fromId) && !touchesChannel(grid, seed, toId)) return false;
  return stepCrossesChannel(grid, seed, from, target);
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
  endpoint: WorldPosition | undefined, final: boolean, fromWaypoint = false): number {
  const target = endpoint ?? (final ? standingPoint(grid, id, patches[toId]!, cfg) : passPoint(grid, id, patches[toId]!, cfg));
  // Between two waypoints the answer is the pair's (cached); from the animal itself or to its own spot, asked.
  if (!endpoint && (fromWaypoint && !final ? wadesBetween(grid, fromId, toId, id, patches, cfg) : wades(grid, from, target, fromId, toId, patches, cfg))) return Infinity;
  const toCost = costOf(grid, patches[toId]!, cfg);
  if (fromId === toId) return distance(from, target) * toCost;
  const a = patchCentre(grid, fromId), b = patchCentre(grid, toId);
  if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== grid.patchM) throw new Error('non-cardinal route edge');
  const alongX = a.x !== b.x, boundary = alongX ? (a.x + b.x) / 2 : (a.z + b.z) / 2;
  const fraction = (boundary - (alongX ? from.x : from.z)) / ((alongX ? target.x : target.z) - (alongX ? from.x : from.z));
  const ex = from.x + (target.x - from.x) * fraction, ez = from.z + (target.z - from.z) * fraction;
  return Math.hypot(ex - from.x, ez - from.z) * costOf(grid, patches[fromId]!, cfg) + Math.hypot(target.x - ex, target.z - ez) * toCost;
}

/**
 * Where an animal that does not cross rivers, standing out in a river's channel (past the
 * shallows a drinking point lies in), goes first to get out of it: the nearest patch, its own or a
 * neighbour, whose standing point is dry and that it can reach. Null when it is not out in the
 * water, or no way out is found. Without it an animal stranded in a river by a saved world chose
 * its food across the river, found no route there, and starved standing in the water.
 */
export function wayOutOfWater(grid: WorldGrid, agent: Agent, patches: Patch[], cfg: SpeciesConfig): number | null {
  const patch = patches[agent.patchId]!, seed = patch.congoSeed;
  if (seed === undefined || crossesRivers(cfg) || (agent.altitudeM ?? 0) > 0 || !touchesChannel(grid, seed, patch.id)) return null;
  const at = locateAgent(grid, agent);
  if (inside(grid, seed, at.x, at.z) < WADE_OUT_M) return null;
  const ways = [patch.id, ...patch.neighbours].flatMap((id) => {
    const spot = standingPoint(grid, agent.id, patches[id]!, cfg);
    return inCongoChannel(grid, seed, spot.x, spot.z) ? [] : [{ id, d: Math.hypot(spot.x - at.x, spot.z - at.z) }];
  }).sort((a, b) => a.d - b.d || a.id - b.id);
  for (const way of ways) if (planRoute(grid, agent, way.id, patches, cfg) !== null) return way.id;
  return null;
}

/** Deterministic least-cost search over the static terrain graph. It knows terrain, not animals.
 * Costs are metres weighted by species terrain cost; actual speeds are applied during travel.
 * No decorative tree/rock collision or shoreline topology is claimed. */
export function planRoute(grid: WorldGrid, agent: Agent, destination: number, patches: Patch[], cfg: SpeciesConfig, endpoint?: WorldPosition): number[] | null {
  if (endpoint && !positionInPatch(grid, endpoint, destination)) throw new Error('route endpoint outside destination');
  const start = agent.patchId; const origin = locateAgent(grid, agent);
  if (!patches[destination] || !Number.isFinite(costOf(grid, patches[destination]!, cfg))) return null;
  if (start === destination) return [destination];
  if (beyondReach(grid, patches, cfg, start, destination)) return null;
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
    const point = current.id === start ? origin : passPoint(grid, agent.id, patches[current.id]!, cfg);
    for (const next of [...patches[current.id]!.neighbours].sort((a, b) => a - b)) {
      if (!patches[next] || next !== destination && throughOnly(patches[next]!, cfg)) continue;
      const value = current.cost + stepCost(grid, point, current.id, next, agent.id, patches, cfg, next === destination ? endpoint : undefined, next === destination, current.id !== start);
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

/** The least height a bird flies at over the Congo's forest, above its 44 m emergents (metres). */
export const CONGO_FLIGHT_CLEARANCE_M = 55;

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
  const from = { ...locateAgent(grid, agent) }, target = endpoint ?? standingPoint(grid, agent.id, patches[destination]!, cfg);
  // A bird does not land on a river: a patch that is all channel has nowhere to come down.
  const seed = patches[destination]!.congoSeed;
  if (!endpoint && seed !== undefined && inCongoChannel(grid, seed, target.x, target.z)) {
    return { trace: { version: 1, actorId: agent.id, startWorldTime, destinationPatchId: destination,
      goal, samples: [{ seconds: 0, position: from, ...(agent.altitudeM === undefined ? {} : { altitudeM: agent.altitudeM }) }], completed: false },
    distanceM: 0, seconds: 0, sprintSeconds: 0, unreachable: true };
  }
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
  // Over the Congo's forest a bird flies above the canopy (29 m) and its emergents (44 m), not
  // through them; it comes down through the leaves only to land.
  const clearance = grid.cols === CONGO_GRID.cols && grid.rows === CONGO_GRID.rows ? CONGO_FLIGHT_CLEARANCE_M : 0;
  const cruise = Math.max(20, clearance, Math.min(120, cfg.escape.flightInitiationM * 1.5));
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
  const peak = completed ? Math.max(agent.altitudeM ?? 0, clearance, cruise * Math.min(1, travelSeconds / (2 * rampSeconds))) : cruise;
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
