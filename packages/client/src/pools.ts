import { waterAccessPosition } from '@vana/shared';
import type { PatchView } from './terrain.js';

/**
 * The representative drinking pool drawn for an island patch's surface freshwater: a disc at
 * the patch's water access point sized from the stock, not a lake as wide as the patch. Null
 * when the patch holds no surface water or is not on the island.
 */
export function islandPool(patch: PatchView): { x: number; z: number; radius: number } | null {
  if (patch.islandSeed === undefined || (patch.surface !== undefined && patch.surface !== 'land')) return null;
  if (!Number.isFinite(patch.water) || patch.water <= 0) return null;
  const { x, z } = waterAccessPosition(patch.id);
  return { x, z, radius: Math.max(2, Math.min(40, Math.sqrt(patch.water / 1000 / Math.PI))) };
}

export interface Pool { x: number; z: number; radius: number }

/**
 * Where an animal recorded at a pool's water access point is drawn: on the shore, not standing
 * on the water surface. The access point is the pool's centre, so a drinking animal would
 * otherwise be drawn in the middle of the disc. Presentation only; the simulation's position is
 * unchanged. Animals already on dry ground are returned as they are. A drinker faces the water.
 */
export function onShore<T extends { x: number; z: number; heading: number; moving?: boolean }>(
  position: T, pools: readonly Pool[], bodyRadiusM: number, drinking: boolean, seed: number,
): T {
  for (const pool of pools) {
    const dx = position.x - pool.x, dz = position.z - pool.z, d = Math.hypot(dx, dz);
    const shore = pool.radius + bodyRadiusM * 0.6;
    if (d >= shore) continue;
    // Exactly at the centre: spread animals round the pool by a stable per-animal angle.
    const angle = d > 1e-3 ? Math.atan2(dx, dz) : (seed % 360) * Math.PI / 180;
    const x = pool.x + Math.sin(angle) * shore, z = pool.z + Math.cos(angle) * shore;
    const heading = drinking && !position.moving ? Math.atan2(pool.x - x, pool.z - z) : position.heading;
    return { ...position, x, z, heading };
  }
  return position;
}
