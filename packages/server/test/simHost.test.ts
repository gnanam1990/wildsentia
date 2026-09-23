import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { SimHost } from '../src/simHost.js';
import { FOREST_LANDSCAPE, FOREST_POPULATION } from '@vana/sim';

const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

const options = () => ({
  pool: pool!, seed: 7, speciesDir,
  snapshotEveryWorldHours: 24,
  initialAgents: { sambar: 20 }, minPopulation: { sambar: 20 }, landscape: null,
});

afterAll(async () => { await pool?.end(); });

maybe('SimHost', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, follows, viewers cascade');
  });

  it('boots a fresh world when there is no snapshot', async () => {
    const host = new SimHost(options());
    const result = await host.boot();
    expect(result.restoredFrom).toBeNull();
    expect(host.world.livingCount('sambar')).toBe(20);
  });

  it('boots the whole forest by default, not a single species', async () => {
    // No population overrides: this is exactly what the live server constructs.
    const host = new SimHost({ pool: pool!, seed: 7, speciesDir });
    await host.boot();

    const present = new Set(host.world.agents.map((a) => a.speciesId));
    expect(present.size).toBe(12);
    expect([...present].sort()).toEqual([...host.world.species.keys()].sort());
    for (const [speciesId, count] of Object.entries(FOREST_POPULATION)) {
      expect(host.world.livingCount(speciesId)).toBe(count);
    }
    expect(host.worldOptions.landscape).toEqual(FOREST_LANDSCAPE);
  });

  it('persists events as the world advances', async () => {
    const host = new SimHost(options());
    await host.boot();
    await host.advance(48);
    expect(await new EventStore(pool!).total()).toBeGreaterThan(0);
  });

  it('resumes from the newest snapshot after a restart', async () => {
    const first = new SimHost(options());
    await first.boot();
    await first.advance(48);
    await first.stop();
    const timeBefore = first.world.now();

    const second = new SimHost(options());
    const result = await second.boot();

    expect(result.restoredFrom).toBe(timeBefore);
    expect(second.world.now()).toBe(timeBefore);
    expect(second.world.agents.map((a) => a.id)).toEqual(first.world.agents.map((a) => a.id));
  });

  it('continues deterministically from the restored state', async () => {
    const first = new SimHost(options());
    await first.boot();
    await first.advance(24);
    await first.stop();

    const second = new SimHost(options());
    await second.boot();

    await first.advance(24);
    await second.advance(24);

    expect(second.world.agents.map((a) => [a.id, a.patchId, a.drives.hunger]))
      .toEqual(first.world.agents.map((a) => [a.id, a.patchId, a.drives.hunger]));
  });

  it('rolls back events that outlived the newest snapshot and records why', async () => {
    const host = new SimHost(options());
    await host.boot();
    await host.advance(24);
    await host.snapshotNow();
    const snapshotTime = host.world.now();
    await host.advance(6);
    await host.flush();

    const store = new EventStore(pool!);
    expect(await store.countAfter(snapshotTime)).toBeGreaterThan(0);

    const restarted = new SimHost(options());
    const result = await restarted.boot();

    expect(result.rolledBackEvents).toBeGreaterThan(0);
    expect(await store.countAfter(snapshotTime)).toBe(0);
    expect((await store.recent(5)).some((e) => e.type === 'maintenance')).toBe(true);
  });
});
