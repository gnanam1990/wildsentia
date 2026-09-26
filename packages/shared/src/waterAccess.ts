import { patchCentre, spatialHash, type WorldPosition } from './spatial.js';
import { PATCH_COUNT } from './types/patch.js';

/** Representative access point for the existing patch water pool, not surveyed shoreline. */
export const WATER_CONTACT_RADIUS_M = 2;
export function waterAccessPosition(patchId: number): WorldPosition {
  if (!Number.isInteger(patchId) || patchId < 0 || patchId >= PATCH_COUNT) throw new Error('invalid water patch');
  // Off the patch centre, by a fixed amount per patch: with every pool at its centre the
  // drinkers of the whole island stood on a 300 m lattice, plain to see from above. 30-95 m
  // keeps the point at least 55 m inside its patch. (sim_0.30.0; older saves used the centre.)
  const centre = patchCentre(patchId), h = spatialHash(`water-access:${patchId}`);
  const angle = (h & 0xffff) / 0x10000 * 2 * Math.PI, radius = 30 + ((h >>> 16) & 0xffff) / 0xffff * 65;
  return { x: centre.x + Math.sin(angle) * radius, z: centre.z + Math.cos(angle) * radius, heading: 0 };
}

/** Where the access point was before sim_0.30.0, for reading older recordings only. */
export function legacyWaterAccessPosition(patchId: number): WorldPosition {
  if (!Number.isInteger(patchId) || patchId < 0 || patchId >= PATCH_COUNT) throw new Error('invalid water patch');
  return { ...patchCentre(patchId), heading: 0 };
}

/** At the access point, or at the pre-sim_0.30.0 one: for validating recorded history. */
export function atRecordedWaterAccess(position: WorldPosition, patchId: number): boolean {
  const legacy = legacyWaterAccessPosition(patchId);
  return atWaterAccess(position, patchId)
    || Math.hypot(position.x - legacy.x, position.z - legacy.z) <= WATER_CONTACT_RADIUS_M;
}

/** Stable approach slots avoid assigning every drinker exactly the same endpoint. */
export function waterContactPosition(actorId: string, patchId: number): WorldPosition {
  const source = waterAccessPosition(patchId), angle = spatialHash(actorId) / 0xffffffff * 2 * Math.PI;
  const x = source.x + Math.sin(angle) * 1.5, z = source.z + Math.cos(angle) * 1.5;
  return { x, z, heading: Math.atan2(source.x - x, source.z - z) };
}

export function atWaterAccess(position: WorldPosition, patchId: number): boolean {
  const source = waterAccessPosition(patchId);
  return Math.hypot(position.x - source.x, position.z - source.z) <= WATER_CONTACT_RADIUS_M;
}
