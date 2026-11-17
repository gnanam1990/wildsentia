import { movementAt, type MovementTrace } from '@vana/shared';

/**
 * How a recorded route is drawn. The simulation plans routes across its 300 m patch grid, so a
 * route is a chain of long, mostly north-south or east-west legs walked at a steady pace: drawn
 * as recorded, nine animals in ten crossed the screen along the four compass lines. An animal
 * picks its way. This draws the same route through every recorded point at its recorded time,
 * but as a smooth curve (no sharp corner at a waypoint) that wanders a little from the straight
 * line between them, each animal in its own way. Presentation only: the recorded points, and
 * so the server's view of where the animal is at each of them, are unchanged.
 */

/** How far a walker wanders from the straight line, metres, and over what length it sways. */
export const WANDER = { walker: { amplitudeM: 3.5, share: 0.035, wavelengthM: [35, 70] as const },
  flier: { amplitudeM: 14, share: 0.06, wavelengthM: [140, 240] as const } };

export function wanderSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

type Point = { x: number; z: number };

/** The longest tangent a turn is rounded with, metres: the curve eases through a waypoint over
 * a few metres either side of it, rather than bowing a whole 300 m leg out to one side. */
export const TURN_EASE_M = 24;

/** A cubic Hermite curve through p1 and p2, leaving and arriving along the given unit directions. */
function hermite(p1: Point, p2: Point, d1: Point, d2: Point, t: number): Point {
  const length = Math.hypot(p2.x - p1.x, p2.z - p1.z), k = Math.min(length, TURN_EASE_M);
  const t2 = t * t, t3 = t2 * t, h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  return { x: h00 * p1.x + h10 * d1.x * k + h01 * p2.x + h11 * d2.x * k, z: h00 * p1.z + h10 * d1.z * k + h01 * p2.z + h11 * d2.z * k };
}
const unit = (from: Point, to: Point): Point => { const l = Math.hypot(to.x - from.x, to.z - from.z) || 1; return { x: (to.x - from.x) / l, z: (to.z - from.z) / l }; };

/** The drawn point on segment i of the route at fraction t (0..1 along it). */
function drawnPoint(trace: MovementTrace, i: number, t: number, seed: number, flier: boolean): Point {
  const s = trace.samples, at = (k: number): Point => s[Math.max(0, Math.min(s.length - 1, k))]!.position;
  const p1 = at(i), p2 = at(i + 1);
  // Neighbours that are the same point (a pause) would kink the curve: step past them.
  let k0 = i - 1; while (k0 > 0 && Math.hypot(at(k0).x - p1.x, at(k0).z - p1.z) < 0.05) k0--;
  let k3 = i + 2; while (k3 < s.length - 1 && Math.hypot(at(k3).x - p2.x, at(k3).z - p2.z) < 0.05) k3++;
  const p0 = k0 >= 0 && Math.hypot(at(k0).x - p1.x, at(k0).z - p1.z) >= 0.05 ? at(k0) : { x: 2 * p1.x - p2.x, z: 2 * p1.z - p2.z };
  const p3 = Math.hypot(at(k3).x - p2.x, at(k3).z - p2.z) >= 0.05 ? at(k3) : { x: 2 * p2.x - p1.x, z: 2 * p2.z - p1.z };
  // Through each waypoint along the bisector of the legs either side of it: the turn is rounded.
  const curve = hermite(p1, p2, unit(p0, p2), unit(p1, p3), t);
  // A gentle sway across the line, nothing at the recorded points themselves.
  const length = Math.hypot(p2.x - p1.x, p2.z - p1.z), w = flier ? WANDER.flier : WANDER.walker;
  if (length < 1) return curve;
  const amplitude = Math.min(w.amplitudeM, length * w.share);
  const wavelength = w.wavelengthM[0] + (w.wavelengthM[1] - w.wavelengthM[0]) * seed;
  const phase = (seed * 7.31 + i * 0.618) * Math.PI * 2;
  const sway = amplitude * Math.sin(Math.PI * t) * Math.sin((t * length / wavelength) * Math.PI * 2 + phase);
  const nx = -(p2.z - p1.z) / length, nz = (p2.x - p1.x) / length;
  return { x: curve.x + nx * sway, z: curve.z + nz * sway };
}

/** movementAt, drawn naturally: same recorded points, times, altitude and moving flag. */
export function naturalMovementAt(trace: MovementTrace, seconds: number, seed: number, flier = false): ReturnType<typeof movementAt> {
  const recorded = movementAt(trace, seconds), s = trace.samples;
  if (!recorded.moving || s.length < 2) return recorded;
  let low = 0, high = s.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (s[mid]!.seconds <= seconds) low = mid; else high = mid - 1; }
  const a = s[low]!, b = s[low + 1];
  if (!b || b.seconds <= a.seconds || Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z) < 0.05) return recorded;
  const t = Math.max(0, Math.min(1, (seconds - a.seconds) / (b.seconds - a.seconds)));
  const here = drawnPoint(trace, low, t, seed, flier);
  // Facing along the drawn curve, not the straight leg.
  const step = 0.01, there = t + step <= 1 ? drawnPoint(trace, low, t + step, seed, flier) : here;
  const back = t + step > 1 ? drawnPoint(trace, low, t - step, seed, flier) : here;
  const dx = t + step <= 1 ? there.x - here.x : here.x - back.x, dz = t + step <= 1 ? there.z - here.z : here.z - back.z;
  const heading = Math.hypot(dx, dz) > 1e-6 ? Math.atan2(dx, dz) : recorded.heading;
  return { ...recorded, x: here.x, z: here.z, heading };
}
