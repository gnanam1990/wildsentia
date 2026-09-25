import { WORLD_SECONDS_PER_DAY, WORLD_SECONDS_PER_YEAR, type Patch } from '@vana/shared';

/** Checkpointed aggregate proxy; no individual insect, plant species or visit claim. */
export function floweringGuildSummary(patch: Patch): {
  guildId: 'insect_visited_understorey_v1'; vegetativeKg: number;
  openKg: number; visitedKg: number; seedKg: number;
  stage: 'vegetative' | 'flowering' | 'maturing' | 'seed_bank';
  nextEligibleAt: number | null;
} | null {
  const guild = patch.floweringGuild;
  if (!guild) return null;
  return { guildId: guild.guildId, vegetativeKg: guild.vegetativeKg,
    openKg: guild.bloom?.openKg ?? 0, visitedKg: guild.bloom?.visitedKg ?? 0,
    seedKg: guild.seedBank.reduce((sum, seed) => sum + seed.biomassKg, 0),
    stage: guild.bloom ? guild.bloom.closed ? 'maturing' : 'flowering'
      : guild.seedBank.length ? 'seed_bank' : 'vegetative',
    nextEligibleAt: guild.bloom?.closed ? guild.bloom.maturesAt
      : guild.bloom?.closesAt ?? guild.seedBank[0]?.germinateAt
        ?? guild.lastBloomYear * WORLD_SECONDS_PER_YEAR + 279 * WORLD_SECONDS_PER_DAY };
}
