import { GRID_SIZE, PATCH_METRES, landWalkable, patchAtPosition, patchCentre, type Patch } from '@vana/shared';

/**
 * A route over walkable land for an agent's animal (docs/2026-09-26-live-agents-design.md).
 *
 * Whether ground is walkable is decided per 300 m patch, so the search runs over the patch
 * grid: A* through patch centres, weighing each patch by the species' cost of crossing its
 * habitat, with diagonals only where both side patches are land (no cutting a coast corner).
 * The result is then pulled straight: a waypoint is dropped whenever the line past it stays
 * on land, so an open stretch is one straight walk rather than a zigzag of patch centres.
 */

export interface RoutePoint { x: number; z: number }
export interface Route { points: RoutePoint[]; metres: number }

const SAMPLE_M = 20;
const EDGE = GRID_SIZE * PATCH_METRES - PATCH_METRES / 2;

function onLand(patches: readonly Patch[], x: number, z: number): boolean {
  if (!(x >= -PATCH_METRES / 2 && z >= -PATCH_METRES / 2 && x < EDGE && z < EDGE)) return false;
  return landWalkable(patches[patchAtPosition({ x, z, heading: 0 })]);
}

/** Every sampled point of the segment lies on walkable land. */
export function clearOverLand(patches: readonly Patch[], a: RoutePoint, b: RoutePoint): boolean {
  const length = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(length / SAMPLE_M));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!onLand(patches, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
  }
  return true;
}

export function landRoute(patches: readonly Patch[], from: RoutePoint, to: RoutePoint, cost: (habitat: string) => number): Route | null {
  if (!onLand(patches, from.x, from.z) || !onLand(patches, to.x, to.z)) return null;
  if (clearOverLand(patches, from, to)) return { points: [{ ...to }], metres: Math.hypot(to.x - from.x, to.z - from.z) };
  const start = patchAtPosition({ ...from, heading: 0 }), goal = patchAtPosition({ ...to, heading: 0 });
  const weight = (id: number) => Math.max(1, cost(patches[id]!.habitat));
  const g = new Map<number, number>([[start, 0]]), came = new Map<number, number>();
  const open = new Set<number>([start]), f = new Map<number, number>([[start, 0]]);
  const h = (id: number) => { const a = patchCentre(id), b = patchCentre(goal); return Math.hypot(a.x - b.x, a.z - b.z); };
  while (open.size) {
    let current = -1, best = Infinity;
    for (const id of open) { const v = f.get(id)!; if (v < best) { best = v; current = id; } }
    if (current === goal) break;
    open.delete(current);
    const cx = current % GRID_SIZE, cy = Math.floor(current / GRID_SIZE);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) continue;
      const next = ny * GRID_SIZE + nx;
      if (!landWalkable(patches[next])) continue;
      if (dx && dy && (!landWalkable(patches[cy * GRID_SIZE + nx]) || !landWalkable(patches[ny * GRID_SIZE + cx]))) continue;
      const step = PATCH_METRES * Math.hypot(dx, dy) * (weight(current) + weight(next)) / 2;
      const tentative = g.get(current)! + step;
      if (tentative >= (g.get(next) ?? Infinity)) continue;
      came.set(next, current); g.set(next, tentative); f.set(next, tentative + h(next)); open.add(next);
    }
  }
  if (!g.has(goal)) return null;
  const chain: number[] = [goal];
  while (chain[0] !== start) chain.unshift(came.get(chain[0]!)!);
  // Through the patch centres: each leg stays inside two neighbouring land patches.
  const raw: RoutePoint[] = [from, ...chain.map((id) => patchCentre(id)), to];
  const pulled: RoutePoint[] = [];
  let at = raw[0]!, i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !clearOverLand(patches, at, raw[j]!)) j--;
    pulled.push({ x: raw[j]!.x, z: raw[j]!.z });
    at = raw[j]!; i = j;
  }
  let metres = 0, prev = from;
  for (const p of pulled) { metres += Math.hypot(p.x - prev.x, p.z - prev.z); prev = p; }
  return { points: pulled, metres };
}
