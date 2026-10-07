/**
 * Read-only: how fast the island's deer grow with no predators at all, to set against the maximum
 * rate of increase of predator-free chital (26-41% a year in introduced Queensland herds, Pople,
 * Amos & Brennan 2023). Founds an island with the usual cohort but no tigers, leopards, dholes or
 * jackals, and the chital and sambar at a fraction of their usual numbers so food does not limit
 * them, then reports their numbers, births and deaths by cause every 90 days.
 *
 *   npx tsx tools/diagnostics/preyGrowth.ts --seed 1 --days 720 --share 0.3 [--profile island_v2]
 */
import { createWorld, islandPopulation } from '@vana/sim';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const seed = Number(arg('seed', '1')), days = Number(arg('days', '720')), share = Number(arg('share', '0.3'));
const profile = arg('profile', 'island_v2') as 'island_v1' | 'island_v2';
const cohort = { ...islandPopulation(profile), tiger: 0, leopard: 0, dhole: 0, jackal: 0 };
for (const id of ['chital', 'sambar']) cohort[id] = Math.round(cohort[id]! * share);
const world = createWorld({ seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: profile, communityProfile: 'household_v1', initialAgents: cohort,
  minPopulation: {}, retainEvents: 1_000_000 });
const watched = ['chital', 'sambar'];
const tally: Record<string, Record<string, number>> = Object.fromEntries(watched.map(id => [id, {}]));
const count = (id: string) => world.agents.filter(a => a.alive && a.speciesId === id).length;
const adultFemales = (id: string) => world.agents.filter(a => a.alive && a.speciesId === id && a.sex === 'female'
  && (a.lifeStage === 'adult' || a.lifeStage === 'elder')).length;
console.log(`day 0 ${watched.map(id => `${id} ${count(id)} (adult females ${adultFemales(id)})`).join(' | ')}`);
for (let h = 1; h <= days * 24; h++) {
  world.step(1);
  for (const e of world.log.take()) {
    const id = e.conditions.species as string | undefined;
    if (!id || !watched.includes(id)) continue;
    const key = e.type === 'died' ? `death/${String(e.conditions.cause)}/${String(e.conditions.lifeStage)}` : e.type === 'born' ? 'birth' : null;
    if (key) tally[id]![key] = (tally[id]![key] ?? 0) + 1;
  }
  if (h % (90 * 24) === 0) {
    console.log(`day ${h / 24} ${watched.map(id => `${id} ${count(id)} (adult females ${adultFemales(id)}) ${JSON.stringify(tally[id])}`).join(' | ')}`);
  }
}
