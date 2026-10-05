import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { communityBiomassKg, isCommunityState, landWalkable, positionInPatch } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { ISLAND_POPULATION } from '../src/forest.js';
import { takeSnapshot, restoreSnapshot } from '../src/snapshot.js';
import { stepCommunity } from '../src/community.js';
import { waterBudgetResidual } from '../src/fields/drainage.js';

const options = { seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const, initialCommunityRulesVersion: 3 as const, initialAgents: {}, minPopulation: {} };

describe('persistent autonomous household', () => {
  it('delivers finite gathered fuel before seeking more when a real catch awaits cooking', () => {
    const w = createWorld({ ...options, seed: 2, initialCommunityRulesVersion: 8,
      initialAgents: ISLAND_POPULATION });
    const baseline = w.totalNutrients();
    // When the first catch lands depends on the whole world's history (hour 107 under the first
    // sim_0.35.0 rules), so step until a catch has been cooked, within ten days.
    const cooked = () => w.log.all().some(e => e.type === 'human_task_finished' && e.conditions.action === 'cook'
      && e.outcome === 'success');
    for (let h = 0; h < 240 && (h < 96 || !cooked()); h++) w.step(1);
    const c = w.community!, events = w.log.all();
    const deliveredTimber = events.filter(e => e.type === 'human_task_finished'
      && e.conditions.action === 'deliver').reduce((kg, e) => kg + (e.effects.timberKg ?? 0), 0);
    expect(deliveredTimber).toBeGreaterThan(0);
    expect(events.filter(e => e.type === 'human_task_started'
      && e.conditions.action === 'gather_timber').length).toBeLessThan(200);
    expect(events.some(e => e.type === 'human_task_finished' && e.conditions.action === 'cook'
      && e.outcome === 'success')).toBe(true);
    expect(c.people.every(p => p.alive && p.health > .9 && p.needs.hunger < .95)).toBe(true);
    expect(c.people.every(p => p.inventory.timberKg < 10)).toBe(true);
    expect(w.totalNutrients()).toBeCloseTo(baseline, 6);
    expect(Math.abs(waterBudgetResidual(w.patches, w.waterBudget))).toBeLessThan(.001);
  });
  it('returns to delivered household water when thirsty offsite instead of repeatedly visiting a depleted source', () => {
    const w = createWorld(options), c = w.community!, p = c.people[0]!;
    c.stores.waterL = 20; c.stores.foodKg = 20; w.patches[c.patchId]!.waterVolume = 0;
    p.position = { ...c.building.position, x: c.building.position.x + 20 };
    p.needs = { hunger: .1, thirst: .6, fatigue: .1 }; p.inventory.waterL = 0;
    p.retryAfter.collect_water = 3600;
    for (const other of c.people.slice(1)) {
      other.needs = { hunger: .1, thirst: .1, fatigue: .1 };
      other.task = { kind: 'rest', phase: 'work', destination: { ...other.position }, remainingSeconds: 3600, startedAt: 0, eventId: `rest_${other.id}` };
    }
    stepCommunity(c, w.patches, w.waterBudget, 0, 1, w.log);
    expect(p.task).toMatchObject({ kind: 'deliver', destination: c.building.position });
    expect(c.stores.waterL).toBe(20); expect(p.inventory.waterL).toBe(0);
    stepCommunity(c, w.patches, w.waterBudget, 1, 300, w.log);
    expect(p.needs.thirst).toBeLessThan(.1); expect(c.stores.waterL).toBe(19);
    expect(w.waterBudget.communityWithdrawalL ?? 0).toBe(0);
    expect(w.log.all().some(e => e.type === 'human_task_finished' && e.actors[0] === p.id && e.conditions.action === 'drink')).toBe(true);
    expect(isCommunityState(c)).toBe(true);
  });
  it('selects dry core land deterministically, with distinct people and no material gift', () => {
    for (const seed of [1, 2, 3, 44]) {
      const a = createWorld({ ...options, seed }), b = createWorld({ ...options, seed }), c = a.community!;
      expect(c).toEqual(b.community); expect(isCommunityState(c)).toBe(true);
      expect(landWalkable(a.patches[c.patchId])).toBe(true);
      expect(new Set(c.people.map(p => p.appearanceSeed)).size).toBe(4);
      expect(new Set(c.people.map(p => p.skills.building)).size).toBe(4);
      expect(c.stores).toEqual({ foodKg: 0, waterL: 0, timberKg: 0, fibreKg: 0, rawFishKg: 0 });
      expect(c.building.materials).toEqual({ timberKg: 0, fibreKg: 0 });
      expect(c.people.every(p => positionInPatch(p.position, c.patchId))).toBe(true);
    }
  });
  it('spends real travel/work time before gathering, then delivers at household contact', () => {
    const w = createWorld(options), c = w.community!, p = c.people[0]!, start = { ...p.position }, baseline = w.totalNutrients();
    stepCommunity(c, w.patches, w.waterBudget, 0, 1, w.log);
    expect(p.task).toMatchObject({ kind: 'gather_food', phase: 'travel' });
    expect(Math.hypot(p.position.x - start.x, p.position.z - start.z)).toBeCloseTo(1.1);
    expect(p.inventory.foodKg).toBe(0); expect(c.stores.foodKg).toBe(0);
    stepCommunity(c, w.patches, w.waterBudget, 1, 1200, w.log);
    expect(w.log.all().some(e => e.type === 'human_task_finished' && e.conditions.action === 'deliver')).toBe(true);
    expect(c.stores.foodKg).toBeGreaterThan(0);
    for (const e of w.log.all().filter(e => e.type === 'human_task_finished' && e.conditions.action === 'deliver')) {
      expect(e.position!.x).toBe(c.building.position.x); expect(e.position!.z).toBe(c.building.position.z);
    }
    expect(w.totalNutrients()).toBeCloseTo(baseline, 7);
  });
  it('runs the real world from empty materials through all construction stages without duplicating resources', () => {
    const w = createWorld(options), baseline = w.totalNutrients();
    for (let h = 0; h < 48; h++) w.step(1);
    const c = w.community!;
    expect(c.building).toMatchObject({ stage: 'occupied', materials: { timberKg: 96, fibreKg: 72 }, labourSeconds: 0 });
    expect(c.building.occupantIds).toEqual(c.people.map(p => p.id));
    const stages = w.log.all().filter(e => e.type === 'building_stage');
    expect(stages.map(e => e.conditions.to)).toEqual(['frame', 'walls', 'roof', 'occupied']);
    expect(stages.every(e => e.causalParents.length === 1)).toBe(true);
    expect(w.log.all().some(e => e.type === 'human_task_finished' && e.conditions.action === 'drink')).toBe(true);
    expect(c.people.every(p => p.alive && p.health > .9)).toBe(true);
    expect(w.totalNutrients()).toBeCloseTo(baseline, 6);
    expect(Math.abs(waterBudgetResidual(w.patches, w.waterBudget))).toBeLessThan(.001);
    expect(w.waterBudget.communityWithdrawalL).toBeGreaterThan(0);
    expect(isCommunityState(c)).toBe(true);
  });
  it('resumes in-flight tasks and construction exactly through JSON checkpoints, with no replayed delivery', () => {
    const a = createWorld(options); a.step(.1);
    expect(a.community!.people.some(p => p.task !== null)).toBe(true);
    const saved = takeSnapshot(a), b = restoreSnapshot(JSON.parse(JSON.stringify(saved)), options);
    expect(b.log.all()).toEqual([]);
    a.log.take(); b.log.take();
    for (let h = 0; h < 24; h++) { a.step(1); b.step(1); }
    expect(takeSnapshot(a)).toEqual(takeSnapshot(b)); expect(a.log.all()).toEqual(b.log.all());
    expect(a.community!.building.stage).toBe('occupied');
    expect(saved.community!.building.stage).toBe('site');
  });
  it('records failed attempts and eventual death with depleted supplies, keeping mass in decay instead of inventing food', () => {
    const w = createWorld(options), c = w.community!, patch = w.patches[c.patchId]!;
    patch.plant.grass = 0; patch.plant.browse = 0; patch.waterVolume = 0;
    const baseline = w.totalNutrients();
    stepCommunity(c, w.patches, w.waterBudget, 0, 96 * 3600, w.log);
    expect(c.people.every(p => !p.alive && p.diedAt !== null && p.task === null)).toBe(true);
    expect(c.building.stage).toBe('site'); expect(c.stores.foodKg).toBe(0);
    expect(w.log.all().some(e => e.type === 'human_task_finished' && e.outcome === 'failure')).toBe(true);
    expect(w.log.all().filter(e => e.type === 'human_died')).toHaveLength(4);
    expect(communityBiomassKg(c)).toBeGreaterThan(0); expect(w.totalNutrients()).toBeCloseTo(baseline, 7);
    expect(isCommunityState(c)).toBe(true);
  });
  it('interrupts nonessential work for urgent needs without completing its construction task', () => {
    const w = createWorld(options), c = w.community!;
    c.stores.timberKg = 48; c.stores.fibreKg = 8; c.stores.foodKg = 20; c.stores.waterL = 20;
    stepCommunity(c, w.patches, w.waterBudget, 0, 1, w.log);
    const p = c.people[0]!; expect(p.task?.kind).toBe('build');
    p.needs.thirst = .85;
    stepCommunity(c, w.patches, w.waterBudget, 1, 60, w.log);
    expect(w.log.all().some(e => e.type === 'human_task_interrupted' && e.actors[0] === p.id && e.conditions.reason === 'urgent_need')).toBe(true);
    expect(p.task?.kind).toBe('drink'); expect(c.building.labourSeconds).toBe(0);
  });
  it('preserves legacy worlds and fails closed on profile switches or corrupt household checkpoints', () => {
    const plain = { ...options, communityProfile: 'none' as const }, a = createWorld(plain);
    expect(a.community).toBeNull(); expect(takeSnapshot(a).community).toBeUndefined();
    expect(() => restoreSnapshot(takeSnapshot(a), options)).toThrow(/profile mismatch/);
    const saved = takeSnapshot(createWorld(options));
    expect(() => restoreSnapshot(saved, plain)).toThrow(/profile mismatch/);
    const bad = structuredClone(saved); bad.community!.people[0]!.inventory.foodKg = -1;
    expect(() => restoreSnapshot(bad, options)).toThrow(/invalid community/);
    const future = structuredClone(saved); future.community!.updatedAt++;
    expect(() => restoreSnapshot(future, options)).toThrow(/invalid community/);
    const duplicated = structuredClone(saved); duplicated.community!.people[1]!.id = duplicated.community!.people[0]!.id;
    expect(isCommunityState(duplicated.community)).toBe(false);
    const fabricated = structuredClone(saved); fabricated.community!.building.stage = 'occupied';
    expect(isCommunityState(fabricated.community)).toBe(false);
  });
});
