import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { NUTRIENT_PER_KG_BIOMASS, isCommunityState } from '@vana/shared';
import { createWorld, takeSnapshot } from '@vana/sim';
import { weatherHome } from '../../sim/src/communityMaintenance.js';
import { waterRetentionL } from '../../sim/src/fields/water.js';
import { communityEventText, isCommunityPage } from '../../client/src/communityObserver.js';
import { buildApi } from '../src/api.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { SimHost } from './trackedHost.js';
import { testDatabaseUrl } from './testDatabase.js';
import { ISLAND_GRID } from '@vana/shared';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null, maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 1,
  speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialCommunityRulesVersion: 8 as const, initialAgents: {}, minPopulation: {}, landscape: null });
afterAll(async () => { await pool?.end(); });

maybe('checkpointed v8 home disaster observation', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade');
  });

  it('serves actual flood, collapse and shelter-loss records only from the committed checkpoint', async () => {
    const seed = createWorld(options()), home = seed.community!, patch = seed.patches[home.patchId]!;
    const timber = 96 * .45, fibre = 72 * .45;
    patch.soilNutrients -= (timber + fibre) * NUTRIENT_PER_KG_BIOMASS;
    home.building.stage = 'occupied'; home.building.completedAt = 0;
    home.building.materials = { timberKg: timber, fibreKg: fibre };
    home.building.occupantIds = home.people.map(person => person.id);
    const waterAdded = Math.max(0, waterRetentionL(patch) + 6_000 - patch.waterVolume);
    patch.waterVolume += waterAdded; seed.waterBudget.rainfallL += waterAdded;
    const baseline = seed.totalNutrients();
    weatherHome(home, patch, 60, 0, seed.log, seed.waterBudget);
    expect(home.building.stage).toBe('site');
    expect(isCommunityState(home)).toBe(true);
    expect(seed.totalNutrients()).toBeCloseTo(baseline, 7);
    const generated = seed.log.take();
    const flood = generated.find(event => event.type === 'building_flooded')!;
    const collapse = generated.find(event => event.type === 'building_collapsed')!;
    const shelter = generated.find(event => event.type === 'building_shelter_changed')!;
    expect(collapse.causalParents).toContain(flood.id);
    expect(shelter.causalParents).toContain(collapse.id);
    await new EventStore(pool!, ISLAND_GRID).appendBatch(generated);
    await new SnapshotStore(pool!).save(takeSnapshot(seed));

    const host = new SimHost(options()); await host.boot();
    const api = buildApi({ host, pool: pool! });
    try {
      const response = (await api.inject('/community')).json();
      expect(isCommunityPage(response)).toBe(true);
      expect(response.community.building).toMatchObject({ stage: 'site', materials: { timberKg: 0, fibreKg: 0 } });
      for (const type of ['building_flooded', 'building_collapsed', 'building_shelter_changed']) {
        expect(response.events.some((event: { type: string }) => event.type === type)).toBe(true);
      }
      expect(communityEventText(response.events.find((event: { id: string }) => event.id === collapse.id))).toContain('home collapsed after flood');
    } finally { await api.close(); await host.abort(); }
  });
});
