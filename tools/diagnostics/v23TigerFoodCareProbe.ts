/** Read-only v0.23 tiger food-care replay; never alters a saved world. */
import { writeFileSync } from 'node:fs';
import { edibleMass } from '@vana/shared';
import { ISLAND_POPULATION, SIM_VERSION, createWorld } from '@vana/sim';
import { availableForCare } from '../../packages/sim/src/agents/family.js';
import { careRadius, inCareContact, needsOf } from '../../packages/sim/src/agents/needs.js';

if (SIM_VERSION !== 'sim_0.23.0') throw new Error('Pinned to v0.23 source');
const output = process.argv[2];
const seed = Number(process.argv[3] ?? 1);
const days = Number(process.argv[4] ?? 360);
if (!output || ![1, 2].includes(seed) || !Number.isSafeInteger(days) || days < 300 || days > 360)
  throw new Error('Usage: npx tsx tools/diagnostics/v23TigerFoodCareProbe.ts NEW_OUTPUT.json [seed=1|2] [days=300..360]');
const started = Date.now();
const world = createWorld({ seed, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });
const cfg = world.species.get('tiger')!;
type ChildRecord = { id: string; motherId: string; fatherId: string | null; bornAt: number;
  snapshots: unknown[]; events: unknown[]; death: unknown | null;
  terminal48h: { snapshots: unknown[]; events: unknown[] } | null;
  age70to100: { hours: number; contactHours: number; motherAvailableHours: number;
    samePatchCarcassHours: number; within300mCarcassHours: number; maxSamePatchEdibleKg: number;
    maxWithin300mEdibleKg: number; provisionEvents: number; provisionFoodKg: number;
    cubDirectDrinks: number; cubDirectDrinkL: number; cubScavengeEvents: number;
    motherHuntEvents: number; motherScavengeEvents: number; followParentMoves: number } };
