import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { treeAnchorGeometry } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { LifeStore } from '../src/db/lifeStore.js';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { loadSelectedClimb } from '../../client/src/lifeHistory.js';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 44, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: { langur: 1, squirrel: 1 }, minPopulation: {}, landscape: null });
afterAll(async () => { await pool?.end(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
maybe('direct retained tree-route retrieval', () => {
  beforeEach(async () => { await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade'); });
  const start = async () => {
    const host = new SimHost(options()); await host.boot();
    const langur = host.world.agents.find(a => a.speciesId === 'langur')!;
    const squirrel = host.world.agents.find(a => a.speciesId === 'squirrel')!;
    const anchor = treeAnchorGeometry(ISLAND_GRID, 210)!;
    const position = { x: anchor.x, z: anchor.z, heading: 0 };
    const trace = { version: 1 as const, actorId: langur.id, startWorldTime: 0, destinationPatchId: 210,
      goal: 'flee' as const, completed: true,
      samples: Array.from({ length: 64 }, (_, i) => ({ seconds: i, position, altitudeM: i * 6 / 63 })) };
    const event = host.world.log.append({ type: 'tree_climbed', worldTime: 63, simVersion: '', patchId: 210,
      actors: [langur.id], goal: 'flee', conditions: { direction: 'ascend', treeAnchorId: anchor.id,
        reason: 'local_threat', from: 210, destination: 210 }, outcome: 'success',
      effects: { verticalDistanceM: 6, horizontalDistanceM: 0, distanceM: 6, durationSeconds: 63, sprintSeconds: 0 },
      causalParents: [], confidence: 'authoritative', movement: trace, position });
    return { host, langur, squirrel, event, trace };
  };
  it('fetches only one actor/checkpoint-bound climb and excludes its JSON from history lists', async () => {
    const { host, langur, squirrel, event, trace } = await start();
    await host.flush(); const api = buildApi({ host, pool: pool! });
    const path = `/animals/${langur.id}/movements/${event.id}`;
    try {
      expect((await api.inject(path)).statusCode).toBe(404); // Not yet in a saved checkpoint.
      await host.advance(1); await host.snapshotNow();
      const selected = await api.inject(path);
      expect(selected.statusCode).toBe(200); expect(selected.headers['cache-control']).toBe('no-store');
      expect(selected.json()).toMatchObject({ source: 'checkpoint', scope: 'movement', id: langur.id,
        movement: { eventId: event.id, trace, direction: 'ascend', verticalDistanceM: 6 } });
      expect(selected.json()).not.toHaveProperty('track'); expect(selected.json()).not.toHaveProperty('moments');
      expect((await api.inject(`/animals/${squirrel.id}/movements/${event.id}`)).statusCode).toBe(404);
      expect((await api.inject(`/animals/${langur.id}/movements/missing`)).statusCode).toBe(404);
      expect((await api.inject({ method: 'POST', url: path })).statusCode).toBe(404);

      const raw = await api.inject(`/animals/${langur.id}/events`);
      const summary = await api.inject(`/animals/${langur.id}/events?view=summary&limit=500`);
      const summaryEvent = summary.json().events.find((entry: { id: string }) => entry.id === event.id);
      expect(summaryEvent).toMatchObject({ id: event.id, type: 'tree_climbed', hasClimb: true });
      expect(summaryEvent).not.toHaveProperty('movement');
      expect(summary.body.length).toBeLessThan(raw.body.length / 4);
      const pagedReads = vi.spyOn(EventStore.prototype, 'page');
      const page = await api.inject(`/animals/${langur.id}/life`);
      expect(page.json().moments.some((line: { eventId: string }) => line.eventId === event.id)).toBe(true);
      expect(page.body).not.toContain('altitudeM'); // Retained life page has text, not route geometry.
      const recap = await api.inject(`/animals/${langur.id}/recap?since=0`);
      expect(recap.json().lines.some((line: { eventId: string }) => line.eventId === event.id)).toBe(true);
      expect(pagedReads.mock.calls.filter(([options]) => options.types !== undefined)
        .every(([options]) => options.omitMovement === true)).toBe(true);
      pagedReads.mockRestore();

      const pages = vi.spyOn(EventStore.prototype, 'page'), tracks = vi.spyOn(LifeStore.prototype, 'trackOf');
      const fetcher = vi.fn(async (request: string) => {
        const result = await api.inject(request.replace('/api/', '/'));
        return new Response(result.body, { status: result.statusCode });
      });
      vi.stubGlobal('fetch', fetcher);
      const loaded = await loadSelectedClimb(langur.id, event.id, new AbortController().signal);
      expect(fetcher).toHaveBeenCalledTimes(1); expect(pages).not.toHaveBeenCalled(); expect(tracks).not.toHaveBeenCalled();
      expect(loaded.track).toEqual([]); expect(loaded.climbs?.[0]).toMatchObject({ trace });

      await new LifeStore(pool!, ISLAND_GRID).pruneRoutine(100);
      expect((await api.inject(path)).statusCode).toBe(200); // Significant climb survives routine pruning.
      host.lastError = 'private-error';
      const failed = await api.inject(path); expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain('private');
      host.lastError = null;
    } finally { host.lastError = null; await api.close(); }
  });
  it('keeps the selected trace after restart and refuses a forged additional actor', async () => {
    const { host, langur, squirrel, event } = await start(); await host.advance(1); await host.snapshotNow();
    const api = buildApi({ host, pool: pool! });
    try {
      await host.abort();
      const restored = new SimHost(options()); await restored.boot();
      const restarted = buildApi({ host: restored, pool: pool! });
      try {
        const path = (id: string) => `/animals/${id}/movements/${event.id}`;
        expect((await restarted.inject(path(langur.id))).statusCode).toBe(200);
        await pool!.query('update events set actors = array_append(actors, $1) where id=$2', [squirrel.id, event.id]);
        expect((await restarted.inject(path(squirrel.id))).statusCode).toBe(404);
      } finally { await restarted.close(); }
    } finally { await api.close(); }
  });
});
