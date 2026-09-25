/** Read-only, fresh-world diagnosis. Never opens a server database or changes preview state. */
import { createWorld, FOREST_POPULATION, FOREST_FLOOR, FOREST_LANDSCAPE } from '@vana/sim';
const world = createWorld({ seed: 1, speciesDir: new URL('../config/species', import.meta.url).pathname,
  initialAgents: FOREST_POPULATION, minPopulation: FOREST_FLOOR, landscape: FOREST_LANDSCAPE, retainEvents: 200_000 });
const recent = new Map<string, unknown[]>();
let found = 0;
for (let hour = 0; hour < 120 * 24 && found < 4; hour++) {
  world.step(1);
  const events = world.log.take(), agents = new Map(world.agents.map(a => [a.id, a]));
  for (const child of world.agents) {
    if (!child.dependentOn || child.ageDays >= world.species.get(child.speciesId)!.lifecycle.weanDays) continue;
    const parent = agents.get(child.dependentOn); if (!parent?.alive) continue;
    const history = recent.get(child.id) ?? [];
    history.push({ hour, childGoal: child.currentGoal, childThirst: child.drives.thirst,
      parentGoal: parent.currentGoal, parentThirst: parent.drives.thirst, parentHunger: parent.drives.hunger,
      distance: Math.hypot(child.position!.x - parent.position!.x, child.position!.z - parent.position!.z),
      nursingIntake: child.nursingIntake ? { ...child.nursingIntake } : null,
      nursingSiteDistance: child.nursingSite ? Math.hypot(child.position!.x - child.nursingSite.position.x,
        child.position!.z - child.nursingSite.position.z) : null,
      events: events.filter(e => e.type === 'provisioned' && e.actors.includes(parent.id)).map(e => ({ child: e.actors[0], water: e.effects.waterEquivalentL })) });
    if (history.length > 28) history.shift(); recent.set(child.id, history);
  }
  for (const e of events) if (e.type === 'died' && e.conditions.cause === 'dehydration' && e.conditions.careState === 'unweaned_with_parent') {
    console.log(JSON.stringify({ id: e.actors[0], species: e.conditions.species, ageDays: e.conditions.ageDays, recent: recent.get(e.actors[0]!) }));
    found++; if (found >= 4) break;
  }
  for (const id of recent.keys()) if (!agents.get(id)?.alive) recent.delete(id);
}
