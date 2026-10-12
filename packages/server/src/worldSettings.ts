/**
 * The world's seed and speed from the environment. A typo here would silently run a different
 * world (NaN seeds) or stall the clock (a zero or negative speed), so both fail at startup.
 */
/** An unset variable takes its default; an empty one is a mistake (Number('') would be 0). */
const numberOr = (text: string | undefined, fallback: number) => text === undefined ? fallback : text.trim() === '' ? Number.NaN : Number(text);

export function worldSettings(env: Record<string, string | undefined>): { seed: number; worldHoursPerRealHour: number } {
  const seed = numberOr(env.WORLD_SEED, 1);
  if (!Number.isSafeInteger(seed)) throw new Error('WORLD_SEED must be a whole number');
  const worldHoursPerRealHour = numberOr(env.WORLD_HOURS_PER_REAL_HOUR, 12);
  if (!Number.isFinite(worldHoursPerRealHour) || worldHoursPerRealHour <= 0 || worldHoursPerRealHour > 3600)
    throw new Error('WORLD_HOURS_PER_REAL_HOUR must be a number above 0 and at most 3600');
  return { seed, worldHoursPerRealHour };
}
