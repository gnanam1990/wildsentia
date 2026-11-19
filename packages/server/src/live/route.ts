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
  // The open set is a binary heap of (estimate, patch), with stale entries skipped when popped: a
  // walk across the 160 x 160 Congo grid, or a refusal after every reachable patch, stays a few
  // milliseconds on the world's thread (audit 17 November; tools/ops/routeCost.ts).
  const n = grid.cols * grid.rows, gc = patchCentre(grid, goal);
  const g = new Float64Array(n).fill(Infinity), came = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  const heap = new MinHeap();
  g[start] = 0; heap.push(0, start);
  while (heap.size) {
    const current = heap.pop();
    if (done[current]) continue;
    if (current === goal) break;
    done[current] = 1;
    const cx = current % grid.cols, cy = Math.floor(current / grid.cols);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const next = patchIdAt(grid, cx + dx, cy + dy);
      if (next === null || done[next]) continue;
      if (!landWalkable(patches[next])) continue;
      if (dx && dy && (!landWalkable(patches[cy * grid.cols + cx + dx]) || !landWalkable(patches[(cy + dy) * grid.cols + cx]))) continue;
      const step = grid.patchM * Math.hypot(dx, dy) * (weight(current) + weight(next)) / 2;
      const tentative = g[current]! + step;
      if (tentative >= g[next]!) continue;
      came[next] = current; g[next] = tentative;
      const c = patchCentre(grid, next);
      heap.push(tentative + Math.hypot(c.x - gc.x, c.z - gc.z), next);
    }
  }
  if (g[goal] === Infinity) return null;
  const chain: number[] = [goal];
  while (chain[0] !== start) chain.unshift(came[chain[0]!]!);
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

/** A binary min-heap of patch ids by key; equal keys come out in the order they went in. */
class MinHeap {
  readonly #keys: number[] = [];
  readonly #ids: number[] = [];
  readonly #order: number[] = [];
  #pushed = 0;
  get size(): number { return this.#ids.length; }
  #less(a: number, b: number): boolean {
    return this.#keys[a]! < this.#keys[b]! || (this.#keys[a] === this.#keys[b] && this.#order[a]! < this.#order[b]!);
  }
  #swap(a: number, b: number): void {
    for (const arr of [this.#keys, this.#ids, this.#order]) { const t = arr[a]!; arr[a] = arr[b]!; arr[b] = t; }
  }
  push(key: number, id: number): void {
    let i = this.#ids.length;
    this.#keys.push(key); this.#ids.push(id); this.#order.push(this.#pushed++);
    while (i > 0) { const up = (i - 1) >> 1; if (!this.#less(i, up)) break; this.#swap(i, up); i = up; }
  }
  pop(): number {
    const top = this.#ids[0]!, last = this.#ids.length - 1;
    this.#swap(0, last); this.#keys.pop(); this.#ids.pop(); this.#order.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < this.#ids.length && this.#less(l, m)) m = l;
      if (r < this.#ids.length && this.#less(r, m)) m = r;
      if (m === i) break;
      this.#swap(i, m); i = m;
    }
    return top;
  }
}
