import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWorld, takeSnapshot } from '@vana/sim';
import { buildApi } from '../src/api.js';
import { EventStore } from '../src/db/eventStore.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { SimHost } from './trackedHost.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const worldOptions = { seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialCommunityRulesVersion: 7 as const, initialAgents: {}, minPopulation: {} };
const options = () => ({ ...worldOptions, pool: pool!, landscape: null, snapshotEveryWorldHours: 1000 });
afterAll(async () => { await pool?.end(); });

maybe('checkpointed v7 family observer', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade');
  });

  it('hides uncommitted birth, then persists the child, family feed and map target across restart', async () => {
    const seed = createWorld(worldOptions), family = seed.community!;
    const mother = family.people[0]!, father = family.people[1]!;
    for (const person of family.people) person.needs = { hunger: .1, thirst: .1, fatigue: .9 };
    const conception = seed.log.append({ type: 'human_conceived', worldTime: 0, simVersion: '',
      patchId: mother.patchId, position: { ...mother.position }, actors: [mother.id, father.id, family.id],
      conditions: { model: 'saved_fixture' }, outcome: 'success', effects: {}, causalParents: [],
      confidence: 'authoritative' });
    // Account for every gram in the saved pregnancy fixture, just as a real prenatal meal does.
    const prenatalKg = 2.8;
    seed.patches[mother.patchId]!.plant.grass -= prenatalKg;
    mother.pregnancy = { fatherId: father.id, conceivedAt: 0, dueAt: 3600, fetusKg: prenatalKg,
      conceivedEventId: conception.id };
    const baseline = seed.totalNutrients();
    await new EventStore(pool!).appendBatch(seed.log.take());
    await new SnapshotStore(pool!).save(takeSnapshot(seed));

    const host = new SimHost(options()); await host.boot();
    const api = buildApi({ host, pool: pool! });
    try {
      await host.advance(1);
      expect(host.world.community!.people[4]!.id).toBe('person_0005');
      expect((await api.inject('/community')).json().community.people).toHaveLength(4);
      expect((await api.inject('/event-map')).json().markers.some((m: { type: string }) => m.type === 'human_born')).toBe(false);
      expect((await api.inject('/people/person_0005')).statusCode).toBe(404);

      await host.snapshotNow();
      const bornPage = (await api.inject('/community')).json();
      const birth = bornPage.events.find((e: { type: string }) => e.type === 'human_born');
      expect(birth).toMatchObject({ actors: ['person_0005', mother.id, father.id, family.id],
        causalParents: [conception.id] });
      expect(bornPage.events.some((e: { id: string }) => e.id === conception.id)).toBe(true);
      const marker = (await api.inject('/event-map')).json().markers.find((m: { id: string }) => m.id === birth.id);
      expect(marker).toMatchObject({ type: 'human_born', actorId: 'person_0005', label: 'Human birth', precision: 'recorded',
        position: { x: birth.position.x, z: birth.position.z } });
      expect((await api.inject('/people/person_0005')).json().person).toMatchObject({ id: 'person_0005',
        motherId: mother.id, fatherId: father.id, bornAt: 3600 });
      expect((await api.inject('/people/person_0005/events')).json().events.some((e: { id: string }) => e.id === birth.id)).toBe(true);
      expect(host.world.totalNutrients()).toBeCloseTo(baseline, 5);

      const living = host.world.community!, child = living.people[4]!, caregiver = living.people[1]!;
      child.needs.hunger = .8; child.needs.thirst = .8;
      for (const adult of living.people.slice(0, 4)) { adult.task = null; adult.needs = { hunger: .1, thirst: .1, fatigue: .1 }; }
      const foodPatch = host.world.patches[caregiver.patchId]!;
      const waterPatch = host.world.patches.find(p => p.waterVolume >= .8)!;
      expect(foodPatch.plant.grass).toBeGreaterThan(.5);
      expect(waterPatch).toBeDefined();
      foodPatch.plant.grass -= .5; caregiver.inventory.foodKg += .5;
      waterPatch.waterVolume -= .8; caregiver.inventory.waterL += .8;
      const beforeCare = host.world.totalNutrients();
      await host.advance(2);
      expect((await api.inject('/community')).json().events.some((e: { type: string }) => e.type === 'human_cared')).toBe(false);
      await host.snapshotNow();
      const cared = (await api.inject('/community')).json().events.find((e: { type: string }) => e.type === 'human_cared');
      expect(cared).toMatchObject({ actors: [child.id, caregiver.id, living.id], outcome: 'success' });
      expect((await api.inject(`/people/${child.id}/events`)).json().events.some((e: { id: string }) => e.id === cared.id)).toBe(true);
      expect(host.world.totalNutrients()).toBeCloseTo(beforeCare, 5);

      const saved = takeSnapshot(host.world); await host.abort();
      const resumed = new SimHost(options()); await resumed.boot();
      const next = buildApi({ host: resumed, pool: pool! });
      try {
        expect(takeSnapshot(resumed.world)).toEqual(saved);
        expect((await next.inject('/event-map')).json().markers).toContainEqual(marker);
        expect((await next.inject('/community')).json().events.filter((e: { id: string }) => e.id === birth.id)).toHaveLength(1);
        expect((await next.inject('/community')).json().events.filter((e: { id: string }) => e.id === cared.id)).toHaveLength(1);
        expect((await next.inject('/people/person_0005')).json().person.id).toBe('person_0005');
      } finally { await next.close(); await resumed.abort(); }
    } finally { await api.close(); await host.abort(); }
  });

  it('retains a real due pregnancy loss in the checkpointed village feed without inventing a child', async () => {
    const seed = createWorld(worldOptions), family = seed.community!;
    const mother = family.people[0]!, father = family.people[1]!;
    for (const person of family.people) person.needs = { hunger: .1, thirst: .1, fatigue: .9 };
    const conception = seed.log.append({ type: 'human_conceived', worldTime: 0, simVersion: '',
      patchId: mother.patchId, position: { ...mother.position }, actors: [mother.id, father.id, family.id],
      conditions: { model: 'saved_fixture' }, outcome: 'success', effects: {}, causalParents: [],
      confidence: 'authoritative' });
    seed.patches[mother.patchId]!.plant.grass -= 1;
    mother.pregnancy = { fatherId: father.id, conceivedAt: 0, dueAt: 3600, fetusKg: 1,
      conceivedEventId: conception.id };
    await new EventStore(pool!).appendBatch(seed.log.take());
    await new SnapshotStore(pool!).save(takeSnapshot(seed));
    const host = new SimHost(options()); await host.boot();
    const api = buildApi({ host, pool: pool! });
    try {
      await host.advance(1);
      expect(host.world.community!.people).toHaveLength(4);
      expect((await api.inject('/community')).json().events.some((e: { type: string }) => e.type === 'human_pregnancy_lost')).toBe(false);
      await host.snapshotNow();
      const page = (await api.inject('/community')).json();
      const lost = page.events.find((e: { type: string }) => e.type === 'human_pregnancy_lost');
      expect(lost).toMatchObject({ actors: [mother.id, father.id, family.id], causalParents: [conception.id],
        conditions: { reason: 'insufficient_growth' } });
      expect(page.events.some((e: { id: string }) => e.id === conception.id)).toBe(true);
      expect(page.events.some((e: { type: string }) => e.type === 'human_born')).toBe(false);
    } finally { await api.close(); await host.abort(); }
  });
});
