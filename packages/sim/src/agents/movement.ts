import { isWorldPosition, type WorldGrid, type WorldPosition } from '@vana/shared';

/** Deterministic straight-line local approach. This is not obstacle/shore pathfinding. */
export function approachContact(
  grid: WorldGrid, from: WorldPosition, target: WorldPosition, speedMs: number, secondsAvailable: number, contactRadiusM: number,
): { position: WorldPosition; distanceM: number; seconds: number; arrived: boolean } {
  if (!isWorldPosition(grid, from) || !isWorldPosition(grid, target)
    || !Number.isFinite(speedMs) || speedMs <= 0
    || !Number.isFinite(secondsAvailable) || secondsAvailable < 0
    || !Number.isFinite(contactRadiusM) || contactRadiusM < 0) {
    throw new Error('invalid contact approach');
  }
  const gap = Math.hypot(target.x - from.x, target.z - from.z);
  const required = Math.max(0, gap - contactRadiusM);
  const distanceM = Math.min(required, speedMs * secondsAvailable);
  const heading = gap > 0 ? Math.atan2(target.x - from.x, target.z - from.z) : from.heading;
  // A convex combination of valid endpoints stays inside the world and cannot overshoot.
  const fraction = gap > 0 ? distanceM / gap : 0;
  return {
    position: { x: from.x + (target.x - from.x) * fraction,
      z: from.z + (target.z - from.z) * fraction, heading },
    distanceM, seconds: distanceM / speedMs, arrived: distanceM >= required,
  };
}
