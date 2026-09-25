import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { isCommunityState } from '@vana/shared';
import { waterBudgetResidual } from '../src/fields/drainage.js';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const options = { seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialCommunityRulesVersion: 8 as const, initialAgents: {}, minPopulation: {} };

describe('v8 local storm, flood, collapse and paid rebuild', () => {
  it('arises without observer input, conserves biomass and water, and resumes exactly across a collapsed checkpoint', () => {
    const a = createWorld(options), nutrients = a.totalNutrients();
    a.step(10 * 24 + 1);
    const c = a.community!;
    expect(isCommunityState(c)).toBe(true);
    expect(c.building.stage).toBe('site');
    expect(c.building.maintenance).toMatchObject({ collapses: 1, rebuildsCompleted: 0 });
    expect(c.building.occupantIds).toEqual([]);
    const events = a.log.all();
    const storm = events.find(e => e.type === 'building_storm')!;
    const flood = events.find(e => e.type === 'building_flooded')!;
    const collapse = events.find(e => e.type === 'building_collapsed')!;
    expect(storm.effects.timberLostKg).toBeGreaterThan(0);
    expect(storm.conditions.rainfallL).toBeGreaterThan(0);
    expect(flood.conditions.excessSurfaceWaterL).toBeGreaterThan(1200);
    expect(collapse.causalParents).toEqual([flood.id]);
    expect(events.some(e => e.type === 'building_shelter_changed' && e.conditions.reason === 'collapse'
      && e.conditions.availability === 'uninhabitable' && e.causalParents[0] === collapse.id)).toBe(true);
    expect(c.building.maintenance!.lastCollapseEventId).toBe(collapse.id);
    expect(c.building.maintenance!.lastCollapseAt).toBe(collapse.worldTime);
    expect(a.waterBudget.rainfallL).toBeGreaterThan(storm.conditions.rainfallL as number);
    expect(a.totalNutrients()).toBeCloseTo(nutrients, 7);
    expect(waterBudgetResidual(a.patches, a.waterBudget)).toBeCloseTo(0, 5);

    const b = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(a))), options);
    a.log.take();
    a.step(22 * 24 - 10 * 24 - 1); b.step(22 * 24 - 10 * 24 - 1);
    expect(takeSnapshot(b)).toEqual(takeSnapshot(a));
    expect(b.log.all()).toEqual(a.log.all());
    expect(isCommunityState(b.community)).toBe(true);
    expect(b.community!.building.stage).toBe('occupied');
    expect(b.community!.building.maintenance).toMatchObject({ collapses: 1, rebuildsCompleted: 1 });
    const rebuilt = b.log.all().find(e => e.type === 'building_rebuilt')!;
    expect(rebuilt.causalParents[0]).toBe(collapse.id);
    expect(rebuilt.causalParents[1]).toMatch(/^building_stage_/);
    expect(b.log.all().some(e => e.type === 'building_shelter_changed'
      && e.conditions.reason === 'rebuilt' && e.conditions.availability === 'habitable')).toBe(true);
    expect(b.totalNutrients()).toBeCloseTo(nutrients, 7);
    expect(waterBudgetResidual(b.patches, b.waterBudget)).toBeCloseTo(0, 5);
  });

  it('keeps saved v7 household weather and building contracts pinned', () => {
    const legacy = createWorld({ ...options, initialCommunityRulesVersion: 7 });
    legacy.step(11 * 24);
    expect(isCommunityState(legacy.community)).toBe(true);
    expect(legacy.community!.building.maintenance).toEqual({ repairsCompleted: expect.any(Number), lastRepairAt: expect.any(Number) });
    expect(legacy.log.all().some(e => ['building_storm', 'building_flooded', 'building_collapsed', 'building_rebuilt'].includes(e.type))).toBe(false);
  });

  it('rejects forged collapse and rebuild bookkeeping at a checkpoint boundary', () => {
    const w = createWorld(options); w.step(10 * 24 + 1);
    const intact = w.community!; expect(isCommunityState(intact)).toBe(true);
    for (const edit of [
      (c: typeof intact) => { c.building.maintenance!.collapses = 0; },
      (c: typeof intact) => { c.building.maintenance!.rebuildsCompleted = 1; },
      (c: typeof intact) => { c.building.maintenance!.lastCollapseAt = c.updatedAt + 1; },
      (c: typeof intact) => { c.building.maintenance!.lastCollapseEventId = null; },
      (c: typeof intact) => { c.building.stage = 'occupied'; c.building.completedAt = c.updatedAt; },
    ]) {
      const forged = structuredClone(intact); edit(forged);
      expect(isCommunityState(forged)).toBe(false);
    }
  });
});
