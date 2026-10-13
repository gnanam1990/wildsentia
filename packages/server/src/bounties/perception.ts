import { spatialHash } from '@vana/shared';

/**
 * Congo 1D (spec §6): how an animal learns of another, the same for every agent. Its senses
 * reach only so far: sight shortened by the target's cover and by darkness, smell carried
 * farther downwind, hearing only of an animal that moves.
 *
 * Phase 1 assumptions (not measured values): a leopard's eyes are its keenest sense, a duiker's
 * nose and ears, a chevrotain's ears; the numbers are deliberately round.
 */
export interface Senses { sightM: number; smellM: number; hearingM: number; nightSight: number }
export const SENSES: Readonly<Record<string, Senses>> = {
  african_leopard: { sightM: 150, smellM: 80, hearingM: 60, nightSight: 0.7 },
  blue_duiker: { sightM: 90, smellM: 40, hearingM: 50, nightSight: 0.3 },
  water_chevrotain: { sightM: 60, smellM: 50, hearingM: 45, nightSight: 0.4 },
};
const DEFAULT_SENSES: Senses = { sightM: 80, smellM: 30, hearingM: 40, nightSight: 0.3 };

/** How much of a full day's light there is at a world time: none from 18:00 to 06:00, full at noon. */
export function daylightAt(worldTime: number): number {
  const hour = ((worldTime % 86_400) + 86_400) % 86_400 / 3600;
  return Math.max(0, Math.min(1, Math.sin((hour - 6) / 12 * Math.PI) * 1.4));
}

/** The direction the wind blows toward (radians, 0 = +z), one per world hour, the same for everyone in a world. */
export function windAt(worldId: string, worldTime: number): number {
  return spatialHash(`wind:${worldId}:${Math.floor(worldTime / 3600)}`) / 0xffffffff * Math.PI * 2;
}

export interface SenseConditions {
  /** The canopy cover (0-1) where the target stands. */
  canopy: number;
  daylight: number;
  /** The direction the wind blows toward (radians, 0 = +z). */
  windHeading: number;
}

/** Which sense, if any, brings `target` to `observer`'s notice. */
export function perceive(observer: { x: number; z: number; speciesId: string }, target: { x: number; z: number; moving: boolean; running: boolean },
  c: SenseConditions): 'sight' | 'smell' | 'hearing' | null {
  const s = SENSES[observer.speciesId] ?? DEFAULT_SENSES;
  const dx = observer.x - target.x, dz = observer.z - target.z, d = Math.hypot(dx, dz);
  const light = c.daylight + (1 - c.daylight) * s.nightSight;
  if (d <= s.sightM * (1 - 0.7 * Math.max(0, Math.min(1, c.canopy))) * light) return 'sight';
  // Downwind: the wind blows from the target toward the observer.
  const along = d === 0 ? 1 : (Math.sin(c.windHeading) * dx + Math.cos(c.windHeading) * dz) / d;
  if (d <= s.smellM * (along > 0.5 ? 2 : along > -0.5 ? 1 : 0.5)) return 'smell';
  if (target.moving && d <= s.hearingM * (target.running ? 2 : 1)) return 'hearing';
  return null;
}
