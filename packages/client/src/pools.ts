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
