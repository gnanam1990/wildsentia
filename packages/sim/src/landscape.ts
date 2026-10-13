import { isEdgePatch, patchCount, type WorldGrid } from '@vana/shared';

/**
 * How many animals of a species should cross the forest's edge over `hours`: positive walk in,
 * negative walk out. Movement is proportional to how far this stretch of forest is from the
 * density of the country around it, so a thinned population is refilled slowly and a crowded
 * one bleeds off slowly, the way a small reserve inside a larger landscape behaves.
 */
export function expectedExchange(
  local: number,
  regional: number,
  exchangePerDay: number,
  hours: number,
): number {
  return (regional - local) * exchangePerDay * (hours / 24);
}

/** Patches on the outer ring, where animals enter from and leave to the wider forest. */
export function edgePatchIds(grid: WorldGrid): number[] {
  return Array.from({ length: patchCount(grid) }, (_, id) => id).filter((id) => isEdgePatch(grid, id));
}
