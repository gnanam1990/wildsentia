/** Bounded, read-only current-rule boar young event tail; no database or artifact writes. */
import { createWorld, ISLAND_POPULATION } from '@vana/sim';

const world = createWorld({ seed: 1, speciesDir: new URL('../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });
type Step = { hour: number; age: number; hunger: number; thirst: number; goal: string | null;
  parentAlive: boolean; parentGapM: number | null; patchWaterL: number; nearbyWaterL: number;
  plantKg: number; actions: Array<{ type: string; goal: string | null; outcome: string;
    amount: number; metres: number; completed: boolean | null }> };
const recent = new Map<string, Step[]>();
const parentLostAt = new Map<string, number>();
const parentDeaths = new Map<string, { worldTime: number; cause: string }>();
let found = 0;
for (let hour = 0; hour < 360 * 24 && found < 13; hour++) {
  world.step(1);
  const events = world.log.take();
  const agents = new Map(world.agents.map(a => [a.id, a]));
  const actions = new Map<string, Step['actions']>();
  for (const event of events) {
    if (event.type === 'parent_lost' && event.actors[0]?.startsWith('boar_'))
      parentLostAt.set(event.actors[0], event.worldTime);
    if (event.type === 'died' && event.actors[0]?.startsWith('boar_'))
      parentDeaths.set(event.actors[0], { worldTime: event.worldTime, cause: String(event.conditions.cause) });
    if (!event.actors[0]?.startsWith('boar_')
      || !['provisioned', 'drank', 'fed', 'moved'].includes(event.type)) continue;
    const item = actions.get(event.actors[0]) ?? [];
    item.push({ type: event.type, goal: event.goal ?? null, outcome: event.outcome,
      amount: Number(event.effects.foodEquivalentKg ?? event.effects.waterEquivalentL
        ?? event.effects.litres ?? event.effects.kg ?? 0),
      metres: Number(event.effects.distanceM ?? 0), completed: event.movement?.completed ?? null });
    actions.set(event.actors[0], item);
  }
  for (const child of world.agents) {
    if (child.speciesId !== 'boar' || child.ageDays >= 45 || !child.motherId) continue;
    const parent = agents.get(child.motherId);
    const patch = world.patches[child.patchId]!;
    const neighbours = patch.neighbours.map(id => world.patches[id]!);
    const steps = recent.get(child.id) ?? [];
    steps.push({ hour, age: child.ageDays, hunger: child.drives.hunger, thirst: child.drives.thirst,
      goal: child.currentGoal, parentAlive: !!parent?.alive,
      parentGapM: parent?.position && child.position
        ? Math.hypot(parent.position.x - child.position.x, parent.position.z - child.position.z) : null,
      patchWaterL: patch.waterVolume, nearbyWaterL: Math.max(patch.waterVolume, ...neighbours.map(p => p.waterVolume)),
      plantKg: patch.plant.grass + patch.plant.browse, actions: actions.get(child.id) ?? [] });
    if (steps.length > 24) steps.shift();
    recent.set(child.id, steps);
  }
  for (const event of events) {
    if (event.type !== 'died' || event.conditions.species !== 'boar'
      || event.conditions.lifeStage !== 'newborn'
      || !['starvation', 'dehydration'].includes(String(event.conditions.cause))) continue;
    const id = event.actors[0]!;
    const child = agents.get(id)!;
    const steps = recent.get(id) ?? [];
    const flat = steps.flatMap(step => step.actions);
    const parentDeath = parentDeaths.get(child.motherId ?? '');
    const sum = (type: string) => flat.filter(a => a.type === type).reduce((n, a) => n + a.amount, 0);
    console.log(JSON.stringify({ id, cause: event.conditions.cause, careState: event.conditions.careState,
      deathDay: hour / 24, ageDays: child.ageDays, motherId: child.motherId,
      parentLostDay: parentLostAt.has(id) ? parentLostAt.get(id)! / 86400 : null,
      motherDeathDay: parentDeath ? parentDeath.worldTime / 86400 : null,
      motherDeathCause: parentDeath?.cause ?? null,
      final24h: { hours: steps.length, provisionedCount: flat.filter(a => a.type === 'provisioned').length,
        foodEquivalentKg: sum('provisioned'), directDrinks: flat.filter(a => a.type === 'drank').length,
        directDrinkL: sum('drank'), directFeeds: flat.filter(a => a.type === 'fed').length,
        directFeedKg: sum('fed'), waterRoutes: flat.filter(a => a.type === 'moved' && a.goal === 'find_water').length,
        waterRoutesCompleted: flat.filter(a => a.type === 'moved' && a.goal === 'find_water' && a.completed).length,
        parentRoutes: flat.filter(a => a.type === 'moved' && a.goal === 'follow_parent').length,
        parentGapMinM: Math.min(...steps.map(s => s.parentGapM ?? Infinity)),
        parentGapMaxM: Math.max(...steps.map(s => s.parentGapM ?? 0)),
        endPatchWaterL: steps.at(-1)?.patchWaterL, endNearbyWaterL: steps.at(-1)?.nearbyWaterL,
        endPlantKg: steps.at(-1)?.plantKg },
      lastEightHours: steps.slice(-8) }));
    found++;
  }
  for (const id of recent.keys()) if (!agents.get(id)?.alive) recent.delete(id);
}
console.error(`boar newborn deprivation cases found: ${found}`);
