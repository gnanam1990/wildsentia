import { createWorld, FOREST_FLOOR, FOREST_LANDSCAPE, FOREST_POPULATION, SIM_VERSION } from '@vana/sim';
import { fileURLToPath } from 'node:url';

// Bounded offline diagnostic: never reads/writes a database or changes the running preview.
const seed = Number(process.argv[2] ?? 1), days = Number(process.argv[3] ?? 120);
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(days) || days <= 0) throw new Error('Usage: diagnose-care.ts integer-seed positive-days');
const world = createWorld({ seed, speciesDir: fileURLToPath(new URL('../../config/species', import.meta.url)),
  initialAgents: FOREST_POPULATION, minPopulation: FOREST_FLOOR, landscape: FOREST_LANDSCAPE, retainEvents: 20000 });
const departures = new Map<string, { cause: string; eventId: string }>();
const lostCare = new Map<string, { parentId: string; lossEventId: string; cause: string; parentEventId: string | null }>();
const lossesByCause: Record<string, number> = {}, deprivationByParentCause: Record<string, number> = {};
const samples: unknown[] = [];
const baseline = world.totalNutrients();
for (let hour = 0; hour < days * 24; hour++) {
  world.step(1);
  const events = world.log.take();
  // Two passes: the coarse tick can emit a spatial death later than another actor's update.
  for (const event of events) {
    if (event.type === 'died' || event.type === 'emigration') departures.set(event.actors[0]!, {
      cause: event.type === 'emigration' ? 'emigration' : String(event.conditions.cause), eventId: event.id });
  }
  for (const event of events) {
    if (event.type === 'parent_lost') {
      const parentId = event.actors[1]!, prior = departures.get(parentId);
      const cause = prior?.cause ?? 'unknown';
      lossesByCause[cause] = (lossesByCause[cause] ?? 0) + 1;
      lostCare.set(event.actors[0]!, { parentId, lossEventId: event.id, cause, parentEventId: prior?.eventId ?? null });
    }
    if (event.type === 'died' && ['starvation', 'dehydration'].includes(String(event.conditions.cause))) {
      const loss = lostCare.get(event.actors[0]!);
      const cause = loss?.cause ?? 'no_recorded_loss';
      const key = `${event.conditions.cause}/${cause}`;
      deprivationByParentCause[key] = (deprivationByParentCause[key] ?? 0) + 1;
      if (samples.length < 8) samples.push({ child: event.actors[0], deathEventId: event.id,
        deathDay: event.worldTime / 86400, careState: event.conditions.careState, ...loss });
    }
  }
}
console.log(JSON.stringify({ simVersion: SIM_VERSION, seed, days, lossesByCause, deprivationByParentCause,
  nutrientDrift: Math.abs(world.totalNutrients() - baseline), samples }, null, 2));
