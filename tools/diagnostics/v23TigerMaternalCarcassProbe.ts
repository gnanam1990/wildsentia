/** Read-only seed-1 audit of parent-opened, finite carcass opportunities for v0.23 tiger cubs. */
import { writeFileSync } from 'node:fs';
import { edibleMass } from '@vana/shared';
import { ISLAND_POPULATION, SIM_VERSION, createWorld } from '@vana/sim';

if (SIM_VERSION !== 'sim_0.23.0') throw new Error('Pinned to v0.23 source');
const output = process.argv[2];
if (!output) throw new Error('Usage: npx tsx tools/diagnostics/v23TigerMaternalCarcassProbe.ts NEW_OUTPUT.json');
const started = Date.now();
const world = createWorld({ seed: 1, speciesDir: new URL('../../config/species', import.meta.url).pathname,
  terrainProfile: 'island_v1', communityProfile: 'household_v1', initialAgents: ISLAND_POPULATION,
  minPopulation: {}, retainEvents: 200_000 });
const tiger = world.species.get('tiger')!;
const carcassContactRadiusM = Math.max(0.35, tiger.body.shoulderHeightM * 0.65);
type CarcassOpportunity = { carcassId: string; originId: string; speciesId: string; cause: string;
  firstSeenAt: number; firstSeenAgeDays: number; firstSeenEdibleKg: number;
  firstSeenDistanceM: number; firstSeenSamePatch: boolean; motherConsumedKgBeforeFirstSeen: number };
type RecordForCub = { id: string; motherId: string; bornAt: number; death: unknown | null;
  hoursObserved: number; hungryHours: number; motherAliveHours: number;
  anyParentOpenedHours: number; samePatchHours: number; within120mHours: number;
  within300mHours: number; contactHours: number; hungrySamePatchHours: number;
  hungryContactHours: number; maxSamePatchEdibleKg: number; maxWithin120mEdibleKg: number;
  maxWithin300mEdibleKg: number; maxContactEdibleKg: number;
  firstSamePatch: unknown | null; firstContact: unknown | null;
  unique: Map<string, CarcassOpportunity>; last5PositiveSamples: unknown[] };
const cubs = new Map<string, RecordForCub>();

