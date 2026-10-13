import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { makeCarcass } from '@vana/sim';
import { isMovementTrace } from '@vana/shared';
import { LiveEncounterPlayer } from '../../client/src/liveEncounters.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 5, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: { dhole: 3 }, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 12 });
afterAll(async () => { await pool?.end(); });
maybe('durable pack food delivery', () => {
  beforeEach(async () => {
    await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
  });
  it('restores an undelivered parcel after an uncheckpointed delivery, then publishes one source-linked transfer and route', async () => {
    const host = new SimHost(options()); await host.boot();
    const [donor, mother, child] = host.world.agents;
    for (const p of host.world.patches) p.habitat = 'grassland';
    for (const a of host.world.agents) Object.assign(a, { groupId: donor!.groupId, patchId: 0,
      pregnantSince: null, ageDays: 900, drives: { hunger: 0.1, thirst: 0.1, fear: 0, fatigue: 0 } });
    donor!.position = { x: -100, z: 0, heading: 0 }; donor!.sex = 'male';
    mother!.position = { x: 100, z: 0, heading: 0 }; mother!.sex = 'female'; mother!.offspringIds = [child!.id];
    mother!.drives.hunger = 0.3;
    Object.assign(child!, { ageDays: 3, lifeStage: 'newborn', massKg: 2, dependentOn: mother!.id, motherId: mother!.id,
      position: { x: 100.1, z: 0, heading: 0 }, drives: { hunger: 0.3, thirst: 0.3, fear: 0, fatigue: 0 } });
    const source = makeCarcass('fixture-source', 'prey', 'sambar', 0, 0, 'natural', 'authoritative', 100);
    source.position = { x: 0, z: 0, heading: 0 }; host.world.carcasses.push(source);
    await host.snapshotNow(); const baseline = host.world.totalNutrients();
    await host.advance(1);
    const api = buildApi({ host, pool: pool! }); await api.ready();
    const path = `/animals/${mother!.id}/events`;
    try {
      expect((await api.inject(path)).json().events.some((e: { type: string }) => e.type === 'pack_food_collected')).toBe(false);
      await host.snapshotNow();
      const saved = (await new SnapshotStore(pool!).loadLatest())!.agents.find(a => a.id === donor!.id)!;
      expect(saved.packFood!.kg).toBeGreaterThan(0);
      await host.advance(1);
      expect((await api.inject(path)).json().events.some((e: { type: string }) => e.type === 'pack_food_delivered')).toBe(false);
      expect(host.world.totalNutrients()).toBeCloseTo(baseline, 7);
      const unsaved = (await new EventStore(pool!).recent(1000)).find(e => e.type === 'pack_food_delivered')!;
      expect(unsaved).toBeDefined();
      await host.abort();
      const resumed = new SimHost(options()); await resumed.boot();
      expect(resumed.world.agents.find(a => a.id === donor!.id)!.packFood).toEqual(saved.packFood);
      expect(resumed.liveEncounterFrame()).toBeNull();
      expect((await new EventStore(pool!).recent(1000)).some(e => e.type === 'pack_food_delivered')).toBe(false);
      await resumed.advance(1); await resumed.snapshotNow();
      const publicApi = buildApi({ host: resumed, pool: pool! }); await publicApi.ready();
      try {
        const events = (await publicApi.inject(path)).json().events;
        const deliveries = events.filter((e: { type: string }) => e.type === 'pack_food_delivered');
        expect(deliveries).toEqual([unsaved]);
        expect(resumed.world.totalNutrients()).toBeCloseTo(baseline, 7);
        const all = await new EventStore(pool!).recent(1000), route = all.find(e => e.id === unsaved.causalParents[1])!;
        expect(isMovementTrace(ISLAND_GRID, route.movement)).toBe(true);
        expect(route.movement!.goal).toBe('deliver_pack_food');
        expect(unsaved.causalParents[0]).toBe(saved.packFood!.sourceEventId);
        const frame = JSON.parse(JSON.stringify(resumed.liveEncounterFrame()!)), player = new LiveEncounterPlayer();
        expect(player.apply({ ...frame, elapsedWorldSeconds: 0 }, 0)).toBe(true);
        expect(player.poses(0).get(donor!.id)!.position.x).toBeCloseTo(saved.position!.x);
        const midpoint = player.poses((Number(unsaved.conditions.arrivalWorldTime) - frame.startWorldTime) / 2 / frame.rate * 1000).get(donor!.id)!;
        expect(midpoint.position.x).toBeGreaterThan(saved.position!.x);
        expect(midpoint.position.x).toBeLessThan(unsaved.position!.x);
      } finally { await publicApi.close(); }
    } finally { await api.close(); }
  });
});
