/** Read-only v0.23 seed-2 tiger offspring/direct-water provenance through day 300. */
import { writeFileSync } from 'node:fs';
import { atWaterAccess } from '@vana/shared';
import { ISLAND_POPULATION, SIM_VERSION, createWorld } from '@vana/sim';

if (SIM_VERSION !== 'sim_0.23.0') throw new Error('Pinned to v0.23 source');
const output = process.argv[2];
if (!output) throw new Error('Usage: npx tsx tools/diagnostics/seed2TigerWaterProbe.ts NEW_OUTPUT.json');

const world = createWorld({ seed: 2, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });
type Cub = { id: string; bornAt: number; motherId: string; fatherId: string;
  birthPatchId: number; drinks: number; litres: number; firstDrinkAt: number | null;
  firstDrinkAgeDays: number | null; routeLinkedDrinks: number; contactVerifiedDrinks: number;
  drinkSamples: unknown[]; death: unknown | null };
const cubs = new Map<string, Cub>();
const waterLedgerMismatches: Array<{ at: number; deltaL: number; eventLitresL: number }> = [];
for (let day = 0; day < 300; day++) {
  for (let hour = 0; hour < 24; hour++) {
    const previousConsumption = world.waterBudget.animalConsumptionL;
    world.step(1);
    const events = world.log.take();
    const eventLitresL = events.filter(e => e.type === 'drank')
      .reduce((sum, event) => sum + Number(event.effects.litres ?? 0), 0);
    const deltaL = world.waterBudget.animalConsumptionL - previousConsumption;
    if (Math.abs(deltaL - eventLitresL) > 1e-7 && waterLedgerMismatches.length < 5)
      waterLedgerMismatches.push({ at: world.now(), deltaL, eventLitresL });
    const byId = new Map(events.map(e => [e.id, e]));
    for (const event of events) {
      if (event.type === 'born' && event.conditions.species === 'tiger') {
        cubs.set(event.actors[0]!, { id: event.actors[0]!, bornAt: event.worldTime,
          motherId: event.actors[1]!, fatherId: event.actors[2]!, birthPatchId: event.patchId,
          drinks: 0, litres: 0, firstDrinkAt: null, firstDrinkAgeDays: null,
          routeLinkedDrinks: 0, contactVerifiedDrinks: 0, drinkSamples: [], death: null });
      }
      const cub = cubs.get(event.actors[0]!);
      if (!cub) continue;
      if (event.type === 'died') {
        cub.death = { worldTime: event.worldTime, ageDays: event.conditions.ageDays,
          cause: event.conditions.cause, careState: event.conditions.careState };
      }
      if (event.type !== 'drank') continue;
      const litres = Number(event.effects.litres ?? 0);
      const movementParents = event.causalParents.map(id => byId.get(id)).filter(e => e?.type === 'moved');
      const routeLinked = movementParents.some(move => move?.movement?.completed === true
        && move.actors[0] === cub.id && move.patchId === event.patchId);
      const contactVerified = event.position !== undefined && atWaterAccess(event.position, event.patchId);
      cub.drinks++;
      cub.litres += litres;
      if (cub.firstDrinkAt === null) {
        cub.firstDrinkAt = event.worldTime;
        cub.firstDrinkAgeDays = (event.worldTime - cub.bornAt) / 86400;
      }
      if (routeLinked) cub.routeLinkedDrinks++;
      if (contactVerified) cub.contactVerifiedDrinks++;
      if (cub.drinkSamples.length < 3) cub.drinkSamples.push({ worldTime: event.worldTime,
        ageDays: (event.worldTime - cub.bornAt) / 86400, patchId: event.patchId, litres,
        position: event.position, sourceX: event.conditions.sourceX, sourceZ: event.conditions.sourceZ,
        contactRadiusM: event.conditions.contactRadiusM, contactVerified,
        causalParents: event.causalParents, routeLinked,
        movement: movementParents.map(move => ({ id: move!.id, completed: move!.movement?.completed,
          goal: move!.goal, from: move!.conditions.from, destination: move!.conditions.destination,
          distanceM: move!.effects.distanceM, durationSeconds: move!.effects.durationSeconds })) });
    }
  }
  if (day % 60 === 59) console.error(`v0.23 seed-2 tiger water trace ${day + 1}/300 days`);
}

const result = { fixture: 'sim_0.23.0 seed 2 island_v1 + household_v1 canonical cohort, hourly through day 300',
  historicalV22AffectedIds: ['tiger_0a1a', 'tiger_0a1b', 'tiger_0a1c'],
  lineageNote: 'Match births by mother and world time; tiger IDs/timing may shift after a rule change.',
  cubs: [...cubs.values()].map(cub => ({ ...cub,
    aliveAtDay300: world.agents.some(agent => agent.id === cub.id && agent.alive),
    ageAtDay300: world.agents.find(agent => agent.id === cub.id)?.ageDays ?? null })),
  waterLedgerMismatches, finalTigerCount: world.agents.filter(agent => agent.alive && agent.speciesId === 'tiger').length,
  finalWorldTime: world.now() };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, tigerBirths: cubs.size,
  directDrinks: [...cubs.values()].reduce((sum, cub) => sum + cub.drinks, 0),
  waterLedgerMismatches: waterLedgerMismatches.length, finalTigerCount: result.finalTigerCount }));
