import { GRID_SIZE, PATCH_METRES, type Patch } from './types/patch.js';
import { patchCentre, spatialHash, isWorldPosition, type WorldPosition } from './spatial.js';

export type TerrainProfile = 'mainland' | 'island_v1';
export const ISLAND_SEGMENTS = GRID_SIZE * 12;
export const ISLAND_STEP_M = PATCH_METRES / 12;
export const ISLAND_SEA_LEVEL_M = 0;
const centre = (GRID_SIZE - 1) * PATCH_METRES / 2;

/** Fictional procedural geology, not reconstructed real-world geography. */
export function islandVertexHeight(seed: number, col: number, row: number): number {
  const x = col * ISLAND_STEP_M - PATCH_METRES / 2 - centre;
  const z = row * ISLAND_STEP_M - PATCH_METRES / 2 - centre;
  const phase = spatialHash(`island-v1:${seed}`) / 0xffffffff * Math.PI * 2;
  const angle = Math.atan2(z / 0.88, x), radius = Math.hypot(x, z / 0.88);
  const coast = 2360 + 190 * Math.sin(angle * 3 + phase) + 110 * Math.sin(angle * 5 - phase * 0.7)
    + 65 * Math.cos(angle * 7 + phase);
  const inland = coast - radius;
  if (inland <= 0) return Math.fround(Math.max(-32, inland * 0.055));
  const hills = 0.76 + 0.12 * Math.sin(x / 530 + phase) + 0.12 * Math.cos(z / 670);
  return Math.fround(Math.min(89, inland * 0.065 * hills));
}

/** Exact triangle interpolation of the 25 m mesh, shared with the renderer. */
export function islandHeightAt(seed: number, x: number, z: number): number {
  const gx = Math.max(0, Math.min(ISLAND_SEGMENTS - 1e-9, (x + PATCH_METRES / 2) / ISLAND_STEP_M));
  const gz = Math.max(0, Math.min(ISLAND_SEGMENTS - 1e-9, (z + PATCH_METRES / 2) / ISLAND_STEP_M));
  const col = Math.floor(gx), row = Math.floor(gz), fx = gx - col, fz = gz - row;
  const a = islandVertexHeight(seed, col, row), b = islandVertexHeight(seed, col, row + 1);
  const c = islandVertexHeight(seed, col + 1, row + 1), d = islandVertexHeight(seed, col + 1, row);
  return fx + fz <= 1 ? a + (d - a) * fx + (b - a) * fz
    : c + (b - c) * (1 - fx) + (d - c) * (1 - fz);
}

/** All triangles in a core land cell are >=2 m above sea. Partial coast is not yet navigable. */
export function islandPatchSurface(seed: number, id: number): 'land' | 'coast' | 'ocean' {
  let min = Infinity, max = -Infinity;
  const x = id % GRID_SIZE * 12, z = Math.floor(id / GRID_SIZE) * 12;
  for (let r = 0; r <= 12; r++) for (let c = 0; c <= 12; c++) {
    const y = islandVertexHeight(seed, x + c, z + r); min = Math.min(min, y); max = Math.max(max, y);
  }
  return min >= 2 ? 'land' : max <= 0 ? 'ocean' : 'coast';
}

export const landWalkable = (patch: Pick<Patch, 'surface'> | undefined): boolean => !!patch
  && patch.surface !== 'ocean' && patch.surface !== 'coast';

/** Exact grid-boundary ray traversal. Stops just inside the last permitted land cell. */
export function landRayDistance(patches: readonly Patch[], origin: WorldPosition, heading: number): number {
  if (!isWorldPosition(origin) || !Number.isFinite(heading)) throw new Error('invalid land ray');
  const vx = Math.sin(heading), vz = Math.cos(heading);
  let col = Math.floor((origin.x + PATCH_METRES / 2) / PATCH_METRES);
  let row = Math.floor((origin.z + PATCH_METRES / 2) / PATCH_METRES);
  if (!landWalkable(patches[row * GRID_SIZE + col])) return 0;
  for (let n = 0; n <= GRID_SIZE * 2; n++) {
    const c = patchCentre(row * GRID_SIZE + col);
    const tx = Math.abs(vx) < 1e-12 ? Infinity : (c.x + Math.sign(vx) * PATCH_METRES / 2 - origin.x) / vx;
    const tz = Math.abs(vz) < 1e-12 ? Infinity : (c.z + Math.sign(vz) * PATCH_METRES / 2 - origin.z) / vz;
    const next = Math.min(tx, tz);
    if (tx <= next + 1e-8) col += Math.sign(vx);
    if (tz <= next + 1e-8) row += Math.sign(vz);
    if (col < 0 || row < 0 || col >= GRID_SIZE || row >= GRID_SIZE || !landWalkable(patches[row * GRID_SIZE + col]))
      return Math.max(0, next - 0.01);
  }
  throw new Error('land ray failed to leave bounded grid');
}
