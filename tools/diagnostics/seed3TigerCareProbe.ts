/** Read-only v0.22 tiger-young care trace; same world options and hourly stepping as canonical soak. */
import { writeFileSync } from 'node:fs';
import { ISLAND_POPULATION, SIM_VERSION, createWorld } from '@vana/sim';
import { availableForCare } from '../../packages/sim/src/agents/family.js';
import { canDrinkIndependently, careRadius, inCareContact, needsOf } from '../../packages/sim/src/agents/needs.js';

if (SIM_VERSION !== 'sim_0.22.0') throw new Error('This diagnostic is pinned to the v0.22 seed-3 baseline');
const output = process.argv[2];
if (!output) throw new Error('Usage: npx tsx tools/diagnostics/seed3TigerCareProbe.ts NEW_OUTPUT.json');
const world = createWorld({ seed: 3, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });
const cfg = world.species.get('tiger')!;
type ChildRecord = { childId: string; motherId: string; fatherId: string | null; bornAt: number;
  snapshots: unknown[]; events: unknown[]; death?: unknown; terminal48h?: { snapshots: unknown[]; events: unknown[] } };
const children = new Map<string, ChildRecord>();
const births: unknown[] = [], deaths: unknown[] = [];
const horizon = 48 * 3600;
for (let day = 0; day < 360; day++) {
  for (let hour = 0; hour < 24; hour++) {
    const now = world.now();
    for (const record of children.values()) {
      if (record.death) continue;
      const child = world.agents.find(a => a.id === record.childId);
      if (!child?.alive) continue;
      const parent = world.agents.find(a => a.id === record.motherId);
      const childPatch = world.patches[child.patchId]!;
      const parentPatch = parent && world.patches[parent.patchId]!;
      const contact = !!parent && inCareContact(parent, child, cfg);
      record.snapshots.push({ worldTime: now, day: now / 86400, ageDays: child.ageDays,
        child: { patchId: child.patchId, position: child.position ? { ...child.position } : null, lifeStage: child.lifeStage,
          state: child.state, goal: child.currentGoal, hunger: child.drives.hunger,
          thirst: child.drives.thirst, fear: child.drives.fear, massKg: child.massKg,
          dailyNeed: needsOf(child, cfg), independentDrink: canDrinkIndependently(child, cfg),
          patchWaterL: childPatch.waterVolume },
        parent: parent ? { alive: parent.alive, patchId: parent.patchId, position: parent.position ? { ...parent.position } : null,
          state: parent.state, goal: parent.currentGoal, hunger: parent.drives.hunger,
          thirst: parent.drives.thirst, fear: parent.drives.fear,
          availableForCare: availableForCare(parent), patchWaterL: parentPatch!.waterVolume } : null,
        distanceM: parent?.position && child.position
          ? Math.hypot(parent.position.x - child.position.x, parent.position.z - child.position.z) : null,
        careRadiusM: careRadius(cfg), contact });
      while (record.snapshots.length && (record.snapshots[0] as { worldTime: number }).worldTime < now - horizon)
        record.snapshots.shift();
    }
    world.step(1);
    for (const event of world.log.take()) {
      if (event.type === 'born' && event.conditions.species === 'tiger') {
        births.push(event);
        const childId = event.actors[0]!, motherId = event.actors[1]!;
        children.set(childId, { childId, motherId, fatherId: event.actors[2] ?? null,
          bornAt: event.worldTime, snapshots: [], events: [] });
      }
      for (const record of children.values()) {
        if (record.death) continue;
        if (event.actors.includes(record.childId) || event.actors.includes(record.motherId)) {
          record.events.push(event);
          while (record.events.length && (record.events[0] as { worldTime: number }).worldTime < world.now() - horizon)
            record.events.shift();
        }
        if (event.type === 'died' && event.actors[0] === record.childId) {
          record.death = event;
          record.terminal48h = { snapshots: record.snapshots, events: record.events };
          deaths.push(event);
        }
      }
    }
  }
  if (day % 60 === 59) console.error(`v0.22 tiger care probe ${day + 1}/360 days`);
}
const result = { fixture: 'v0.22 seed-3 island_v1 + household_v1 hourly 360d; no simulation rule edits',
  weanDays: cfg.lifecycle.weanDays, drinkFromDays: cfg.lifecycle.drinkFromDays ?? cfg.lifecycle.weanDays,
  followFromDays: cfg.lifecycle.followFromDays, births, deaths,
  children: [...children.values()].map(record => ({ childId: record.childId, motherId: record.motherId,
    fatherId: record.fatherId, bornAt: record.bornAt, death: record.death,
    terminal48h: record.terminal48h ?? null })),
  finalTigerCount: world.livingCount('tiger') };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ births: births.map(e => ({ actors: e.actors, worldTime: e.worldTime })),
  deaths: deaths.map(e => ({ actors: e.actors, worldTime: e.worldTime, cause: e.conditions.cause,
    lifeStage: e.conditions.lifeStage, careState: e.conditions.careState })),
  finalTigerCount: result.finalTigerCount }, null, 2));
