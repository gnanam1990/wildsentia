import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
afterAll(async () => { await pool?.end(); });
maybe('micro-ecology endpoint', () => {
  beforeEach(async () => {
    await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
  });
  it('answers from the saved checkpoint like every other read, instead of failing on every call', async () => {
    const host = new SimHost({ pool: pool!, seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
      initialAgents: {}, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 12 });
    await host.boot(); await host.snapshotNow();
    const api = buildApi({ host, pool: pool! }); await api.ready();
    try {
      const response = await api.inject('/micro-ecology');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json();
      expect(body.source).toBe('checkpoint');
      expect(body.worldTime).toBe((await api.inject('/world')).json().worldTime);
      expect(body).toHaveProperty('ecology');
    } finally { await api.close(); await host.abort(); }
  });
});
