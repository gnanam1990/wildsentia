import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { Gateway } from '../src/gateway.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { testDatabaseUrl } from './testDatabase.js';
import { SceneUpdates } from '../../client/src/sceneUpdates.js';
import { communityEventText, isCommunityPage } from '../../client/src/communityObserver.js';
import { SIM_VERSION, takeSnapshot } from '@vana/sim';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { EventStore } from '../src/db/eventStore.js';
import { asLegacySnapshot } from '../../sim/test/legacySnapshot.js';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialCommunityRulesVersion: 2 as const,
  initialAgents: {}, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 12 });
afterAll(async () => { await pool?.end(); });
maybe('durable community observer path', () => {
  beforeEach(async () => { await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade'); });
  it('refuses silent v0.16 changes and records an explicit stored-water upgrade only once', async () => {
    const first = new SimHost(options()); await first.boot(); await first.advance(1); await first.snapshotNow();
    const saved = asLegacySnapshot(takeSnapshot(first.world), 'sim_0.16.0'); await first.abort();
    await new SnapshotStore(pool!).save(saved);
    await expect(new SimHost(options()).boot()).rejects.toThrow(/refusing to boot/);
    const second = new SimHost({ ...options(), allowV16Upgrade: true }); await second.boot();
    expect(second.world.community).toEqual(saved.community);
    expect((await new SnapshotStore(pool!).loadLatest())!.simVersion).toBe(SIM_VERSION);
    const events = await new EventStore(pool!, ISLAND_GRID).recent(100);
    expect(events.filter(e => e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
    await second.abort(); const third = new SimHost(options()); await third.boot();
    expect(third.world.community).toEqual(saved.community);
    expect((await new EventStore(pool!, ISLAND_GRID).recent(100)).filter(e => e.conditions.reason === 'explicit_rules_upgrade')).toHaveLength(1);
  });
  it('pins household and event history to one saved checkpoint, serves no mutation route, and validates real scene data', async () => {
    const host = new SimHost(options()); await host.boot(); const view = host.observation()!, initial = view.community();
    const api = buildApi({ host, pool: pool! });
    try {
      await host.advance(1);
      const response = await api.inject('/community'); expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store'); expect(isCommunityPage(response.json())).toBe(true);
      expect(response.json().community).toEqual(initial); expect(response.json().asOfWorldTime).toBe(0);
      expect(response.json().events).toHaveLength(1); expect(response.json().events[0].type).toBe('community_founded');
      expect(host.world.community).not.toEqual(initial);
      const changed = view.community()!; changed.stores.foodKg = 9999;
      expect(view.community()).toEqual(initial);
      expect((await api.inject({ method: 'POST', url: '/community', payload: { build: true } })).statusCode).toBe(404);
      await host.snapshotNow();
      const committed = (await api.inject('/community')).json(); expect(committed.asOfWorldTime).toBe(3600);
      expect(isCommunityPage(committed)).toBe(true); expect(committed.community).toEqual(host.world.community);
      expect(view.community()).toEqual(initial);
      const person = (await api.inject('/people/person_0001')).json();
      expect(person.person).toEqual(host.world.community!.people[0]); expect(person.events.length).toBeGreaterThan(0);
      expect(person.events.every((e: { worldTime: number }) => e.worldTime <= 3600)).toBe(true);
      expect((await api.inject('/people/missing')).statusCode).toBe(404);
      const frames: string[] = [], gateway = new Gateway(host), before = host.world.now();
      gateway.handle({ send: data => frames.push(data), close() {} });
      const frame = JSON.parse(frames[0]!); expect(frame.environment.community).toEqual(committed.community);
      let visible: unknown;
      const updates = new SceneUpdates({ prepare: async () => null, discard() {}, status() {}, commit(update) { visible = update.environment.community; } });
      expect(updates.receive(frame, 0)).toBe(true); await Promise.resolve(); await Promise.resolve();
      expect(visible).toEqual(committed.community); expect(host.world.now()).toBe(before);
      gateway.close();
      host.lastError = 'private detail';
      for (const route of ['/community', '/people/person_0001']) {
        const failure = await api.inject(route); expect(failure.statusCode).toBe(503); expect(failure.body).not.toContain('private');
      }
      host.lastError = null;
    } finally { await api.close(); }
  });
  it('recovers in-progress tasks and completed construction from PostgreSQL without founding again or duplicating deliveries', async () => {
    const first = new SimHost(options()); await first.boot(); await first.advance(1); await first.snapshotNow();
    const saved = structuredClone(first.world.community); await first.abort();
    const second = new SimHost(options()); const boot = await second.boot();
    expect(boot.restoredFrom).toBe(3600); expect(second.world.community).toEqual(saved);
    await second.advance(24); await second.snapshotNow();
    expect(second.world.community!.building.stage).toBe('occupied');
    const completed = structuredClone(second.world.community); await second.abort();
    const third = new SimHost(options()); await third.boot(); expect(third.world.community).toEqual(completed);
    const rows = await pool!.query("select type, count(*)::int as n from events where type in ('community_founded', 'building_stage') group by type");
    expect(rows.rows).toEqual(expect.arrayContaining([{ type: 'community_founded', n: 1 }, { type: 'building_stage', n: 4 }]));
    expect(third.world.log.all()).toEqual([]);
  });
  it('does not enable settlements in a legacy world or allow a restart to inject one', async () => {
    const first = new SimHost({ ...options(), communityProfile: 'none' }); await first.boot();
    const api = buildApi({ host: first, pool: pool! });
    try { expect((await api.inject('/community')).json()).toMatchObject({ community: null, events: [] }); }
    finally { await api.close(); await first.abort(); }
    const second = new SimHost(options()); await expect(second.boot()).rejects.toThrow(/community profile mismatch/);
  });
  it('persists raw catch and resumes cooking across restart, exposing committed mass transfers through the real observer contract', async () => {
    const first = new SimHost(options()); await first.boot();
    // Natural seed-1 stock growth; no fish, food or fuel injected by this test.
    const rawStock = () => first.world.community!.stores.rawFishKg!
      + first.world.community!.people.reduce((n, p) => n + p.inventory.rawFishKg!, 0);
    // Wait for the actual persisted state, not an old rules version's particular hour.
    // sim_0.30.0's first seed-1 catch is at hour 304 (the access point moved, so the rolls did).
    for (let hour = 0; hour < 480 && rawStock() <= 0; hour++) await first.advance(1);
    await first.snapshotNow();
    const saved = structuredClone(first.world.community!);
    expect(saved.version).toBe(2);
    expect(saved.stores.rawFishKg! + saved.people.reduce((n, p) => n + p.inventory.rawFishKg!, 0)).toBeGreaterThan(0);
    await first.abort();
    const second = new SimHost(options()); await second.boot(); expect(second.world.community).toEqual(saved);
    const events = new EventStore(pool!, ISLAND_GRID);
    for (let hour = 0; hour < 48; hour++) {
      await second.advance(1);
      const cooked = (await events.recent(100)).some(e => e.worldTime > saved.updatedAt
        && e.type === 'human_task_finished' && e.outcome === 'success' && e.conditions.action === 'cook');
      if (cooked) break;
    }
    await second.snapshotNow();
    const api = buildApi({ host: second, pool: pool! });
    try {
      const response = (await api.inject('/community')).json(); expect(isCommunityPage(response)).toBe(true);
      const cooked = response.events.find((e: { type: string; outcome: string; conditions: { action: string } }) =>
        e.type === 'human_task_finished' && e.outcome === 'success' && e.conditions.action === 'cook');
      expect(cooked).toBeDefined(); expect(communityEventText(cooked)).toContain('fuelKg:');
      const person = (await api.inject(`/people/${cooked.actors[0]}`)).json();
      expect(person.events.some((e: { id: string }) => e.id === cooked.id)).toBe(true);
      const rows = await pool!.query("select id, effects, causal_parents from events where type = 'human_task_finished' and conditions->>'action' = 'fish' and outcome = 'success'");
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(new Set(rows.rows.map(r => r.causal_parents[0])).size).toBe(rows.rows.length);
      for (const row of rows.rows) expect(row.effects.rawFishKg).toBeCloseTo(-row.effects.fishBiomassKg, 10);
      expect(response.community).toEqual(second.world.community);
    } finally { await api.close(); }
  });
});
