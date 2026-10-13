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

const PROFILES = ['mainland', 'island_v1', 'island_v2', 'congo_v1'] as const;
export type ServedProfile = (typeof PROFILES)[number];

/**
 * Congo 1B: which world this server hosts, and the species it runs on. The Congo forest has its
 * own roster (config/species-congo, or SPECIES_DIR_CONGO); every other world the island's
 * (config/species, or SPECIES_DIR). `configDir` is the repository's config directory.
 */
export function worldProfile(env: Record<string, string | undefined>, configDir: string): { terrainProfile: ServedProfile; speciesDir: string } {
  const terrainProfile = (env.VANA_TERRAIN_PROFILE ?? 'mainland') as ServedProfile;
  if (!PROFILES.includes(terrainProfile)) throw new Error('invalid VANA_TERRAIN_PROFILE');
  const speciesDir = terrainProfile === 'congo_v1'
    ? env.SPECIES_DIR_CONGO ?? `${configDir}/species-congo`
    : env.SPECIES_DIR ?? `${configDir}/species`;
  return { terrainProfile, speciesDir };
}
