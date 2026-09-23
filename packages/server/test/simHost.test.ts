import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { LifeStore } from '../src/db/lifeStore.js';
import { SimHost } from '../src/simHost.js';
import { FOREST_LANDSCAPE, FOREST_POPULATION } from '@vana/sim';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
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
    await pool!.query('truncate events, snapshots, follows, viewers, tracks, animal_archive cascade');
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

  it('samples where every animal is, every few world hours', async () => {
    const host = new SimHost({ ...options(), trackEveryWorldHours: 6 });
    await host.boot();
    await host.advance(13);
    const id = host.world.agents[0]!.id;
    const track = await new LifeStore(pool!).trackOf(id);
    expect(track.map((p) => p.worldTime)).toEqual([6 * 3600, 12 * 3600]);
    expect(track[1]!.patchId).toBeGreaterThanOrEqual(0);
  });

  it('prunes routine events past their window, keeping the rest', async () => {
    const host = new SimHost({ ...options(), routineRetentionWorldDays: 1, housekeepingEveryWorldHours: 24 });
    await host.boot();
    await host.advance(24 * 3);
    const { rows } = await pool!.query<{ n: string }>(
      "select count(*) as n from events where type = 'moved' and world_time < $1", [(3 - 1) * 86_400],
    );
    expect(Number(rows[0]!.n)).toBe(0);
    const { rows: recent } = await pool!.query<{ n: string }>(
      "select count(*) as n from events where type = 'moved' and world_time >= $1", [2 * 86_400],
    );
    expect(Number(recent[0]!.n)).toBeGreaterThan(0);
  });

  it('archives the long departed and lets the world forget them', async () => {
    // Tigers with nothing to hunt starve within a couple of weeks.
    const host = new SimHost({
      ...options(), initialAgents: { tiger: 3 }, minPopulation: {},
      archiveAfterWorldDays: 1, housekeepingEveryWorldHours: 24,
    });
    await host.boot();
    await host.advance(24 * 30);
    const { rows } = await pool!.query<{ id: string }>('select id from animal_archive');
    expect(rows.length).toBeGreaterThan(0);
    for (const { id } of rows) expect(host.world.deceased.some((a) => a.id === id)).toBe(false);
    expect((await new LifeStore(pool!).archived(rows[0]!.id))?.alive).toBe(false);
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
