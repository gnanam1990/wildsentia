import { patchCentre, spatialHash, type WorldPosition } from './spatial.js';
import { PATCH_COUNT } from './types/patch.js';

/** Representative access point for the existing patch water pool, not surveyed shoreline. */
export const WATER_CONTACT_RADIUS_M = 2;
export function waterAccessPosition(patchId: number): WorldPosition {
  if (!Number.isInteger(patchId) || patchId < 0 || patchId >= PATCH_COUNT) throw new Error('invalid water patch');
  return { ...patchCentre(patchId), heading: 0 };
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
