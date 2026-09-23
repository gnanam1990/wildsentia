import { GRID_SIZE, PATCH_COUNT } from '@vana/shared';

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
export const EDGE_PATCH_IDS: readonly number[] = Array.from({ length: PATCH_COUNT }, (_, id) => id)
  .filter((id) => {
    const x = id % GRID_SIZE;
    const y = Math.floor(id / GRID_SIZE);
    return x === 0 || y === 0 || x === GRID_SIZE - 1 || y === GRID_SIZE - 1;
  });

export const EDGE_PATCHES: ReadonlySet<number> = new Set(EDGE_PATCH_IDS);
