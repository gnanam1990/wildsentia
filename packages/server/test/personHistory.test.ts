import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { LifeStore } from '../src/db/lifeStore.js';
import { testDatabaseUrl } from './testDatabase.js';
import { HistoryPager } from '../../client/src/history.js';
import { communityEventText } from '../../client/src/communityObserver.js';
import { isPersonHistoryPage, personHistorySource, type PersonHistoryPage } from '../../client/src/personHistory.js';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialAgents: {}, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 1000 });
afterAll(async () => { await pool?.end(); }); afterEach(() => vi.unstubAllGlobals());
maybe('checkpoint-pinned person history end to end', () => {
  beforeEach(async () => { await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade'); });
  it('traverses actual history beyond 50 events with no omissions, duplicates, volatile outcomes or mixed people', async () => {
    const host = new SimHost(options()); await host.boot(); await host.advance(24); await host.snapshotNow();
    const id = 'person_0001', expected = (await pool!.query('select id from events where $1 = any(actors) order by world_time desc, id collate "C" desc', [id])).rows.map(r => r.id);
    expect(expected.length).toBeGreaterThan(50);
    const api = buildApi({ host, pool: pool! }), at = host.world.now();
    try {
      let path = `/people/${id}/events?limit=25`, first: PersonHistoryPage | undefined;
      const seen: string[] = [];
      while (path) {
        const response = await api.inject(path), page = response.json<PersonHistoryPage>();
        expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
        expect(isPersonHistoryPage(page, id)).toBe(true); expect(page.asOfWorldTime).toBe(at);
        expect(page.events.every(e => e.actors.includes(id))).toBe(true); seen.push(...page.events.map(e => e.id));
        if (!first) { first = page; await host.advance(1); await host.snapshotNow(); }
        path = page.nextCursor ? `/people/${id}/events?limit=25&cursor=${encodeURIComponent(page.nextCursor)}` : '';
      }
      expect(seen).toEqual(expected); expect(new Set(seen).size).toBe(expected.length);
      const repeated = (await api.inject(`/people/${id}/events?limit=25&cursor=${first!.pageCursor}`)).json();
      expect(repeated.events).toEqual(first!.events);
      for (const route of ['/people/person_0002/events', `/animals/${id}/events?view=summary`, '/events']) {
        const sep = route.includes('?') ? '&' : '?';
        expect((await api.inject(`${route}${sep}cursor=${first!.nextCursor}`)).statusCode).toBe(400);
      }
      expect((await api.inject('/people/missing/events')).statusCode).toBe(404);
      for (const limit of ['0', '501', '2.5', '-1']) expect((await api.inject(`/people/${id}/events?limit=${limit}`)).statusCode).toBe(400);
      vi.stubGlobal('fetch', async (url: string) => { const r = await api.inject(url.replace('/api/', '/')); return new Response(r.body, { status: r.statusCode }); });
      const pager = new HistoryPager(undefined, personHistorySource); await pager.open(id); const pageOne = pager.page;
      await host.advance(1); await host.snapshotNow(); await pager.next(); expect(pager.pageNumber).toBe(2);
      await pager.previous(); expect(pager.page).toEqual(pageOne);
      const stable = host.world.now(); await pager.next(); expect(host.world.now()).toBe(stable);
      expect((await api.inject({ method: 'POST', url: `/people/${id}/events`, payload: { action: 'train' } })).statusCode).toBe(404);
      host.lastError = 'private writer detail'; expect((await api.inject(`/people/${id}/events`)).statusCode).toBe(503); host.lastError = null;
    } finally { await api.close(); }
  });

  it('keeps real deaths and milestones after routine pruning and restart, invalidating old cursors instead of mixing worlds', async () => {
    const first = new SimHost(options()); await first.boot(); await first.advance(24);
    // Failure fixture: no local supplies; the actual needs/mortality rules produce the death.
    const c = first.world.community!, patch = first.world.patches[c.patchId]!;
    patch.plant.grass = 0; patch.plant.browse = 0; patch.capacity.grass = 0; patch.capacity.browse = 0;
    patch.waterVolume = 0; c.stores.foodKg = 0; c.stores.waterL = 0; c.stores.rawFishKg = 0;
    for (const p of c.people) { p.health = .001; p.needs.thirst = 1; p.inventory.waterL = 0; p.task = null; }
    await first.advance(1); await first.snapshotNow();
    expect(c.people.every(p => !p.alive)).toBe(true);
    const api = buildApi({ host: first, pool: pool! });
    let oldCursor: string;
    try {
      const page = (await api.inject('/people/person_0001/events?limit=25')).json<PersonHistoryPage>();
      oldCursor = page.pageCursor;
      const death = page.events.find(e => e.type === 'human_died')!;
      expect(communityEventText(death)).toContain('recorded cause: dehydration');
      expect((await api.inject('/event-map')).json().markers).toContainEqual(expect.objectContaining({
        id: death.id, type: 'human_died', actorId: 'person_0001', label: 'Human death',
        precision: 'recorded', position: { x: death.position!.x, z: death.position!.z },
      }));
      await new LifeStore(pool!, ISLAND_GRID).pruneRoutine(first.world.now() + 1);
      const pruned = (await api.inject('/people/person_0001/events?limit=25')).json<PersonHistoryPage>();
      expect(pruned.events.some(e => e.id === death.id)).toBe(true);
      expect(pruned.events.every(e => e.type !== 'human_task_started' && e.type !== 'human_task_finished')).toBe(true);
      expect(pruned.retention).toContain('no invented birth');
    } finally { await api.close(); await first.abort(); }
    const second = new SimHost(options()); await second.boot(); const recovered = buildApi({ host: second, pool: pool! });
    try {
      expect((await recovered.inject(`/people/person_0001/events?cursor=${oldCursor!}`)).statusCode).toBe(400);
      const page = (await recovered.inject('/people/person_0001/events')).json<PersonHistoryPage>();
      expect(isPersonHistoryPage(page, 'person_0001')).toBe(true);
      expect(page.events.some(e => e.type === 'human_died')).toBe(true);
      expect(page.events.some(e => e.type === 'human_skill_learned' || e.type === 'human_cooperated')).toBe(true);
    } finally { await recovered.close(); }
  });
});