for (let day = 0; day < 203; day++) {
  for (let hour = 0; hour < 24; hour++) {
    const now = world.now();
    for (const record of cubs.values()) {
      if (record.death) continue;
      const child = world.agents.find(agent => agent.id === record.id);
      if (!child?.alive || !child.position || child.ageDays < 70) continue;
      const mother = world.agents.find(agent => agent.id === record.motherId);
      const motherAlive = !!mother?.alive;
      record.hoursObserved++;
      if (motherAlive) record.motherAliveHours++;
      const hungry = child.drives.hunger >= 0.8;
      if (hungry) record.hungryHours++;
      const opened = motherAlive ? world.carcasses.filter(carcass =>
        edibleMass(carcass.biomass) > 0 && carcass.position
        && carcass.consumers.some(consumer => consumer.agentId === record.motherId && consumer.at <= now)) : [];
      let samePatchEdibleKg = 0, within120mEdibleKg = 0;
      let within300mEdibleKg = 0, contactEdibleKg = 0;
      for (const carcass of opened) {
        const kg = edibleMass(carcass.biomass);
        const distanceM = Math.hypot(carcass.position!.x - child.position.x,
          carcass.position!.z - child.position.z);
        const samePatch = carcass.patchId === child.patchId;
        if (samePatch) samePatchEdibleKg += kg;
        if (distanceM <= 120) within120mEdibleKg += kg;
        if (distanceM <= 300) within300mEdibleKg += kg;
        if (distanceM <= carcassContactRadiusM) contactEdibleKg += kg;
        if (!record.unique.has(carcass.id)) record.unique.set(carcass.id, {
          carcassId: carcass.id, originId: carcass.originId, speciesId: carcass.speciesId,
          cause: carcass.cause, firstSeenAt: now, firstSeenAgeDays: child.ageDays,
          firstSeenEdibleKg: kg, firstSeenDistanceM: distanceM, firstSeenSamePatch: samePatch,
          motherConsumedKgBeforeFirstSeen: carcass.consumers.filter(consumer =>
            consumer.agentId === record.motherId && consumer.at <= now)
            .reduce((sum, consumer) => sum + consumer.kg, 0) });
      }
      if (opened.length) record.anyParentOpenedHours++;
      if (samePatchEdibleKg > 0) {
        record.samePatchHours++;
        if (hungry) record.hungrySamePatchHours++;
        record.firstSamePatch ??= { worldTime: now, ageDays: child.ageDays,
          edibleKg: samePatchEdibleKg, hunger: child.drives.hunger, patchId: child.patchId };
      }
      if (within120mEdibleKg > 0) record.within120mHours++;
      if (within300mEdibleKg > 0) record.within300mHours++;
      if (contactEdibleKg > 0) {
        record.contactHours++;
        if (hungry) record.hungryContactHours++;
        record.firstContact ??= { worldTime: now, ageDays: child.ageDays,
          edibleKg: contactEdibleKg, hunger: child.drives.hunger, patchId: child.patchId };
      }
      record.maxSamePatchEdibleKg = Math.max(record.maxSamePatchEdibleKg, samePatchEdibleKg);
      record.maxWithin120mEdibleKg = Math.max(record.maxWithin120mEdibleKg, within120mEdibleKg);
      record.maxWithin300mEdibleKg = Math.max(record.maxWithin300mEdibleKg, within300mEdibleKg);
      record.maxContactEdibleKg = Math.max(record.maxContactEdibleKg, contactEdibleKg);
      if (samePatchEdibleKg > 0 || contactEdibleKg > 0) {
        record.last5PositiveSamples.push({ worldTime: now, ageDays: child.ageDays,
          hunger: child.drives.hunger, childPatchId: child.patchId, motherPatchId: mother!.patchId,
          samePatchEdibleKg, within120mEdibleKg, within300mEdibleKg, contactEdibleKg });
        if (record.last5PositiveSamples.length > 5) record.last5PositiveSamples.shift();
      }
    }
    world.step(1);
    for (const event of world.log.take()) {
      if (event.type === 'born' && event.conditions.species === 'tiger') {
        cubs.set(event.actors[0]!, { id: event.actors[0]!, motherId: event.actors[1]!,
          bornAt: event.worldTime, death: null, hoursObserved: 0, hungryHours: 0,
          motherAliveHours: 0, anyParentOpenedHours: 0, samePatchHours: 0,
          within120mHours: 0, within300mHours: 0, contactHours: 0,
          hungrySamePatchHours: 0, hungryContactHours: 0, maxSamePatchEdibleKg: 0,
          maxWithin120mEdibleKg: 0, maxWithin300mEdibleKg: 0, maxContactEdibleKg: 0,
          firstSamePatch: null, firstContact: null, unique: new Map(), last5PositiveSamples: [] });
      }
      if (event.type === 'died' && cubs.has(event.actors[0]!)) {
        const cub = cubs.get(event.actors[0]!)!;
        cub.death = { worldTime: event.worldTime, ageDays: event.conditions.ageDays,
          cause: event.conditions.cause, careState: event.conditions.careState };
      }
    }
  }
  if (day % 40 === 39 || day === 202) console.error(`v0.23 seed-1 maternal carcass audit ${day + 1}/203 days`);
}
const result = { fixture: 'sim_0.23.0 seed 1 island_v1 + household_v1 canonical cohort; hourly to day 203',
  definition: 'Parent-opened means a living mother is already listed as a consumer of a carcass with positive remaining edible mass; opportunity does not prove the cub detected, reached or ate it.',
  carcassContactRadiusM, cubs: [...cubs.values()].map(({ unique, ...record }) => ({
    ...record, uniqueParentOpenedCarcasses: [...unique.values()], uniqueCarcassCount: unique.size })),
  wallClockMs: Date.now() - started };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, cubs: result.cubs.map(cub => ({ id: cub.id, death: cub.death,
  hoursObserved: cub.hoursObserved, samePatchHours: cub.samePatchHours,
  contactHours: cub.contactHours, uniqueCarcassCount: cub.uniqueCarcassCount,
  maxSamePatchEdibleKg: cub.maxSamePatchEdibleKg, maxContactEdibleKg: cub.maxContactEdibleKg })),
  wallClockMs: result.wallClockMs }, null, 2));
