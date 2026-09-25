import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { homeCondition } from '@vana/shared';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { testDatabaseUrl } from './testDatabase.js';
import { communityEventText, communityHomeText, isCommunityPage, type CommunityPage } from '../../client/src/communityObserver.js';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialAgents: {}, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 1000 });
afterAll(async () => { await pool?.end(); });
maybe('durable autonomous home maintenance observation', () => {
  beforeEach(async () => { await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade'); });

  it('resumes natural repair work from PostgreSQL and publishes material/condition facts only when committed', async () => {
    const first = new SimHost(options()); await first.boot();
    for (let h = 0; h < 120 && !first.world.community!.people.some(p => p.task?.kind === 'repair'); h++) await first.advance(1);
    expect(first.world.community!.people.some(p => p.task?.kind === 'repair')).toBe(true);
    await first.snapshotNow(); const saved = structuredClone(first.world.community!); await first.abort();
    const second = new SimHost(options()); await second.boot(); expect(second.world.community).toEqual(saved);
    const api = buildApi({ host: second, pool: pool! });
    try {
      await second.advance(6);
      expect(second.world.community!.building.maintenance!.repairsCompleted).toBeGreaterThan(saved.building.maintenance!.repairsCompleted);
      const uncommitted = (await api.inject('/community')).json<CommunityPage>();
      expect(uncommitted.community).toEqual(saved); expect(uncommitted.asOfWorldTime).toBe(saved.updatedAt);
      await second.snapshotNow();
      const committed = (await api.inject('/community')).json<CommunityPage>();
      expect(isCommunityPage(committed)).toBe(true); expect(committed.community).toEqual(second.world.community);
      expect(communityHomeText(committed.community!)).toContain('Repairs completed:');
      const repaired = committed.events.find(e => e.type === 'building_repaired')!;
      expect(repaired).toBeDefined(); expect(communityEventText(repaired)).toContain('repaired home');
      expect(repaired.effects!.timberKg! + repaired.effects!.fibreKg!).toBeGreaterThan(0);
      expect(repaired.effects!.conditionAfter).toBeGreaterThan(repaired.effects!.conditionBefore!);
      expect(homeCondition(committed.community!)).toBeGreaterThan(.9);
      const beforeRead = structuredClone(second.world.community);
      expect((await api.inject({ method: 'POST', url: '/community', payload: { repair: true } })).statusCode).toBe(404);
      expect(second.world.community).toEqual(beforeRead);
      const final = structuredClone(second.world.community); await second.abort();
      const third = new SimHost(options()); await third.boot(); expect(third.world.community).toEqual(final);
      const counts = await pool!.query("select count(*)::int as n, count(distinct id)::int as unique_n from events where type = 'building_repaired'");
      expect(counts.rows[0]).toEqual({ n: final!.building.maintenance!.repairsCompleted, unique_n: final!.building.maintenance!.repairsCompleted });
    } finally { await api.close(); }
  });
});
