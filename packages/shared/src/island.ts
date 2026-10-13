import type { Patch } from './types/patch.js';
import { spatialHash } from './spatial.js';
import { ISLAND_GRID, patchCentre, isWorldPosition, type WorldPosition } from './grid.js';

// Island geometry is defined on the 20 × 20 island lattice.
const ISLAND_COLS = ISLAND_GRID.cols, ISLAND_PATCH_M = ISLAND_GRID.patchM;

export type TerrainProfile = 'mainland' | 'island_v1' | 'island_v2' | 'congo_v1';

/** Both closed island profiles (sim_0.37.0 adds `island_v2`, a larger island in the same grid). */
export const isIslandProfile = (profile: TerrainProfile | undefined): boolean =>
  profile === 'island_v1' || profile === 'island_v2';

/** The 48 km Congo-inspired forest (congo_terrain_v1): a separate world, never an island. */
export const isCongoProfile = (profile: TerrainProfile | undefined): boolean => profile === 'congo_v1';

/** A closed world: no mainland exchange or population floors (the islands and Congo). */
export const isClosedProfile = (profile: TerrainProfile | undefined): boolean =>
  isIslandProfile(profile) || isCongoProfile(profile);

/**
 * sim_0.37.0: island geometry is keyed by `Patch.islandSeed`, which every consumer (the simulation,
 * the server and the browser's height field) passes to `islandVertexHeight`. An `island_v2` world
 * keys its geometry as the world seed plus this offset, so the one function draws the larger
 * island wherever the key travels and an `island_v1` world's key, its world seed, is unchanged.
 * Island world seeds must lie in [0, 2^40) for `island_v2` and below 2^40 for `island_v1`.
 */
export const ISLAND_V2_GEOMETRY_OFFSET = 2 ** 40;

export function islandGeometrySeed(seed: number, profile: TerrainProfile): number {
  if (!Number.isSafeInteger(seed) || seed >= ISLAND_V2_GEOMETRY_OFFSET || profile === 'island_v2' && seed < 0)
    throw new Error('island seed out of range');
  return profile === 'island_v2' ? ISLAND_V2_GEOMETRY_OFFSET + seed : seed;
}
export const ISLAND_SEGMENTS = ISLAND_COLS * 12;
export const ISLAND_STEP_M = ISLAND_PATCH_M / 12;
export const ISLAND_SEA_LEVEL_M = 0;
const centre = (ISLAND_COLS - 1) * ISLAND_PATCH_M / 2;

/** Fictional procedural geology, not reconstructed real-world geography. */
export function islandVertexHeight(seed: number, col: number, row: number): number {
  const x = col * ISLAND_STEP_M - ISLAND_PATCH_M / 2 - centre;
  const z = row * ISLAND_STEP_M - ISLAND_PATCH_M / 2 - centre;
  if (seed >= ISLAND_V2_GEOMETRY_OFFSET) return islandV2VertexHeight(seed - ISLAND_V2_GEOMETRY_OFFSET, x, z);
  const phase = spatialHash(`island-v1:${seed}`) / 0xffffffff * Math.PI * 2;
  const angle = Math.atan2(z / 0.88, x), radius = Math.hypot(x, z / 0.88);
  const coast = 2360 + 190 * Math.sin(angle * 3 + phase) + 110 * Math.sin(angle * 5 - phase * 0.7)
    + 65 * Math.cos(angle * 7 + phase);
  const inland = coast - radius;
  if (inland <= 0) return Math.fround(Math.max(-32, inland * 0.055));
  const hills = 0.76 + 0.12 * Math.sin(x / 530 + phase) + 0.12 * Math.cos(z / 670);
  return Math.fround(Math.min(89, inland * 0.065 * hills));
}

/**
 * sim_0.37.0 `island_v2`: the same hills and shelving sea floor as `island_v1`, on a larger,
 * rounder-cornered coast (a superellipse of degree 5, mean half-width 2.92 km, a gentler wobble)
 * that fills the 6 x 6 km grid but for a sea margin of about one patch: about 26 km² of core
 * land on every seed, against about 12.4 km² for `island_v1`.
 */
