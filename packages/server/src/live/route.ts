import { isWorldPosition, landWalkable, patchAtPosition, patchCentre, patchIdAt, type Patch, type WorldGrid } from '@vana/shared';

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

function onLand(grid: WorldGrid, patches: readonly Patch[], x: number, z: number): boolean {
  const at = { x, z, heading: 0 };
  if (!isWorldPosition(grid, at)) return false;
  return landWalkable(patches[patchAtPosition(grid, at)]);
}

/** Every sampled point of the segment lies on walkable land. */
export function clearOverLand(grid: WorldGrid, patches: readonly Patch[], a: RoutePoint, b: RoutePoint): boolean {
  const length = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(length / SAMPLE_M));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!onLand(grid, patches, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
  }
  return true;
}

export function landRoute(grid: WorldGrid, patches: readonly Patch[], from: RoutePoint, to: RoutePoint, cost: (habitat: string) => number): Route | null {
  if (!onLand(grid, patches, from.x, from.z) || !onLand(grid, patches, to.x, to.z)) return null;
  if (clearOverLand(grid, patches, from, to)) return { points: [{ ...to }], metres: Math.hypot(to.x - from.x, to.z - from.z) };
  const start = patchAtPosition(grid, { ...from, heading: 0 }), goal = patchAtPosition(grid, { ...to, heading: 0 });
  const weight = (id: number) => Math.max(1, cost(patches[id]!.habitat));
  const g = new Map<number, number>([[start, 0]]), came = new Map<number, number>();
  const open = new Set<number>([start]), f = new Map<number, number>([[start, 0]]);
  const h = (id: number) => { const a = patchCentre(grid, id), b = patchCentre(grid, goal); return Math.hypot(a.x - b.x, a.z - b.z); };
  while (open.size) {
    let current = -1, best = Infinity;
    for (const id of open) { const v = f.get(id)!; if (v < best) { best = v; current = id; } }
    if (current === goal) break;
    open.delete(current);
    const cx = current % grid.cols, cy = Math.floor(current / grid.cols);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const next = patchIdAt(grid, cx + dx, cy + dy);
      if (next === null) continue;
      if (!landWalkable(patches[next])) continue;
      if (dx && dy && (!landWalkable(patches[cy * grid.cols + cx + dx]) || !landWalkable(patches[(cy + dy) * grid.cols + cx]))) continue;
      const step = grid.patchM * Math.hypot(dx, dy) * (weight(current) + weight(next)) / 2;
      const tentative = g.get(current)! + step;
      if (tentative >= (g.get(next) ?? Infinity)) continue;
      came.set(next, current); g.set(next, tentative); f.set(next, tentative + h(next)); open.add(next);
    }
  }
  if (!g.has(goal)) return null;
  const chain: number[] = [goal];
  while (chain[0] !== start) chain.unshift(came.get(chain[0]!)!);
  // Through the patch centres: each leg stays inside two neighbouring land patches.
  const raw: RoutePoint[] = [from, ...chain.map((id) => patchCentre(grid, id)), to];
  const pulled: RoutePoint[] = [];
  let at = raw[0]!, i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !clearOverLand(grid, patches, at, raw[j]!)) j--;
    pulled.push({ x: raw[j]!.x, z: raw[j]!.z });
    at = raw[j]!; i = j;
  }
  let metres = 0, prev = from;
  for (const p of pulled) { metres += Math.hypot(p.x - prev.x, p.z - prev.z); prev = p; }
  return { points: pulled, metres };
}
