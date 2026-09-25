/** Read-only reproduction of the canonical seed-3 island soak, retaining only tiger evidence. */
import { writeFileSync } from 'node:fs';
import { ISLAND_POPULATION, SIM_VERSION, createWorld } from '@vana/sim';
import { isFloater } from '../../packages/sim/src/agents/territory.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: npx tsx tools/diagnostics/seed3TigerProbe.ts NEW_OUTPUT.json');
if (SIM_VERSION !== 'sim_0.21.0') throw new Error('This archived event probe only reproduces the v0.21 pre-fix baseline');
const world = createWorld({
  seed: 3,
  speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1',
  initialAgents: ISLAND_POPULATION, minPopulation: {}, retainEvents: 200_000,
});
const tiger = world.species.get('tiger')!;
const founders = world.agents.filter(a => a.speciesId === 'tiger');
const founderIds = new Set(founders.map(a => a.id));
const sample = (agent: typeof founders[number]) => ({
  id: agent.id, sex: agent.sex, ageDays: agent.ageDays, lifeStage: agent.lifeStage,
  patchId: agent.patchId, position: agent.position,
  motherId: agent.motherId, fatherId: agent.fatherId, generation: agent.generation,
  floater: isFloater(agent, tiger, world.agents.filter(a => a.speciesId === 'tiger'), world.patches),
});
const initial = founders.map(sample);
let bothAliveHours = 0, oppositeSexPairHours = 0;
const floaterHours: Record<string, number> = Object.fromEntries(founders.map(a => [a.id, 0]));
const deaths: unknown[] = [], courtships: unknown[] = [], births: unknown[] = [];
const livingAtDay: Array<{ day: number; founders: ReturnType<typeof sample>[] }> = [];
for (let day = 0; day < 360; day++) {
  if (day % 30 === 0 || day >= 330) livingAtDay.push({ day,
    founders: world.agents.filter(a => founderIds.has(a.id)).map(sample) });
  for (let hour = 0; hour < 24; hour++) {
    const alive = world.agents.filter(a => founderIds.has(a.id));
    if (alive.length === 2) {
      bothAliveHours++;
      if (alive[0]!.sex !== alive[1]!.sex) oppositeSexPairHours++;
    }
    for (const agent of alive) if (isFloater(agent, tiger, world.agents.filter(a => a.speciesId === 'tiger'), world.patches))
      floaterHours[agent.id]++;
    world.step(1);
    for (const event of world.log.take()) {
      if (event.type === 'died' && founderIds.has(event.actors[0]!)) deaths.push({
        id: event.actors[0], day: event.worldTime / 86400, worldTime: event.worldTime,
        cause: event.conditions.cause, lifeStage: event.conditions.lifeStage,
        patchId: event.patchId, position: event.position, actors: event.actors,
      });
      if (event.type === 'courtship' && event.conditions.species === 'tiger') courtships.push(event);
      if (event.type === 'born' && event.conditions.species === 'tiger') births.push(event);
    }
  }
  if (day % 60 === 59) console.error(`seed-3 tiger probe ${day + 1}/360 days`);
}
const result = {
  fixture: 'Exact canonical seed-3 island_v1 + household_v1 360-day hourly world; no rules changed',
  initial, bothAliveHours, oppositeSexPairHours, floaterHours,
  deaths, tigerCourtshipEvents: courtships, tigerBirthEvents: births,
  finalTigerCount: world.livingCount('tiger'),
  deceasedFounderLineage: world.deceased.filter(a => founderIds.has(a.id)).map(a => ({
    id: a.id, sex: a.sex, ageDays: a.ageDays, motherId: a.motherId, fatherId: a.fatherId,
    generation: a.generation, patchId: a.patchId, position: a.position,
  })),
  livingAtDay,
};
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ initial, bothAliveHours, oppositeSexPairHours, floaterHours,
  deaths, tigerCourtships: courtships.length, tigerBirths: births.length,
  finalTigerCount: result.finalTigerCount }, null, 2));
