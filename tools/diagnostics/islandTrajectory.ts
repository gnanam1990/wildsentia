/**
 * Read-only island trajectory: per-window living counts of every species, births and deaths by
 * cause, and an itemised life record for the small populations (tiger, dhole, elephant,
 * jackal) whose loss ends a species on the closed island. Same world options as the soak.
 *
 *   npx tsx tools/diagnostics/islandTrajectory.ts --seed 2 --days 360 [--window 30]
 */
import { ISLAND_POPULATION, SIM_VERSION, createWorld } from '@vana/sim';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const seed = Number(arg('seed', '1')), days = Number(arg('days', '360')), window = Number(arg('window', '30'));
const SMALL = new Set((arg('watch', 'tiger,dhole,elephant,jackal')).split(','));
const world = createWorld({ seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });
console.log(JSON.stringify({ simVersion: SIM_VERSION, seed, days }));
const living = (id: string) => [...world.agents].find(a => a.id === id);
let tally: Record<string, number> = {};
const bump = (key: string) => { tally[key] = (tally[key] ?? 0) + 1; };
for (let day = 1; day <= days; day++) {
  for (let hour = 0; hour < 24; hour++) {
    world.step(1);
    for (const event of world.log.take()) {
      const species = String(event.conditions.species ?? event.actors[0]?.split('_')[0]);
      if (event.type === 'born') {
        bump(`${species}:born`);
        if (SMALL.has(species)) console.log(JSON.stringify({ day: +(event.worldTime / 86400).toFixed(2), born: event.actors[0],
          mother: event.actors[1], sex: living(event.actors[0]!)?.sex }));
      }
      if (event.type === 'died') {
        bump(`${species}:${event.conditions.cause}`);
        if (SMALL.has(species)) {
          const dead = world.deceased.find(a => a.id === event.actors[0]) ?? living(event.actors[0]!);
          console.log(JSON.stringify({ day: +(event.worldTime / 86400).toFixed(2), died: event.actors[0], killer: event.actors[1],
            cause: event.conditions.cause, careState: event.conditions.careState, lifeStage: event.conditions.lifeStage,
            ageDays: +Number(event.conditions.ageDays).toFixed(1), sex: dead?.sex,
            hunger: +Number(event.conditions.hunger).toFixed(2), thirst: +Number(event.conditions.thirst).toFixed(2) }));
        }
      }
      if (event.type === 'courtship' && SMALL.has(species)) bump(`${species}:courtship:${event.outcome}:${event.conditions.reason ?? ''}`);
    }
  }
  if (day % window === 0) {
    const counts = Object.fromEntries([...world.species.keys()].map(id => [id, world.livingCount(id)]));
    const sexes = Object.fromEntries([...SMALL].map(id => [id, world.agents.filter(a => a.alive && a.speciesId === id)
      .map(a => `${a.sex[0]}${Math.floor(a.ageDays)}`).join(' ')]));
    console.log(JSON.stringify({ day, counts, sexes, tally }));
    tally = {};
  }
}
