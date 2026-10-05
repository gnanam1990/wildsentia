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
  const margin = bodyRadiusM * 0.6;
  const wet = (x: number, z: number) => pools.find((p) => Math.hypot(x - p.x, z - p.z) < p.radius + margin);
  const water = wet(position.x, position.z);
  if (!water) return position;
  const dx = position.x - water.x, dz = position.z - water.z, d = Math.hypot(dx, dz);
  // Exactly at the centre: spread animals round the pool by a stable per-animal angle.
  const angle = d > 1e-3 ? Math.atan2(dx, dz) : (seed % 360) * Math.PI / 180;
  // Walk straight out from this pool's centre until clear of it and of any neighbour it overlaps.
  let r = water.radius + margin + 0.05, x = 0, z = 0;
  for (let step = 0; step < 400; step++, r += 0.25) {
    x = water.x + Math.sin(angle) * r; z = water.z + Math.cos(angle) * r;
    if (!wet(x, z)) break;
  }
  const heading = drinking && !position.moving ? Math.atan2(water.x - x, water.z - z) : position.heading;
  return { ...position, x, z, heading };
}
