import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { Gateway } from '../src/gateway.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { testDatabaseUrl } from './testDatabase.js';
import { SceneUpdates } from '../../client/src/sceneUpdates.js';
import { communityEventText, communityRelationshipText, isCommunityPage, type CommunityPage } from '../../client/src/communityObserver.js';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialCommunityRulesVersion: 3 as const,
  initialAgents: {}, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 12 });
afterAll(async () => { await pool?.end(); });
maybe('shared work from simulation through durable public observation', () => {
  beforeEach(async () => { await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade'); });

  it('publishes lessons and pair histories only at a saved checkpoint through API, person records and scene frames', async () => {
    const host = new SimHost(options()); await host.boot();
    const api = buildApi({ host, pool: pool! });
    try {
      await host.advance(6);
      const beforeSave = (await api.inject('/community')).json<CommunityPage>();
      expect(beforeSave.asOfWorldTime).toBe(0); expect(beforeSave.community!.relationships).toEqual([]);
      expect(beforeSave.events.map(e => e.type)).toEqual(['community_founded']);
      expect(host.world.community!.relationships!.length).toBeGreaterThan(0);
      await host.snapshotNow();
      const response = await api.inject('/community'), page = response.json<CommunityPage>();
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(isCommunityPage(page)).toBe(true); expect(page.asOfWorldTime).toBe(21600);
      expect(page.community).toEqual(host.world.community);
      expect(communityRelationshipText(page.community!)[0]).toContain('cooperation score');
      const learned = page.events.find(e => e.type === 'human_skill_learned')!;
      expect(learned).toBeDefined(); expect(communityEventText(learned)).toContain('percentage points');
      expect(page.events.some(e => e.type === 'human_cooperated')).toBe(true);
      const person = (await api.inject(`/people/${learned.actors[0]}`)).json();
      expect(person.asOfWorldTime).toBe(page.asOfWorldTime);
      expect(person.relationships).toEqual(page.community!.relationships!.filter(r => r.members.includes(learned.actors[0]!)));
      expect(person.events.some((e: { id: string }) => e.id === learned.id)).toBe(true);
      const frames: string[] = [], gateway = new Gateway(host), beforeRead = structuredClone(host.world.community);
      try {
        gateway.handle({ send: data => frames.push(data), close() {} });
        let visible: unknown;
        const updates = new SceneUpdates({ prepare: async () => null, discard() {}, status() {}, commit(update) { visible = update.environment.community; } });
        expect(updates.receive(JSON.parse(frames[0]!), 0)).toBe(true); await Promise.resolve(); await Promise.resolve();
        expect(visible).toEqual(page.community);
        expect((await api.inject({ method: 'POST', url: '/community', payload: { train: true } })).statusCode).toBe(404);
        expect(host.world.community).toEqual(beforeRead); expect(host.world.now()).toBe(21600);
      } finally { gateway.close(); }
    } finally { await api.close(); }
  });

  it('restores shared-work time, actual skill gains and milestone cursors without replaying them', async () => {
    const first = new SimHost(options()); await first.boot(); await first.advance(6); await first.snapshotNow();
    const saved = structuredClone(first.world.community);
    const previous = await pool!.query("select id, actors, effects from events where type in ('human_cooperated', 'human_skill_learned') order by event_sequence");
    expect(previous.rows.length).toBeGreaterThan(0); await first.abort();
    const second = new SimHost(options()); await second.boot(); expect(second.world.community).toEqual(saved);
    expect(second.world.log.all()).toEqual([]);
    await second.advance(24); await second.snapshotNow();
    const rows = await pool!.query("select id, actors, effects from events where type in ('human_cooperated', 'human_skill_learned') order by event_sequence");
    expect(rows.rows.slice(0, previous.rows.length)).toEqual(previous.rows);
    expect(rows.rows.length).toBeGreaterThan(previous.rows.length);
    expect(new Set(rows.rows.map(r => r.id)).size).toBe(rows.rows.length);
    const hours = rows.rows.filter(r => r.effects.sharedWorkSeconds !== undefined)
      .map(r => `${r.actors.slice(0, 2).join(':')}:${Math.floor(r.effects.sharedWorkSeconds / 3600)}`);
    expect(new Set(hours).size).toBe(hours.length);
    const completed = structuredClone(second.world.community); await second.abort();
    const third = new SimHost(options()); await third.boot(); expect(third.world.community).toEqual(completed);
    expect(third.world.community!.building.stage).toBe('occupied');
  });
});
