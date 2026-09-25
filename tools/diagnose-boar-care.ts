/** Read-only canonical island diagnosis; no preview/database access and no output files. */
import { createWorld, ISLAND_POPULATION } from '@vana/sim';

const world = createWorld({ seed: 1, speciesDir: new URL('../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });

type Trace = Record<string, unknown>;
const recent = new Map<string, Trace[]>();
let found = 0;
for (let hour = 0; hour < 360 * 24 && found < 3; hour++) {
  world.step(1);
  const events = world.log.take();
  const boarEvents = new Map<string, Trace[]>();
  for (const e of events) {
    if (!e.actors[0]?.startsWith('boar_') || !['fed', 'drank', 'moved', 'provisioned', 'died'].includes(e.type)) continue;
    const list = boarEvents.get(e.actors[0]) ?? [];
    list.push({ type: e.type, goal: e.goal, outcome: e.outcome,
      kg: e.effects.kg, litres: e.effects.litres, foodEquivalentKg: e.effects.foodEquivalentKg,
      waterEquivalentL: e.effects.waterEquivalentL, distanceM: e.effects.distanceM,
      durationSeconds: e.effects.durationSeconds, cause: e.conditions.cause });
    boarEvents.set(e.actors[0], list);
  }
  const agents = new Map(world.agents.map(a => [a.id, a]));
  for (const child of world.agents) {
    if (child.speciesId !== 'boar' || child.ageDays >= 45 || !child.dependentOn) continue;
    const mother = agents.get(child.dependentOn);
    if (!mother?.alive) continue;
    const patch = world.patches[child.patchId]!;
    const history = recent.get(child.id) ?? [];
    history.push({ hour, day: hour / 24, childAge: child.ageDays, childAlive: child.alive,
      childGoal: child.currentGoal, childState: child.state,
      childHunger: child.drives.hunger, childThirst: child.drives.thirst,
      motherId: mother.id, motherGoal: mother.currentGoal, motherState: mother.state,
      motherHunger: mother.drives.hunger, motherThirst: mother.drives.thirst,
      distanceM: Math.hypot(child.position!.x - mother.position!.x, child.position!.z - mother.position!.z),
      childPatch: child.patchId, plantKg: patch.plant.grass + patch.plant.browse,
      waterL: patch.waterVolume, childEvents: boarEvents.get(child.id) ?? [], motherEvents: boarEvents.get(mother.id) ?? [] });
    if (history.length > 24) history.shift();
    recent.set(child.id, history);
  }
  for (const e of events) if (e.type === 'died' && e.conditions.species === 'boar'
    && e.conditions.cause === 'starvation' && e.conditions.careState === 'unweaned_with_parent') {
    console.log(JSON.stringify({ id: e.actors[0], atHour: hour, ageDays: e.conditions.ageDays,
      trace: recent.get(e.actors[0]!) ?? [] }));
    found++;
    if (found >= 3) break;
  }
  for (const id of recent.keys()) if (!agents.get(id)?.alive) recent.delete(id);
}
