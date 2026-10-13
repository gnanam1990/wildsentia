import { createRng } from '../rng.js';
import { worldExtentM, type WorldGrid } from '../grid.js';

/**
 * congo_terrain_v1: the river network of the Congo-inspired forest, generated from the world's
 * seed. A fictional landscape after the Congo Basin's pattern (one great river crossing the
 * country, tributaries branching into the forest), not a map of any real place.
 */
export const CONGO_TERRAIN_VERSION = 'congo_terrain_v1';
export interface RiverPoint { x: number; z: number; levelM: number }
export interface RiverPath { kind: 'main' | 'tributary'; widthM: number; floodBeltM: number; points: RiverPoint[] }

const MAIN_LEVEL_WEST_M = 340, MAIN_LEVEL_EAST_M = 310, TRIBUTARY_RISE_M_PER_KM = 2.5;
const TRIBUTARY_ATTEMPTS = 6;
/** Main half-width, a tributary channel's half-width on the lattice and one patch: 450 + 225 + 300 m. */
const MAIN_CLEARANCE_M = 975;

/** Chaikin corner cutting, keeping both ends: a smooth bend from a coarse walk. */
function chaikin(points: Array<{ x: number; z: number }>, rounds: number): Array<{ x: number; z: number }> {
  let out = points;
  for (let r = 0; r < rounds; r++) {
    const next = [out[0]!];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i]!, b = out[i + 1]!;
      next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push(out.at(-1)!);
    out = next;
  }
  return out;
}

/** The main river first, then four to six tributaries, each rooted on it. */
export function congoRivers(seed: number, grid: WorldGrid): RiverPath[] {
  const e = worldExtentM(grid), spanX = e.maxX - e.min, spanZ = e.maxZ - e.min;
  if (spanX < 24_000 || spanZ < 24_000) throw new Error('grid is too small for a Congo river network');
  const rng = createRng(seed, CONGO_TERRAIN_VERSION + ':rivers');

  // Main river: a meandering walk west to east, held to the middle half of the map.
  const coarse: Array<{ x: number; z: number }> = [];
  let z = e.min + spanZ * (0.4 + rng.next() * 0.2);
  for (let x = e.min; ; x += 1500) {
    coarse.push({ x: Math.min(x, e.maxX), z });
    if (x >= e.maxX) break;
    z = Math.max(e.min + spanZ * 0.25, Math.min(e.min + spanZ * 0.75, z + (rng.next() - 0.5) * 2400));
  }
  const mainXY = chaikin(coarse, 3);
  const main: RiverPath = { kind: 'main', widthM: 900, floodBeltM: 900,
    points: mainXY.map((p) => ({ ...p, levelM: MAIN_LEVEL_WEST_M + (MAIN_LEVEL_EAST_M - MAIN_LEVEL_WEST_M) * ((p.x - e.min) / spanX) })) };

  // Tributaries: four to six, rooted along the main river, alternating north and south. A walk
  // cut short by the map's edge is drawn again (a fixed number of times) rather than dropped.
  const count = 4 + rng.int(3), rivers: RiverPath[] = [main], margin = grid.patchM;
  for (let t = 0; t < count; t++) {
    const north = t % 2 === 0;
    for (let attempt = 0; attempt < TRIBUTARY_ATTEMPTS; attempt++) {
      const at = Math.floor(((t + 0.5 + (rng.next() - 0.5) * 0.4) / count) * (main.points.length - 1));
      const root = main.points[Math.max(1, Math.min(main.points.length - 2, at))]!;
      // Heading 0 runs north (falling z), π runs south.
      let heading = (north ? 0 : Math.PI) + (rng.next() - 0.5) * 0.8;
      const walk = [{ x: root.x, z: root.z }];
      const steps = 12 + rng.int(9);
      for (let s = 0; s < steps; s++) {
        heading += (rng.next() - 0.5) * 0.6;
        const last = walk.at(-1)!, nx = last.x + Math.sin(heading) * 900, nz = last.z - Math.cos(heading) * 900;
        if (nx < e.min + margin || nx >= e.maxX - margin || nz < e.min + margin || nz >= e.maxZ - margin) break;
        // Never fold back toward the main river: each step must take it further away.
        if (Math.abs(nz - root.z) <= Math.abs(last.z - root.z)) { heading = north ? 0 : Math.PI; continue; }
        // Past its first two reaches, a tributary that comes back within reach of the main
        // channel (where the main river meanders toward it) ends there rather than rejoining it.
        if (walk.length >= 2 && nearestRiver([main], nx, nz).distanceM < MAIN_CLEARANCE_M) break;
        walk.push({ x: nx, z: nz });
      }
      if (walk.length < 8) continue;
      const smoothed = chaikin(walk, 2);
      let along = 0;
      const points = smoothed.map((p, i) => {
        if (i > 0) along += Math.hypot(p.x - smoothed[i - 1]!.x, p.z - smoothed[i - 1]!.z);
        return { ...p, levelM: root.levelM + TRIBUTARY_RISE_M_PER_KM * along / 1000 };
      });
      rivers.push({ kind: 'tributary', widthM: 150, floodBeltM: 300, points });
      break;
    }
  }
  return rivers;
}