function islandV2VertexHeight(seed: number, x: number, z: number): number {
  const phase = spatialHash(`island-v2:${seed}`) / 0xffffffff * Math.PI * 2;
  const zz = z / 0.94, angle = Math.atan2(zz, x), radius = (Math.abs(x) ** 5 + Math.abs(zz) ** 5) ** 0.2;
  const coast = 2920 + 110 * (0.5 * Math.sin(angle * 3 + phase) + 0.3 * Math.sin(angle * 5 - phase * 0.7)
    + 0.2 * Math.cos(angle * 7 + phase));
  const inland = coast - radius;
  if (inland <= 0) return Math.fround(Math.max(-32, inland * 0.055));
  const hills = 0.76 + 0.12 * Math.sin(x / 530 + phase) + 0.12 * Math.cos(z / 670);
  return Math.fround(Math.min(89, inland * 0.065 * hills));
}

/** Exact triangle interpolation of the 25 m mesh, shared with the renderer. */
export function islandHeightAt(seed: number, x: number, z: number): number {
  const gx = Math.max(0, Math.min(ISLAND_SEGMENTS - 1e-9, (x + ISLAND_PATCH_M / 2) / ISLAND_STEP_M));
  const gz = Math.max(0, Math.min(ISLAND_SEGMENTS - 1e-9, (z + ISLAND_PATCH_M / 2) / ISLAND_STEP_M));
  const col = Math.floor(gx), row = Math.floor(gz), fx = gx - col, fz = gz - row;
  const a = islandVertexHeight(seed, col, row), b = islandVertexHeight(seed, col, row + 1);
  const c = islandVertexHeight(seed, col + 1, row + 1), d = islandVertexHeight(seed, col + 1, row);
  return fx + fz <= 1 ? a + (d - a) * fx + (b - a) * fz
    : c + (b - c) * (1 - fx) + (d - c) * (1 - fz);
}

/** All triangles in a core land cell are >=2 m above sea. Partial coast is not yet navigable. */
export function islandPatchSurface(seed: number, id: number): 'land' | 'coast' | 'ocean' {
  let min = Infinity, max = -Infinity;
  const x = id % ISLAND_COLS * 12, z = Math.floor(id / ISLAND_COLS) * 12;
  for (let r = 0; r <= 12; r++) for (let c = 0; c <= 12; c++) {
    const y = islandVertexHeight(seed, x + c, z + r); min = Math.min(min, y); max = Math.max(max, y);
  }
  return min >= 2 ? 'land' : max <= 0 ? 'ocean' : 'coast';
}

export const landWalkable = (patch: Pick<Patch, 'surface'> | undefined): boolean => !!patch
  && patch.surface !== 'ocean' && patch.surface !== 'coast';

/** Exact grid-boundary ray traversal. Stops just inside the last permitted land cell. */
export function landRayDistance(patches: readonly Patch[], origin: WorldPosition, heading: number): number {
  if (!isWorldPosition(ISLAND_GRID, origin) || !Number.isFinite(heading)) throw new Error('invalid land ray');
  const vx = Math.sin(heading), vz = Math.cos(heading);
  let col = Math.floor((origin.x + ISLAND_PATCH_M / 2) / ISLAND_PATCH_M);
  let row = Math.floor((origin.z + ISLAND_PATCH_M / 2) / ISLAND_PATCH_M);
  if (!landWalkable(patches[row * ISLAND_COLS + col])) return 0;
  for (let n = 0; n <= ISLAND_COLS * 2; n++) {
    const c = patchCentre(ISLAND_GRID, row * ISLAND_COLS + col);
    const tx = Math.abs(vx) < 1e-12 ? Infinity : (c.x + Math.sign(vx) * ISLAND_PATCH_M / 2 - origin.x) / vx;
    const tz = Math.abs(vz) < 1e-12 ? Infinity : (c.z + Math.sign(vz) * ISLAND_PATCH_M / 2 - origin.z) / vz;
    const next = Math.min(tx, tz);
    if (tx <= next + 1e-8) col += Math.sign(vx);
    if (tz <= next + 1e-8) row += Math.sign(vz);
    if (col < 0 || row < 0 || col >= ISLAND_COLS || row >= ISLAND_COLS || !landWalkable(patches[row * ISLAND_COLS + col]))
      return Math.max(0, next - 0.01);
  }
  throw new Error('land ray failed to leave bounded grid');
}
