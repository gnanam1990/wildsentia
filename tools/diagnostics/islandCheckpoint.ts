/**
 * Advance the canonical island + household world for a seed to a given day, hourly exactly as
 * the soak does, and save its snapshot so a diagnostic can replay a late window repeatedly
 * without re-running the whole prefix. Restoring and stepping on is the same deterministic
 * continuation the snapshot tests prove.
 *
 *   npx tsx tools/diagnostics/islandCheckpoint.ts --seed 2 --day 280 --output NEW.json
 */
import { writeFileSync } from 'node:fs';
import { ISLAND_POPULATION, createWorld, takeSnapshot } from '@vana/sim';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const seed = Number(arg('seed') ?? 1), day = Number(arg('day') ?? 1), output = arg('output');
if (!output) throw new Error('--output NEW.json is required');
const world = createWorld({ seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });
for (let hour = 0; hour < day * 24; hour++) { world.step(1); world.log.take(); }
writeFileSync(output, JSON.stringify(takeSnapshot(world)), { flag: 'wx' });
console.log(`seed ${seed} saved at day ${day} (${world.agents.filter(a => a.alive).length} living animals)`);