/** Distance from (x, z) to one centreline segment, and the water level at its nearest point. */
function toSegment(a: RiverPoint, b: RiverPoint, x: number, z: number): { distanceM: number; levelM: number } {
  const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
  return { distanceM: Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)), levelM: a.levelM + (b.levelM - a.levelM) * t };
}

/** Exact nearest point on any river's centreline, with the river's water level there. Ties go
 * to the earlier river, then the earlier segment. */
export function nearestRiver(rivers: readonly RiverPath[], x: number, z: number): { river: RiverPath; distanceM: number; levelM: number } {
  let best = { river: rivers[0]!, distanceM: Infinity, levelM: rivers[0]!.points[0]!.levelM };
  for (const river of rivers) for (let i = 0; i < river.points.length - 1; i++) {
    const s = toSegment(river.points[i]!, river.points[i + 1]!, x, z);
    if (s.distanceM < best.distanceM) best = { river, distanceM: s.distanceM, levelM: s.levelM };
  }
  return best;
}

const CELL_M = 1_500;

/**
 * `nearestRiver` answered from 1.5 km buckets of centreline segments: the same river, distance
 * and level for every point, ties included, but a lookup reads only the segments near it.
 */
export function riverIndex(rivers: readonly RiverPath[]): (x: number, z: number) => { river: RiverPath; distanceM: number; levelM: number } {
  type Entry = { river: number; segment: number };
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const r of rivers) for (const p of r.points) { minX = Math.min(minX, p.x); minZ = Math.min(minZ, p.z); maxX = Math.max(maxX, p.x); maxZ = Math.max(maxZ, p.z); }
  const cols = Math.floor((maxX - minX) / CELL_M) + 1, rows = Math.floor((maxZ - minZ) / CELL_M) + 1;
  const cells: Entry[][] = Array.from({ length: cols * rows }, () => []);
  rivers.forEach((r, ri) => {
    for (let si = 0; si < r.points.length - 1; si++) {
      const a = r.points[si]!, b = r.points[si + 1]!;
      const c0 = Math.floor((Math.min(a.x, b.x) - minX) / CELL_M), c1 = Math.floor((Math.max(a.x, b.x) - minX) / CELL_M);
      const r0 = Math.floor((Math.min(a.z, b.z) - minZ) / CELL_M), r1 = Math.floor((Math.max(a.z, b.z) - minZ) / CELL_M);
      for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) cells[row * cols + col]!.push({ river: ri, segment: si });
    }
  });
  const seen = new Uint32Array(rivers.reduce((n, r) => Math.max(n, r.points.length), 0) * rivers.length);
  const width = seen.length / rivers.length;
  let stamp = 0;
  return (x, z) => {
    stamp++;
    const qc = Math.floor((x - minX) / CELL_M), qr = Math.floor((z - minZ) / CELL_M);
    // How far the point is from its own cell's nearest edge: rings beyond lie at least this
    // plus whole cells away.
    const fx = x - minX - qc * CELL_M, fz = z - minZ - qr * CELL_M;
    const inset = Math.max(0, Math.min(fx, CELL_M - fx, fz, CELL_M - fz));
    // Rings beyond this cover no cell at all.
    const last = Math.max(qc, cols - 1 - qc, qr, rows - 1 - qr);
    let best = { ri: 0, si: 0, distanceM: Infinity, levelM: rivers[0]!.points[0]!.levelM };
    const visit = (col: number, row: number): void => {
      if (col < 0 || row < 0 || col >= cols || row >= rows) return;
      for (const e of cells[row * cols + col]!) {
        const key = e.river * width + e.segment;
        if (seen[key] === stamp) continue;
        seen[key] = stamp;
        const r = rivers[e.river]!, s = toSegment(r.points[e.segment]!, r.points[e.segment + 1]!, x, z);
        if (s.distanceM < best.distanceM || (s.distanceM === best.distanceM
          && (e.river < best.ri || (e.river === best.ri && e.segment < best.si))))
          best = { ri: e.river, si: e.segment, distanceM: s.distanceM, levelM: s.levelM };
      }
    };
    for (let ring = 0; ring <= last; ring++) {
      // Anything in ring r or beyond is at least inset + (r − 1) cells away: stop once strictly nearer.
      if (ring > 0 && best.distanceM < inset + (ring - 1) * CELL_M) break;
      if (ring === 0) visit(qc, qr);
      else for (let k = -ring; k <= ring; k++) {
        visit(qc + k, qr - ring); visit(qc + k, qr + ring);
        if (k > -ring && k < ring) { visit(qc - ring, qr + k); visit(qc + ring, qr + k); }
      }
    }
    return { river: rivers[best.ri]!, distanceM: best.distanceM, levelM: best.levelM };
  };
}