const children = new Map<string, ChildRecord>();
const horizon = 48 * 3600;
for (let day = 0; day < days; day++) {
  for (let hour = 0; hour < 24; hour++) {
    const now = world.now();
    for (const record of children.values()) {
      if (record.death) continue;
      const child = world.agents.find(agent => agent.id === record.id);
      if (!child?.alive || !child.position) continue;
      const mother = world.agents.find(agent => agent.id === record.motherId);
      const contact = !!mother && inCareContact(mother, child, cfg);
      const nearby = world.carcasses.filter(carcass => carcass.position
        && Math.hypot(carcass.position.x - child.position!.x,
          carcass.position.z - child.position!.z) <= 300);
      const samePatchCarcassEdibleKg = world.carcasses.filter(carcass => carcass.patchId === child.patchId)
        .reduce((sum, carcass) => sum + edibleMass(carcass.biomass), 0);
      const within300mCarcassEdibleKg = nearby.reduce((sum, carcass) => sum + edibleMass(carcass.biomass), 0);
      const nearestCarcassM = world.carcasses.reduce((minimum, carcass) => carcass.position
        ? Math.min(minimum, Math.hypot(carcass.position.x - child.position!.x,
          carcass.position.z - child.position!.z)) : minimum, Infinity);
      const snapshot = { worldTime: now, ageDays: child.ageDays,
        child: { patchId: child.patchId, position: { ...child.position }, goal: child.currentGoal,
          state: child.state, hunger: child.drives.hunger, thirst: child.drives.thirst,
          massKg: child.massKg, dailyNeed: needsOf(child, cfg), illness: child.illness ?? null },
        mother: mother ? { alive: mother.alive, patchId: mother.patchId,
          position: mother.position ? { ...mother.position } : null, goal: mother.currentGoal,
          state: mother.state, hunger: mother.drives.hunger, thirst: mother.drives.thirst,
          availableForCare: availableForCare(mother), illness: mother.illness ?? null } : null,
        distanceToMotherM: mother?.position
          ? Math.hypot(mother.position.x - child.position.x, mother.position.z - child.position.z) : null,
        careRadiusM: careRadius(cfg), contact, samePatchCarcassEdibleKg,
        within300mCarcassEdibleKg, nearestCarcassM: Number.isFinite(nearestCarcassM) ? nearestCarcassM : null };
      record.snapshots.push(snapshot);
      while (record.snapshots.length && (record.snapshots[0] as { worldTime: number }).worldTime < now - horizon)
        record.snapshots.shift();
      if (child.ageDays >= 70 && child.ageDays < 100) {
        const food = record.age70to100;
        food.hours++;
        if (contact) food.contactHours++;
        if (mother && availableForCare(mother)) food.motherAvailableHours++;
        if (samePatchCarcassEdibleKg > 0) food.samePatchCarcassHours++;
        if (within300mCarcassEdibleKg > 0) food.within300mCarcassHours++;
        food.maxSamePatchEdibleKg = Math.max(food.maxSamePatchEdibleKg, samePatchCarcassEdibleKg);
        food.maxWithin300mEdibleKg = Math.max(food.maxWithin300mEdibleKg, within300mCarcassEdibleKg);
      }
    }
    world.step(1);
    for (const event of world.log.take()) {
      if (event.type === 'born' && event.conditions.species === 'tiger') {
        children.set(event.actors[0]!, { id: event.actors[0]!, motherId: event.actors[1]!,
          fatherId: event.actors[2] ?? null, bornAt: event.worldTime, snapshots: [], events: [],
          death: null, terminal48h: null,
          age70to100: { hours: 0, contactHours: 0, motherAvailableHours: 0,
            samePatchCarcassHours: 0, within300mCarcassHours: 0, maxSamePatchEdibleKg: 0,
            maxWithin300mEdibleKg: 0, provisionEvents: 0, provisionFoodKg: 0,
            cubDirectDrinks: 0, cubDirectDrinkL: 0, cubScavengeEvents: 0,
            motherHuntEvents: 0, motherScavengeEvents: 0, followParentMoves: 0 } });
      }
      for (const record of children.values()) {
        if (record.death) continue;
        const age = (event.worldTime - record.bornAt) / 86400;
        if (age >= 70 && age < 100) {
          const food = record.age70to100;
          if (event.actors[0] === record.id) {
            if (event.type === 'provisioned') {
              food.provisionEvents++;
              food.provisionFoodKg += Number(event.effects.foodEquivalentKg ?? 0);
            }
            if (event.type === 'drank') {
              food.cubDirectDrinks++;
              food.cubDirectDrinkL += Number(event.effects.litres ?? 0);
            }
            if (event.type === 'scavenged') food.cubScavengeEvents++;
            if (event.type === 'moved' && event.goal === 'follow_parent') food.followParentMoves++;
          }
          if (event.actors[0] === record.motherId) {
            if (event.type === 'hunt') food.motherHuntEvents++;
            if (event.type === 'scavenged') food.motherScavengeEvents++;
          }
        }
        if (event.actors.includes(record.id) || event.actors.includes(record.motherId)) {
          record.events.push(event);
          while (record.events.length && (record.events[0] as { worldTime: number }).worldTime < world.now() - horizon)
            record.events.shift();
        }
        if (event.type === 'died' && event.actors[0] === record.id) {
          record.death = { worldTime: event.worldTime, ageDays: event.conditions.ageDays,
            cause: event.conditions.cause, careState: event.conditions.careState,
            hunger: event.conditions.hunger, thirst: event.conditions.thirst };
          record.terminal48h = { snapshots: record.snapshots, events: record.events };
        }
      }
    }
  }
  if (day % 60 === 59) console.error(`v0.23 seed-${seed} tiger food-care ${day + 1}/${days} days`);
}
const result = { fixture: `sim_0.23.0 seed ${seed} island_v1 + household_v1 canonical cohort, hourly through day ${days}`,
  children: [...children.values()].map(record => ({ id: record.id, motherId: record.motherId,
    fatherId: record.fatherId, bornAt: record.bornAt, death: record.death,
    ...(days === 360
      ? { aliveAtDay360: world.agents.some(agent => agent.id === record.id && agent.alive) }
      : { aliveAtDay300: world.agents.some(agent => agent.id === record.id && agent.alive) }),
    age70to100: record.age70to100, terminal48h: record.terminal48h })),
  finalTigerCount: world.livingCount('tiger'), wallClockMs: Date.now() - started };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, children: result.children.map(child => ({ id: child.id, bornAt: child.bornAt,
  death: child.death, age70to100: child.age70to100 })), finalTigerCount: result.finalTigerCount,
  wallClockMs: result.wallClockMs }, null, 2));
