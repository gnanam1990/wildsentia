import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { initialPosition } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { buildApi } from '../src/api.js';
import { SimHost } from './trackedHost.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null;
const maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 44, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: { sambar: 2 }, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 12 });
afterAll(async () => { await pool?.end(); });
maybe('durable lifecycle map locations', () => {
  beforeEach(async () => {
    await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
  });
  it('removes unsaved deaths at the exact checkpoint timestamp and regenerates the same history after recovery', async () => {
    const first = new SimHost(options()); await first.boot();
    const dying = first.world.agents[0]!; dying.drives.hunger = 1;
    await first.snapshotNow();
    const cutoff = first.checkpointEventSequence, time = first.checkpointTime!;
    await first.advance(1);
    const store = new EventStore(pool!);
    const original = (await store.byActor(dying.id, 100)).find((e) => e.type === 'died')!;
    expect(original.worldTime).toBe(time);
    expect(await store.countAfter(time, cutoff)).toBeGreaterThan(await store.countAfter(time));
    await first.abort();
    const resumed = new SimHost(options()); const boot = await resumed.boot();
    expect(boot.rolledBackEvents).toBeGreaterThan(0);
    expect(resumed.world.agents.find((a) => a.id === dying.id)!.alive).toBe(true);
    expect(await store.deathOf(dying.id)).toBeNull();
    expect(await store.countAfter(time, cutoff)).toBe(0);
    await resumed.advance(1); await resumed.snapshotNow();
    expect(await store.deathOf(dying.id)).toEqual(original);
  });
  it('publishes real birth/death positions only after checkpoint and retains them after movement, removal and restart', async () => {
    const first = new SimHost(options()); await first.boot();
    const [mother, dying] = first.world.agents;
    mother!.sex = 'female'; mother!.pregnantSince = -first.world.species.get('sambar')!.lifecycle.gestationDays * 86400;
    mother!.drives = { hunger: 0, thirst: 0, fatigue: 1, fear: 0 };
    dying!.drives.hunger = 1; const deathPosition = { ...dying!.position! };
    await first.advance(1);
    const events = await new EventStore(pool!).mapEvents(first.world.now());
    const birth = events.find((e) => e.type === 'born')!, death = events.find((e) => e.type === 'died' && e.actors[0] === dying!.id)!;
    expect(birth.position).toBeDefined(); expect(death.position).toEqual(deathPosition);
    const api = buildApi({ host: first, pool: pool! });
    try {
      expect((await api.inject('/event-map')).json().markers).toEqual([]);
      await first.snapshotNow();
      const marks = (await api.inject('/event-map')).json().markers;
      expect(marks).toContainEqual(expect.objectContaining({ id: birth.id, precision: 'recorded',
        position: { x: birth.position!.x, z: birth.position!.z } }));
      expect(marks).toContainEqual(expect.objectContaining({ id: death.id, precision: 'recorded',
        position: { x: deathPosition.x, z: deathPosition.z } }));
      const newborn = first.world.agents.find((a) => a.id === birth.actors[0])!;
      newborn.patchId = 20; newborn.position = initialPosition(newborn.id, 20);
      // Simulate a later removal solely in this disposable test world; no historical backfill.
      first.world.carcasses.splice(0);
      await first.stop();
      const resumed = new SimHost(options()); await resumed.boot();
      const next = buildApi({ host: resumed, pool: pool! });
      try { expect((await next.inject('/event-map')).json().markers).toEqual(marks); }
      finally { await next.close(); }
    } finally { await api.close(); }
  });
});
