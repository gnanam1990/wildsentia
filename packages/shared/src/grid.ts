import { spatialHash } from './spatial.js';
import type { TerrainProfile } from './island.js';

/** Server-owned planar position. Ground height still comes from the terrain field. */
export interface WorldPosition { x: number; z: number; heading: number }

/**
 * A world's patch lattice. Patch ids run row by row; patch (col, row) is centred at
 * (col · patchM, row · patchM). Regions are square blocks of `regionPatches` patches a side,
 * named `r{regionCol}_{regionRow}`, so a region's id never changes.
 */
export interface WorldGrid { readonly cols: number; readonly rows: number; readonly patchM: number; readonly regionPatches: number }

export const ISLAND_GRID: WorldGrid = Object.freeze({ cols: 20, rows: 20, patchM: 300, regionPatches: 20 });
export const CONGO_GRID: WorldGrid = Object.freeze({ cols: 160, rows: 160, patchM: 300, regionPatches: 20 });

/** The Congo forest is 160 × 160 patches; every other profile is the 20 × 20 island lattice. */
export function gridForProfile(profile: TerrainProfile): WorldGrid { return profile === 'congo_v1' ? CONGO_GRID : ISLAND_GRID; }

export const patchCount = (g: WorldGrid): number => g.cols * g.rows;
export const patchColRow = (g: WorldGrid, id: number): { col: number; row: number } => ({ col: id % g.cols, row: Math.floor(id / g.cols) });

export function patchIdAt(g: WorldGrid, col: number, row: number): number | null {
  return Number.isInteger(col) && Number.isInteger(row) && col >= 0 && row >= 0 && col < g.cols && row < g.rows ? row * g.cols + col : null;
}

/** West, east, north, south: the order the grid has always listed neighbours in. */
export function cardinalNeighbours(g: WorldGrid, id: number): number[] {
  const { col, row } = patchColRow(g, id), out: number[] = [];
  if (col > 0) out.push(id - 1);
  if (col < g.cols - 1) out.push(id + 1);
  if (row > 0) out.push(id - g.cols);
  if (row < g.rows - 1) out.push(id + g.cols);
  return out;
}

export function isEdgePatch(g: WorldGrid, id: number): boolean {
  const { col, row } = patchColRow(g, id);
  return col === 0 || row === 0 || col === g.cols - 1 || row === g.rows - 1;
}

export function worldExtentM(g: WorldGrid): { min: number; maxX: number; maxZ: number } {
  return { min: -g.patchM / 2, maxX: (g.cols - 0.5) * g.patchM, maxZ: (g.rows - 0.5) * g.patchM };
}

export function patchCentre(g: WorldGrid, id: number): { x: number; z: number } {
  return { x: (id % g.cols) * g.patchM, z: Math.floor(id / g.cols) * g.patchM };
}

export function isWorldPosition(g: WorldGrid, value: unknown): value is WorldPosition {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>, e = worldExtentM(g);
  return typeof p.x === 'number' && Number.isFinite(p.x) && p.x >= e.min && p.x < e.maxX
    && typeof p.z === 'number' && Number.isFinite(p.z) && p.z >= e.min && p.z < e.maxZ
    && typeof p.heading === 'number' && Number.isFinite(p.heading) && Math.abs(p.heading) <= Math.PI;
}

export function patchAtPosition(g: WorldGrid, position: WorldPosition): number {
  if (!isWorldPosition(g, position)) throw new Error('position is outside the world');
  return Math.floor((position.z + g.patchM / 2) / g.patchM) * g.cols + Math.floor((position.x + g.patchM / 2) / g.patchM);
}

export function positionInPatch(g: WorldGrid, value: unknown, patchId: number): value is WorldPosition {
  if (!Number.isInteger(patchId) || patchId < 0 || patchId >= patchCount(g) || !isWorldPosition(g, value)) return false;
  const c = patchCentre(g, patchId);
  return value.x >= c.x - g.patchM / 2 && value.x < c.x + g.patchM / 2
    && value.z >= c.z - g.patchM / 2 && value.z < c.z + g.patchM / 2;
}

/** Legacy placement, also the deterministic initial position of an unlocated founder. */
export function subPatchOffset(g: WorldGrid, id: string): { x: number; z: number } {
  const h = spatialHash(id);
  return { x: ((h & 0xffff) / 0xffff - 0.5) * g.patchM * 0.8,
    z: (((h >>> 16) & 0xffff) / 0xffff - 0.5) * g.patchM * 0.8 };
}

export function initialPosition(g: WorldGrid, id: string, patchId: number): WorldPosition {
  const c = patchCentre(g, patchId), o = subPatchOffset(g, id);
  return { x: c.x + o.x, z: c.z + o.z, heading: 0 };
}

export function regionOfPatch(g: WorldGrid, id: number): string {
  const { col, row } = patchColRow(g, id);
  return `r${Math.floor(col / g.regionPatches)}_${Math.floor(row / g.regionPatches)}`;
}

export function regionIds(g: WorldGrid): string[] {
  const out: string[] = [];
  for (let r = 0; r < Math.ceil(g.rows / g.regionPatches); r++)
    for (let c = 0; c < Math.ceil(g.cols / g.regionPatches); c++) out.push(`r${c}_${r}`);
  return out;
}

export function regionPatchIds(g: WorldGrid, regionId: string): number[] {
  const m = /^r(\d+)_(\d+)$/.exec(regionId);
  if (!m) throw new Error(`invalid region id: ${regionId}`);
  const c0 = Number(m[1]) * g.regionPatches, r0 = Number(m[2]) * g.regionPatches, out: number[] = [];
  for (let row = r0; row < Math.min(g.rows, r0 + g.regionPatches); row++)
    for (let col = c0; col < Math.min(g.cols, c0 + g.regionPatches); col++) out.push(row * g.cols + col);
  if (!out.length) throw new Error(`region outside the world: ${regionId}`);
  return out;
}
