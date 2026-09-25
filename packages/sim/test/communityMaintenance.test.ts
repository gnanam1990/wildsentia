import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { homeCondition, isCommunityState, NUTRIENT_PER_KG_BIOMASS } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { stepCommunity } from '../src/community.js';
import { weatherHome, repairHome, sleepRecoveryFactor } from '../src/communityMaintenance.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const options = { seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialCommunityRulesVersion: 4 as const, initialAgents: {}, minPopulation: {} };
function completedHome() {
  const w = createWorld(options); w.step(24);
  const c = w.community!, patch = w.patches[c.patchId]!;
  expect(c.building.stage).toBe('occupied');
  return { w, c, patch };
}
function damage(f: ReturnType<typeof completedHome>, fraction: number) {
  for (const key of ['timberKg', 'fibreKg'] as const) {
    const lost = f.c.building.materials[key] * (1 - fraction);
    f.c.building.materials[key] -= lost; f.patch.soilNutrients += lost * NUTRIENT_PER_KG_BIOMASS;
  }
}

describe('finite-material home weathering, shelter and autonomous repair', () => {
  it('returns actual retained material to soil, reacts to local dampness, and preserves total nutrients', () => {
    const dry = completedHome(), wet = completedHome();
    dry.patch.soilMoisture = 0; wet.patch.soilMoisture = 1;
    const baseline = dry.w.totalNutrients(), before = { ...dry.c.building.materials };
    weatherHome(dry.c, dry.patch, 86400, dry.w.now(), dry.w.log);
    weatherHome(wet.c, wet.patch, 86400, wet.w.now(), wet.w.log);
    expect(dry.c.building.materials.timberKg).toBeCloseTo(before.timberKg * Math.exp(-1 / 100), 10);
    expect(dry.c.building.materials.fibreKg).toBeCloseTo(before.fibreKg * Math.exp(-1 / 45), 10);
    expect(homeCondition(wet.c)).toBeLessThan(homeCondition(dry.c));
    expect(dry.w.totalNutrients()).toBeCloseTo(baseline, 7);
    expect(isCommunityState(dry.c)).toBe(true);
  });

  it('pays travel and work before repair and transfers delivered material once, with causal proof', () => {
    const f = completedHome(), { w, c, patch } = f, p = c.people[0]!;
    damage(f, .8); c.stores.foodKg = 20; c.stores.waterL = 20; c.stores.timberKg = 20; c.stores.fibreKg = 20;
    p.task = null; p.position = { ...c.building.position, x: c.building.position.x + 20 };
    p.needs = { hunger: .1, thirst: .1, fatigue: .1 }; p.inventory = { foodKg: 0, waterL: 0, timberKg: 0, fibreKg: 0, rawFishKg: 0 };
    // Other workers remain occupied by independent rest tasks throughout this fixture.
    for (const other of c.people.slice(1)) {
      other.task = { kind: 'rest', phase: 'work', destination: { ...other.position }, remainingSeconds: 3600, startedAt: w.now(), eventId: `rest_${other.id}` };
      other.needs = { hunger: .1, thirst: .1, fatigue: .1 };
    }
    const baseline = w.totalNutrients(), start = w.now();
    stepCommunity(c, w.patches, w.waterBudget, start, 1, w.log);
    expect(p.task).toMatchObject({ kind: 'repair', phase: 'travel' });
    expect(c.building.maintenance!.repairsCompleted).toBe(0);
    stepCommunity(c, w.patches, w.waterBudget, start + 1, 1800, w.log);
    expect(c.building.maintenance!.repairsCompleted).toBe(0); // travel was not free
    const taskId = p.task!.eventId, timber = c.stores.timberKg, fibre = c.stores.fibreKg;
    stepCommunity(c, w.patches, w.waterBudget, start + 1801, 60, w.log);
    expect(c.building.maintenance!.repairsCompleted).toBe(1);
    const repaired = w.log.all().find(e => e.type === 'building_repaired')!;
    expect(repaired.causalParents).toEqual([taskId]); expect(repaired.position).toEqual(c.building.position);
    expect(repaired.effects.conditionAfter).toBeGreaterThan(repaired.effects.conditionBefore!);
    expect(c.stores.timberKg).toBeCloseTo(timber - repaired.effects.timberKg!, 10);
    expect(c.stores.fibreKg).toBeCloseTo(fibre - repaired.effects.fibreKg!, 10);
    expect(w.totalNutrients()).toBeCloseTo(baseline, 7); expect(isCommunityState(c)).toBe(true);
  });

  it('rejects unearned/offsite repairs and depleted or already-repaired shared stock', () => {
    const f = completedHome(), { w, c } = f; damage(f, .8);
    const p = c.people[0]!; p.position = { ...c.building.position };
    c.stores.timberKg = 4; c.stores.fibreKg = 6;
    p.task = { kind: 'repair', phase: 'work', destination: { ...p.position }, remainingSeconds: 1, startedAt: w.now(), eventId: 'repair_a' };
    expect(repairHome(c, p, w.now(), w.log)).toEqual({ timberKg: 0, fibreKg: 0 });
    p.task.remainingSeconds = 0; p.position.x += 2;
    expect(repairHome(c, p, w.now(), w.log)).toEqual({ timberKg: 0, fibreKg: 0 });
    p.position = { ...c.building.position };
    const used = repairHome(c, p, w.now(), w.log); expect(used).toEqual({ timberKg: 4, fibreKg: 6 });
    expect(repairHome(c, p, w.now(), w.log)).toEqual({ timberKg: 0, fibreKg: 0 });
    expect(c.building.maintenance!.repairsCompleted).toBe(1);
    c.building.materials = { timberKg: 96, fibreKg: 72 }; c.stores.timberKg = 10; c.stores.fibreKg = 10;
    expect(repairHome(c, p, w.now(), w.log)).toEqual({ timberKg: 0, fibreKg: 0 });
    expect(c.stores.timberKg).toBe(10); expect(c.stores.fibreKg).toBe(10);
  });

  it('loses shelter below its material threshold and regains it only after a paid material repair', () => {
    const f = completedHome(), { w, c, patch } = f, p = c.people[0]!;
    p.position = { ...c.building.position };
    const protectedFactor = sleepRecoveryFactor(c, p);
    weatherHome(c, patch, 50 * 86400, w.now(), w.log);
    expect(homeCondition(c)).toBeLessThan(.4); expect(c.building.occupantIds).toEqual([]);
    expect(sleepRecoveryFactor(c, p)).toBe(.5); expect(protectedFactor).toBeGreaterThan(.9);
    expect(w.log.all().find(e => e.type === 'building_shelter_changed')).toMatchObject({ conditions: { availability: 'uninhabitable', reason: 'weathered' } });
    c.stores.timberKg = 96; c.stores.fibreKg = 72;
    p.task = { kind: 'repair', phase: 'work', destination: { ...p.position }, remainingSeconds: 0, startedAt: w.now(), eventId: 'repair_recovery' };
    for (let i = 0; i < 20 && homeCondition(c) < .4; i++) repairHome(c, p, w.now(), w.log);
    expect(c.building.occupantIds).toEqual(c.people.map(a => a.id)); expect(sleepRecoveryFactor(c, p)).toBeGreaterThan(.5);
    expect(w.log.all().filter(e => e.type === 'building_shelter_changed')).toHaveLength(2);
    p.position.x += 10; expect(sleepRecoveryFactor(c, p)).toBe(.5);
  });

  it('naturally gathers maintenance supplies, repairs repeatedly, conserves mass and resumes mid-repair exactly', () => {
    const a = createWorld(options), baseline = a.totalNutrients();
    for (let h = 0; h < 120 && !a.community!.people.some(p => p.task?.kind === 'repair'); h++) a.step(1);
    expect(a.community!.people.some(p => p.task?.kind === 'repair')).toBe(true);
    const b = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(a))), options); a.log.take();
    for (let h = 0; h < 240; h++) { a.step(1); b.step(1); }
    expect(takeSnapshot(a)).toEqual(takeSnapshot(b)); expect(a.log.all()).toEqual(b.log.all());
    const c = a.community!; expect(c.version).toBe(4); expect(isCommunityState(c)).toBe(true);
    expect(c.building.maintenance!.repairsCompleted).toBeGreaterThan(2);
    expect(c.people.every(p => p.alive)).toBe(true); expect(homeCondition(c)).toBeGreaterThan(.85);
    expect(a.totalNutrients()).toBeCloseTo(baseline, 6);
    expect(a.log.all().filter(e => e.type === 'building_repaired').every(e => e.causalParents.length === 1)).toBe(true);
  });

  it('preserves saved rules v3 without retroactive decay or shelter penalties', () => {
    const a = createWorld({ ...options, initialCommunityRulesVersion: 3 }); a.step(24);
    const b = restoreSnapshot(takeSnapshot(a), options); a.log.take();
    a.step(48); b.step(48);
    expect(takeSnapshot(a)).toEqual(takeSnapshot(b)); expect(a.log.all()).toEqual(b.log.all());
    expect(b.community!.version).toBe(3); expect(b.community!.building.maintenance).toBeUndefined();
    expect(b.community!.building.materials).toEqual({ timberKg: 96, fibreKg: 72 });
    expect(sleepRecoveryFactor(b.community!, b.community!.people[0]!)).toBe(1);
  });

  it('validates actual material, maintenance and shelter state without accepting mixed legacy rules', () => {
    const { c } = completedHome(); expect(isCommunityState(c)).toBe(true);
    for (const mode of ['missing', 'counter', 'future', 'legacy', 'occupancy', 'material'] as const) {
      const bad = structuredClone(c);
      if (mode === 'missing') delete bad.building.maintenance;
      if (mode === 'counter') bad.building.maintenance!.repairsCompleted = .5;
      if (mode === 'future') { bad.building.maintenance!.repairsCompleted = 1; bad.building.maintenance!.lastRepairAt = c.updatedAt + 1; }
      if (mode === 'legacy') bad.version = 3;
      if (mode === 'occupancy') bad.building.materials.fibreKg = 0;
      if (mode === 'material') bad.building.materials.timberKg = 97;
      expect(isCommunityState(bad), mode).toBe(false);
    }
  });
});
