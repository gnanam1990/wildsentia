/** Read-only active-illness audit for the v0.22 seed-3 tiger litter and mother. */
import { writeFileSync } from 'node:fs';
import { ISLAND_POPULATION, SIM_VERSION, createWorld } from '@vana/sim';

if (SIM_VERSION !== 'sim_0.22.0') throw new Error('Pinned to v0.22 source');
const output = process.argv[2];
if (!output) throw new Error('Usage: npx tsx tools/diagnostics/seed3TigerIllnessCheck.ts NEW_OUTPUT.json');
const world = createWorld({ seed: 3, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });
const ids = ['tiger_0700', 'tiger_0a13', 'tiger_0a14'];
const hoursWithIllness: Record<string, number> = Object.fromEntries(ids.map(id => [id, 0]));
const last48hIllnessHours: Record<string, number> = Object.fromEntries(ids.map(id => [id, 0]));
const diseaseEvents: unknown[] = [], deaths: unknown[] = [];
const firstDeathAt = 25750800;
for (let day = 0; day < 299; day++) {
  for (let hour = 0; hour < 24; hour++) {
    const now = world.now();
    for (const id of ids) {
      const agent = world.agents.find(a => a.id === id);
      if (agent?.illness) {
        hoursWithIllness[id]++;
        if (now >= firstDeathAt - 48 * 3600 && now <= firstDeathAt) last48hIllnessHours[id]++;
      }
    }
    world.step(1);
    for (const event of world.log.take()) {
      if (!event.actors.some(id => ids.includes(id))) continue;
      if (event.type.startsWith('disease_')) diseaseEvents.push(event);
      if (event.type === 'died') deaths.push(event);
    }
  }
  if (day % 60 === 59) console.error(`v0.22 seed-3 illness check ${day + 1}/299 days`);
}
const result = { fixture: 'v0.22 seed-3 tiger mother and two cubs; exact island+household cohort, hourly to day 299',
  hoursWithIllness, last48hIllnessHours, diseaseEvents, deaths: deaths.map(event => ({
    actors: event.actors, worldTime: event.worldTime, cause: event.conditions.cause,
    lifeStage: event.conditions.lifeStage, careState: event.conditions.careState,
  })) };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
