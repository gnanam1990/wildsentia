import { waterAccessPosition } from '@vana/shared';
import type { PatchView } from './terrain.js';

/**
 * The representative drinking pool drawn for an island patch's surface freshwater: a disc at
 * the patch's water access point sized from the stock, not a lake as wide as the patch. Null
 * when the patch holds no surface water or is not on the island.
 */
export function islandPool(patch: PatchView): Pool | null {
  if (patch.islandSeed === undefined || (patch.surface !== undefined && patch.surface !== 'land')) return null;
  if (!Number.isFinite(patch.water) || patch.water <= 0) return null;
  const { x, z } = waterAccessPosition(patch.id);
  return { x, z, radius: Math.max(2, Math.min(40, Math.sqrt(patch.water / 1000 / Math.PI))), seed: patch.id };
}

/** A drinking pool: its centre (the water access point), nominal radius and shape seed. */
export interface Pool { x: number; z: number; radius: number; seed?: number }

/**
 * A waterhole is not a circle. Each pool's shoreline is a gentle, irregular curve: a few
 * low harmonics of the angle, then a per-pool turn and stretch. The edge stays between 0.8 and
 * 1.2 of the nominal radius, so the 1.5 m drinking spots at a 2 m pool are always in the water.
 */
const SHORE_HARMONICS: ReadonlyArray<readonly [number, number, number]> = [[2, 0.06, 0.7], [3, 0.045, 2.1], [5, 0.025, 4.0]];

function unit(seed: number, salt: number): number {
  let h = Math.imul((seed >>> 0) ^ Math.imul(salt + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The shoreline's distance from the centre, in nominal radii, at local angle `a`. */
export function shoreFactor(a: number, seed = 0): number {
  let f = 1;
  for (const [k, amp, phase] of SHORE_HARMONICS) f += amp * Math.sin(k * a + phase + unit(seed, k) * Math.PI * 2);
  return f;
}

/** The pool's own turn (radians about the vertical) and stretch along its local x. */
export function poolFrame(pool: Pool): { turn: number; stretch: number } {
  const seed = pool.seed ?? 0;
  return { turn: unit(seed, 11) * Math.PI * 2, stretch: 0.92 + unit(seed, 12) * 0.16 };
}

/** A world offset from the centre in the pool's unit frame (three.js rotation about Y). */
function toLocal(pool: Pool, dx: number, dz: number): { u: number; v: number } {
  const { turn, stretch } = poolFrame(pool), c = Math.cos(turn), s = Math.sin(turn);
  // Inverse of R_y(turn): x' = c x - s z, z' = s x + c z.
  const x = c * dx - s * dz, z = s * dx + c * dz;
  return { u: x / (pool.radius * stretch), v: z / (pool.radius / stretch) };
}

/** A point of the pool's frame (local u, v in radii) in world x/z. */
export function fromLocal(pool: Pool, u: number, v: number): { x: number; z: number } {
  const { turn, stretch } = poolFrame(pool), c = Math.cos(turn), s = Math.sin(turn);
  const x = u * pool.radius * stretch, z = v * pool.radius / stretch;
  return { x: pool.x + c * x + s * z, z: pool.z - s * x + c * z };
}

/** Grass is kept off this much of the bank round the water: the trampled mud animals drink from. */
export const BANK_CLEAR_M = (pool: Pool): number => 0.4 + pool.radius * 0.18;

/** Whether (x, z) is in the water, or within `margin` metres of it. */
export function insidePool(pool: Pool, x: number, z: number, margin = 0): boolean {
  const { u, v } = toLocal(pool, x - pool.x, z - pool.z);
  return Math.hypot(u, v) < shoreFactor(Math.atan2(v, u), pool.seed) + margin / pool.radius;
}

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
  const wet = (x: number, z: number) => pools.find((p) => insidePool(p, x, z, margin));
  const water = wet(position.x, position.z);
  if (!water) return position;
  const dx = position.x - water.x, dz = position.z - water.z, d = Math.hypot(dx, dz);
  // Exactly at the centre: spread animals round the pool by a stable per-animal angle.
  const angle = d > 1e-3 ? Math.atan2(dx, dz) : (seed % 360) * Math.PI / 180;
  // Walk straight out from this pool's centre until clear of it and of any neighbour it overlaps.
  // From inside the narrowest shore outward in 10 cm steps, so the animal stands at the water's edge.
  let r = water.radius * 0.7, x = 0, z = 0;
  for (let step = 0; step < 2000; step++, r += 0.1) {
    x = water.x + Math.sin(angle) * r; z = water.z + Math.cos(angle) * r;
    if (!wet(x, z)) break;
  }
  const heading = drinking && !position.moving ? Math.atan2(water.x - x, water.z - z) : position.heading;
  return { ...position, x, z, heading };
}
