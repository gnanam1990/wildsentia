import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { HistoryCursors, historyLimit } from '../src/historyCursor.js';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { Hud, type HudElements } from '../../client/src/hud.js';
import { WorldStore } from '../../client/src/protocol.js';
import { HistoryPager } from '../../client/src/history.js';
import { loadLifeHistory } from '../../client/src/lifeHistory.js';

describe('history cursor integrity', () => {
  it('binds the actor, route, checkpoint and API lifetime without accepting tampered bounds', () => {
    const cursors = new HistoryCursors(), boundary = { worldTime: 10, nextSequence: 20 };
    const value = { version: 1 as const, scope: 'events:a', boundary, since: -1, sinceSequence: null, after: { worldTime: 5, id: 'event' } };
    const encoded = cursors.encode(value);
    expect(cursors.decode(encoded, value.scope, boundary)).toEqual(value);
    expect(cursors.decode(encoded, 'events:b', boundary)).toBeNull();
    expect(cursors.decode(encoded, 'recap:a', boundary)).toBeNull();
    expect(cursors.decode(encoded, value.scope, { worldTime: 9, nextSequence: 20 })).toBeNull();
    expect(cursors.decode(encoded, value.scope, { worldTime: 10, nextSequence: 19 })).toBeNull();
    expect(new HistoryCursors().decode(encoded, value.scope, boundary)).toBeNull();
    for (const bad of ['', encoded + 'x', 'x'.repeat(4097), encoded.replace(/^./, 'Z')]) expect(cursors.decode(bad, value.scope, boundary)).toBeNull();
    for (const bad of ['0', '-1', '501', '1.5', '1e3', 'NaN', 'Infinity']) expect(historyLimit(bad, 50)).toBeNull();
  });
});
const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
afterAll(async () => { await pool?.end(); });
afterEach(() => vi.unstubAllGlobals());
maybe('checkpoint-pinned history pagination', () => {
  beforeEach(async () => { await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade'); });
  const start = async () => {
    const host = new SimHost({ pool: pool!, seed: 44, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
      initialAgents: { sambar: 2 }, minPopulation: {}, landscape: null });
    await host.boot();
    const id = host.world.agents[0]!.id;
    const append = (stage: string) => host.world.log.append({ type: 'life_stage', worldTime: host.world.now(), simVersion: '',
      patchId: 0, actors: [id], conditions: { stage }, outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative' });
    return { host, id, append };
  };
  it('publishes saved illness milestones in the affected animal biography, not another animal\'s', async () => {
    const { host, id } = await start();
    const other = host.world.agents[1]!.id;
    const meal = host.world.log.append({ type: 'scavenged', worldTime: host.world.now(), simVersion: '',
      patchId: 0, actors: [id], conditions: { carcassId: 'carcass_fixture' }, outcome: 'success',
      effects: { kg: 1 }, causalParents: [], confidence: 'authoritative' });
    const contracted = host.world.log.append({ type: 'disease_contracted', worldTime: host.world.now(), simVersion: '',
      patchId: 0, actors: [id], conditions: { kind: 'carrion_infection', sourceMealEventId: meal.id },
      outcome: 'success', effects: { severity: 0.4 }, causalParents: [meal.id], confidence: 'authoritative' });
    const symptomatic = host.world.log.append({ type: 'disease_symptomatic', worldTime: host.world.now(), simVersion: '',
      patchId: 0, actors: [id], conditions: { kind: 'carrion_infection', sourceMealEventId: meal.id },
      outcome: 'success', effects: { severity: 0.4 }, causalParents: [contracted.id], confidence: 'authoritative' });
    await host.snapshotNow();
    const api = buildApi({ host, pool: pool! });
    try {
      const own = (await api.inject(`/animals/${id}/life`)).json();
      const illness = own.moments.filter((m: { eventId: string }) =>
        [contracted.id, symptomatic.id].includes(m.eventId));
      expect(illness.map((m: { eventId: string }) => m.eventId)).toEqual([contracted.id, symptomatic.id]);
      expect(illness.map((m: { text: string }) => m.text)).toEqual([
        'Contracted a modelled illness after eating carrion', 'Showed signs of illness',
      ]);
      const bystander = (await api.inject(`/animals/${other}/life`)).json();
      expect(bystander.moments.some((m: { eventId: string }) => [contracted.id, symptomatic.id].includes(m.eventId)))
        .toBe(false);
    } finally { await api.close(); }
  });
  it('traverses more than the former 2000-event recap limit exactly once across equal-time checkpoints', async () => {
    const { host, id, append } = await start(), before = host.observation()!;
    const expected = Array.from({ length: 2005 }, (_, n) => append(`stage${n}`)).map(e => e.id);
    await host.snapshotNow(); const boundary = host.observation()!;
    const api = buildApi({ host, pool: pool! });
    try {
      let path = `/animals/${id}/recap?since=0&sinceSequence=${before.nextSequence}`, count = 0;
      const seen: string[] = [];
      do {
        const res = await api.inject(path); expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        const body = res.json(); expect(body.until).toBe(boundary.worldTime); expect(body.nextEventSequence).toBe(boundary.nextSequence);
        seen.push(...body.lines.map((l: { eventId: string }) => l.eventId)); count++;
        if (count === 1) { append('published-between-pages'); await host.snapshotNow(); }
        path = body.nextCursor ? `/animals/${id}/recap?cursor=${encodeURIComponent(body.nextCursor)}` : '';
      } while (path);
      expect(count).toBe(11); expect(seen).toEqual(expected); expect(new Set(seen).size).toBe(2005);
      vi.stubGlobal('fetch', async (url: string) => {
        const res = await api.inject(url.replace('/api/', '/')); return new Response(res.body, { status: res.statusCode });
      });
      const elements = Object.fromEntries(['clock', 'season', 'population', 'passport', 'feed', 'notice']
        .map(name => [name, { innerHTML: '', textContent: '' }])) as unknown as HudElements;
      const hud = new Hud(elements, new WorldStore());
      const completed = await hud.loadRecap(id, 0, 0, before.nextSequence);
      expect(completed).toEqual({ worldTime: 0, nextSequence: host.checkpointEventSequence });
      expect(hud.recap!.totalLines).toBe(2006); expect(hud.recap!.lines).toHaveLength(12);
      expect(hud.recap!.lines.at(-1)!.text).toContain('published-between-pages');
    } finally { await api.close(); }
  });
  it('pages newest-first with stable backward navigation, actor isolation, and no volatile events', async () => {
    const { host, id, append } = await start();
    const expected = Array.from({ length: 61 }, (_, n) => append(`stage${n}`)).map(e => e.id).reverse();
    await host.snapshotNow(); const api = buildApi({ host, pool: pool! });
    try {
      const first = (await api.inject(`/animals/${id}/events?limit=25`)).json();
      expect(first.events.map((e: { id: string }) => e.id)).toEqual(expected.slice(0, 25));
      const volatile = append('volatile'); await host.flush();
      const next = (await api.inject(`/animals/${id}/events?limit=25&cursor=${first.nextCursor}`)).json();
      expect(next.events.map((e: { id: string }) => e.id)).toEqual(expected.slice(25, 50));
      await host.snapshotNow();
      const repeat = (await api.inject(`/animals/${id}/events?limit=25&cursor=${first.pageCursor}`)).json();
      expect(repeat.events).toEqual(first.events); expect(repeat.nextEventSequence).toBe(first.nextEventSequence);
      expect((await api.inject(`/animals/${id}/events?limit=25`)).json().events[0].id).toBe(volatile.id);
      for (const route of ['/events', `/animals/${host.world.agents[1]!.id}/events`, `/animals/${id}/recap`])
        expect((await api.inject(`${route}?cursor=${first.nextCursor}`)).statusCode).toBe(400);
      for (const limit of ['-1', '1.5', '10000000', 'Infinity', '0'])
        expect((await api.inject(`/animals/${id}/events?limit=${limit}`)).statusCode).toBe(400);
      vi.stubGlobal('fetch', async (url: string) => { const r = await api.inject(url.replace('/api/', '/')); return new Response(r.body, { status: r.statusCode }); });
      const pager = new HistoryPager(); await pager.open(id); const pageOne = pager.page;
      append('later'); await host.snapshotNow();
      await pager.next(); expect(pager.pageNumber).toBe(2);
      await pager.previous(); expect(pager.page?.events).toEqual(pageOne?.events);
      const restarted = buildApi({ host, pool: pool! });
      try { expect((await restarted.inject(`/animals/${id}/events?cursor=${first.nextCursor}`)).statusCode).toBe(400); }
      finally { await restarted.close(); }
    } finally { await api.close(); }
  });
  it('retains deterministic traversal for legacy null-sequence IDs', async () => {
    const { host, id } = await start(); await host.advance(1);
    const store = new EventStore(pool!);
    const fixture = { worldTime: 1, simVersion: 'test', patchId: 0, actors: [id], conditions: {}, outcome: 'success' as const,
      effects: {}, causalParents: [], confidence: 'authoritative' as const };
    await store.appendBatch(['legacy_Z', 'legacy_a', 'legacy_B'].map(id => ({ ...fixture, id, type: 'born' as const })));
    const first = await store.page({ actorId: id, boundary: host.observation()!, limit: 2, since: 0, types: ['born'] });
    const second = await store.page({ actorId: id, boundary: host.observation()!, limit: 2, since: 0, types: ['born'], after: first.after! });
    expect([...first.events, ...second.events].map(e => e.id)).toEqual(['legacy_B', 'legacy_Z', 'legacy_a']);
    expect(second.after).toBeNull();
  });
  it('loads beyond 5000 life moments without mixing biographies, and preserves a selected older paired recording', async () => {
    const { host, id, append } = await start();
    const stages = Array.from({ length: 5005 }, (_, n) => append(`stage${n}`));
    const hunts = Array.from({ length: 52 }, () => host.world.log.append({ type: 'hunt', worldTime: 0, simVersion: '',
      patchId: 0, actors: ['tiger_fixture', id], conditions: { predatorSpecies: 'tiger', preySpecies: 'sambar', stage: 'escaped' },
      effects: {}, outcome: 'failure', causalParents: [], confidence: 'authoritative', encounter: {
        version: 1, predatorId: 'tiger_fixture', preyId: id, startWorldTime: 0, patchId: 0, contactRadiusM: 1,
        samples: [{ seconds: 0, phase: 'escape', predator: { x: 0, z: 0, heading: 0 }, prey: { x: 10, z: 0, heading: 0 } }],
      } }));
    await host.snapshotNow(); const saved = host.observation()!, api = buildApi({ host, pool: pool! });
    try {
      let calls = 0;
      vi.stubGlobal('fetch', async (url: string) => {
        const res = await api.inject(url.replace('/api/', '/'));
        expect(res.statusCode).toBe(200); const body = res.json();
        expect(body.asOfWorldTime).toBe(saved.worldTime); expect(body.nextEventSequence).toBe(saved.nextSequence);
        if (++calls === 1) {
          expect(body.alive).toBe(true);
          append('later-checkpoint'); host.world.agents[0]!.alive = false; await host.snapshotNow();
        } else { expect(body).not.toHaveProperty('alive'); expect(body).not.toHaveProperty('track'); }
        return new Response(res.body, { status: res.statusCode });
      });
      const loaded = await loadLifeHistory(id, { signal: new AbortController().signal, selectedEventId: hunts[0]!.id });
      expect(calls).toBe(Math.ceil(5057 / 32)); expect(loaded.alive).toBe(true);
      expect(loaded.moments.filter(m => m.text.includes('stage')).map(m => m.eventId)).toEqual(stages.map(e => e.id));
      expect(loaded.moments.some(m => m.text.includes('later-checkpoint'))).toBe(false);
      expect(loaded.encounters).toHaveLength(51);
      expect(loaded.encounters![0]).toMatchObject({ eventId: hunts[0]!.id, trace: hunts[0]!.encounter });
      const firstPage = (await api.inject(`/animals/${id}/life`)).json();
      expect((await api.inject(`/animals/${id}/events?cursor=${firstPage.nextCursor}`)).statusCode).toBe(400);
      const other = host.world.agents[1]!.id;
      expect((await api.inject(`/animals/${other}/life?cursor=${firstPage.nextCursor}`)).statusCode).toBe(400);
      const restarted = buildApi({ host, pool: pool! });
      try { expect((await restarted.inject(`/animals/${id}/life?cursor=${firstPage.nextCursor}`)).statusCode).toBe(400); }
      finally { await restarted.close(); }
    } finally { await api.close(); }
  });
});
