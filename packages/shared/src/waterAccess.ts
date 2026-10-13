import { spatialHash } from './spatial.js';
import { patchCentre, patchCount, patchIdAt, type WorldGrid, type WorldPosition } from './grid.js';

/** Representative access point for the existing patch water pool, not surveyed shoreline. */
export const WATER_CONTACT_RADIUS_M = 2;

/**
 * What the access point needs to know of the ground, by patch id: which patches are lakes and
 * which are dry land beside them. A world's `patches` array serves as it is.
 */
export type WaterGround = ReadonlyArray<GroundPatch | undefined>;
type GroundPatch = { readonly habitat: string; readonly surface?: string | undefined };

/** Grid steps to the four sides of a patch, in a fixed order. */
const SIDES: ReadonlyArray<readonly [number, number]> = [[0, -1], [-1, 0], [1, 0], [0, 1]];
/** How far inside the lake's edge its shore point lies: the drinking slots stay in the patch. */
const SHORE_INSET_M = 3;

const checked = (grid: WorldGrid, patchId: number): void => {
  if (!Number.isInteger(patchId) || patchId < 0 || patchId >= patchCount(grid)) throw new Error('invalid water patch');
};
const dryLand = (patch: GroundPatch | undefined): boolean => !!patch
  && patch.habitat !== 'water' && patch.surface !== 'ocean' && patch.surface !== 'coast';

/** The point on one side of a lake patch, just inside its edge, at a fixed place along it. */
function shorePosition(grid: WorldGrid, patchId: number, side: readonly [number, number]): WorldPosition {
  const centre = patchCentre(grid, patchId), h = spatialHash(`water-shore:${patchId}:${side[0]},${side[1]}`);
  const along = ((h & 0xffff) / 0xffff * 2 - 1) * grid.patchM / 3, reach = grid.patchM / 2 - SHORE_INSET_M;
  return { x: centre.x + side[0] * reach + side[1] * along, z: centre.z + side[1] * reach + side[0] * along, heading: 0 };
}

/**
 * sim_0.38.0: a lake patch (habitat water) is open water from edge to edge, so its access point
 * is on its shore with dry land: one dry side, chosen by a fixed hash, just inside the edge.
 * Before, a lake used the interior point below like any other patch, and its drinkers stood
 * 30-95 m out in the lake. A lake with no dry side keeps the interior point.
 */
function lakeShore(grid: WorldGrid, patchId: number, ground: WaterGround): WorldPosition | null {
  const patch = ground[patchId];
  if (!patch || patch.habitat !== 'water' || patch.surface === 'ocean' || patch.surface === 'coast') return null;
  const col = patchId % grid.cols, row = Math.floor(patchId / grid.cols);
  const dry = SIDES.filter(([dx, dz]) => { const id = patchIdAt(grid, col + dx, row + dz); return id !== null && dryLand(ground[id]); });
  if (!dry.length) return null;
  return shorePosition(grid, patchId, dry[spatialHash(`water-shore:${patchId}`) % dry.length]!);
}

/** Pass the world's patches (`ground`) wherever a lake may be; without them, the interior point. */
export function waterAccessPosition(grid: WorldGrid, patchId: number, ground?: WaterGround): WorldPosition {
  checked(grid, patchId);
  const shore = ground ? lakeShore(grid, patchId, ground) : null;
  if (shore) return shore;
  // Off the patch centre, by a fixed amount per patch: with every pool at its centre the
  // drinkers of the whole island stood on a 300 m lattice, plain to see from above. 30-95 m
  // keeps the point at least 55 m inside its patch. (sim_0.30.0; older saves used the centre.)
  const centre = patchCentre(grid, patchId), h = spatialHash(`water-access:${patchId}`);
  const angle = (h & 0xffff) / 0x10000 * 2 * Math.PI, radius = 30 + ((h >>> 16) & 0xffff) / 0xffff * 65;
  return { x: centre.x + Math.sin(angle) * radius, z: centre.z + Math.cos(angle) * radius, heading: 0 };
}

/** Where the access point was before sim_0.30.0, for reading older recordings only. */
export function legacyWaterAccessPosition(grid: WorldGrid, patchId: number): WorldPosition {
  checked(grid, patchId);
  return { ...patchCentre(grid, patchId), heading: 0 };
}

/**
 * Every point a recording may name as a patch's water source, without knowing the ground: the
 * interior point, each side's shore point a lake may use (sim_0.38.0), and, last, the
 * pre-sim_0.30.0 centre.
 */
export function recordedWaterAccessPositions(grid: WorldGrid, patchId: number): WorldPosition[] {
  return [waterAccessPosition(grid, patchId), ...SIDES.map(side => shorePosition(grid, patchId, side)), legacyWaterAccessPosition(grid, patchId)];
}

/** At the access point, or at one an older or lake recording used: for validating recorded history. */
export function atRecordedWaterAccess(grid: WorldGrid, position: WorldPosition, patchId: number): boolean {
  return recordedWaterAccessPositions(grid, patchId)
    .some(source => Math.hypot(position.x - source.x, position.z - source.z) <= WATER_CONTACT_RADIUS_M);
}

/** Stable approach slots avoid assigning every drinker exactly the same endpoint. */
export function waterContactPosition(grid: WorldGrid, actorId: string, patchId: number, ground?: WaterGround): WorldPosition {
  const source = waterAccessPosition(grid, patchId, ground), angle = spatialHash(actorId) / 0xffffffff * 2 * Math.PI;
  const x = source.x + Math.sin(angle) * 1.5, z = source.z + Math.cos(angle) * 1.5;
  return { x, z, heading: Math.atan2(source.x - x, source.z - z) };
}

export function atWaterAccess(grid: WorldGrid, position: WorldPosition, patchId: number, ground?: WaterGround): boolean {
  const source = waterAccessPosition(grid, patchId, ground);
  return Math.hypot(position.x - source.x, position.z - source.z) <= WATER_CONTACT_RADIUS_M;
}
