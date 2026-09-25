import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { isCommunityState, waterAccessPosition } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { stepCommunity } from '../src/community.js';

const options = { seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const, initialCommunityRulesVersion: 2 as const, initialAgents: {}, minPopulation: {} };
function fixture(stock = 2) {
  const w = createWorld(options), c = w.community!, patch = w.patches[c.patchId]!, pool = w.microEcology.patches.find(p => p.patchId === c.patchId)!;
  patch.habitat = 'riparian'; patch.waterVolume = 1000;
  // Fixture redistribution only: never introduce nutrient mass to make a catch possible.
  patch.soilNutrients -= (stock - pool.fishBiomassKg) * .02; pool.fishBiomassKg = stock;
  c.stores.timberKg = 3; patch.plant.browse -= 3;
  for (const p of c.people) { p.skills.fishing = .99; p.skills.gathering = .1; }
  return { w, c, patch, pool };
}
describe('local fish catch, carrying and cooking', () => {
  it('spends travel and fishing time, records failures and transfers only actual stock into raw catch', () => {
    const { w, c, pool } = fixture(), before = w.totalNutrients();
    stepCommunity(c, w.patches, w.waterBudget, 0, 1, w.log, w.microEcology);
    expect(c.people.every(p => p.task?.kind === 'fish' && p.task.phase === 'travel')).toBe(true);
    expect(pool.fishBiomassKg).toBe(2); expect(c.people.every(p => p.inventory.rawFishKg === 0)).toBe(true);
    stepCommunity(c, w.patches, w.waterBudget, 1, 1900, w.log, w.microEcology);
    const attempts = w.log.all().filter(e => e.type === 'human_task_finished' && e.conditions.action === 'fish');
    expect(attempts).toHaveLength(4); expect(attempts.some(e => e.outcome === 'success')).toBe(true);
    const caught = attempts.reduce((n, e) => n + (e.effects.rawFishKg ?? 0), 0);
    expect(pool.fishBiomassKg).toBeCloseTo(2 - caught, 10); expect(caught).toBeGreaterThan(0);
    expect(attempts.every(e => e.worldTime >= 1800 && e.causalParents.length === 1)).toBe(true);
    expect(attempts.every(e => e.position!.x === waterAccessPosition(c.patchId).x && e.position!.z === waterAccessPosition(c.patchId).z)).toBe(true);
    expect(w.totalNutrients()).toBeCloseTo(before, 7);
  });
  it('rechecks depleted/dry supply at contact, so simultaneous attempts never duplicate fish', () => {
    for (const dry of [false, true]) {
      const { w, c, patch, pool } = fixture(.06);
      stepCommunity(c, w.patches, w.waterBudget, 0, 100, w.log, w.microEcology);
      expect(c.people.every(p => p.task?.kind === 'fish')).toBe(true);
      if (dry) patch.waterVolume = 0;
      const baseline = w.totalNutrients();
      stepCommunity(c, w.patches, w.waterBudget, 100, 1800, w.log, w.microEcology);
      const attempts = w.log.all().filter(e => e.type === 'human_task_finished' && e.conditions.action === 'fish');
      expect(attempts).toHaveLength(4);
      expect(attempts.reduce((n, e) => n + (e.effects.rawFishKg ?? 0), 0)).toBeLessThanOrEqual(.06);
      expect(attempts.filter(e => e.outcome === 'failure').length).toBeGreaterThan(0);
      expect(pool.fishBiomassKg).toBeGreaterThanOrEqual(0);
      if (dry) { expect(pool.fishBiomassKg).toBe(.06); expect(attempts.every(e => e.conditions.reason === 'no_accessible_fish')).toBe(true); }
      expect(w.totalNutrients()).toBeCloseTo(baseline, 7);
    }
  });
  it('runs natural local fish growth through successful/failed fishing, delivery, cooking and feeding without extra fish grants', () => {
    const w = createWorld(options), before = w.totalNutrients();
    // The versioned island's new freshwater basins change the saved household's finite
    // local fish supply. A first small catch may be below the cooking batch threshold;
    // observe long enough for an actual second catch, delivery, cook and meal.
    for (let h = 0; h < 720; h++) w.step(1);
    const events = w.log.all(), catches = events.filter(e => e.conditions.action === 'fish' && e.type === 'human_task_finished');
    expect(catches.some(e => e.outcome === 'success')).toBe(true); expect(catches.some(e => e.outcome === 'failure')).toBe(true);
    expect(events.some(e => e.conditions.action === 'deliver' && (e.effects.rawFishKg ?? 0) > 0)).toBe(true);
    const cooks = events.filter(e => e.conditions.action === 'cook' && e.type === 'human_task_finished' && e.outcome === 'success');
    expect(cooks.length).toBeGreaterThan(0);
    for (const cook of cooks) {
      expect(cook.effects.foodKg).toBeCloseTo(-cook.effects.rawFishKg!, 10);
      expect(cook.effects.fuelKg).toBeCloseTo(cook.effects.foodKg! * .1, 10);
      expect(cook.position).toMatchObject({ x: w.community!.building.position.x, z: w.community!.building.position.z });
    }
    expect(events.some(e => e.conditions.action === 'eat' && e.worldTime > cooks[0]!.worldTime)).toBe(true);
    expect(w.totalNutrients()).toBeCloseTo(before, 6); expect(isCommunityState(w.community)).toBe(true);
  });
  it('will not eat raw fish or cook without delivered fuel; spoilage and fuel ash conserve nutrients', () => {
    const { w, c, patch } = fixture(); c.stores.timberKg = 0;
    const p = c.people[0]!; p.inventory.rawFishKg = .2; patch.soilNutrients -= .2 * .02;
    p.needs.hunger = .8;
    const baseline = w.totalNutrients();
    stepCommunity(c, w.patches, w.waterBudget, 0, 100, w.log, w.microEcology);
    expect(w.log.all().some(e => e.actors[0] === p.id && e.conditions.action === 'eat')).toBe(false);
    expect(c.stores.rawFishKg).toBeGreaterThan(0); expect(c.stores.foodKg).toBe(0);
    expect(w.log.all().some(e => e.conditions.action === 'cook' && e.type === 'human_task_finished' && e.outcome === 'success')).toBe(false);
    expect(w.totalNutrients()).toBeCloseTo(baseline, 7);
  });
  it('restores mid-attempt with exactly the same roll, food stocks, events and subsequent outcomes', () => {
    const { w } = fixture(); w.step(.1);
    expect(w.community!.people.some(p => p.task?.kind === 'fish')).toBe(true);
    const snapshot = takeSnapshot(w), restored = restoreSnapshot(JSON.parse(JSON.stringify(snapshot)), options);
    expect(restored.log.all()).toEqual([]); w.log.take();
    for (let h = 0; h < 12; h++) { w.step(1); restored.step(1); }
    expect(takeSnapshot(w)).toEqual(takeSnapshot(restored)); expect(w.log.all()).toEqual(restored.log.all());
    expect(w.log.all().some(e => e.conditions.action === 'fish' && e.type === 'human_task_finished')).toBe(true);
  });
  it('serializes competing cooks against the delivered fuel budget and accounts for ash without duplicate meals', () => {
    const { w, c } = fixture(); c.stores.rawFishKg = .3; c.stores.timberKg = .01;
    for (const p of c.people) {
      p.position = { ...c.building.position };
      p.task = { kind: 'cook', phase: 'work', destination: { ...c.building.position }, remainingSeconds: .5, startedAt: 0, eventId: `cook_${p.id}` };
    }
    const baseline = w.totalNutrients();
    stepCommunity(c, w.patches, w.waterBudget, 0, 1, w.log, w.microEcology);
    const cooks = w.log.all().filter(e => e.type === 'human_task_finished' && e.conditions.action === 'cook');
    expect(cooks).toHaveLength(4); expect(cooks.filter(e => e.outcome === 'success')).toHaveLength(1);
    expect(cooks.filter(e => e.outcome === 'failure')).toHaveLength(3);
    expect(c.stores.foodKg).toBeCloseTo(.1, 10); expect(c.stores.timberKg).toBeCloseTo(0, 10);
    expect(c.stores.rawFishKg).toBeGreaterThan(.19); expect(w.totalNutrients()).toBeCloseTo(baseline, 7);
  });
  it('keeps saved v1 rules and rejects mislabeled or invalid catch state rather than silently upgrading', () => {
    const w = createWorld(options), c = w.community!; c.version = 1;
    delete c.stores.rawFishKg;
    for (const p of c.people) { delete p.inventory.rawFishKg; delete p.skills.fishing; }
    expect(isCommunityState(c)).toBe(true);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(w))), options);
    w.log.take();
    for (let h = 0; h < 72; h++) { w.step(1); restored.step(1); }
    expect(restored.community).toEqual(w.community); expect(restored.community!.version).toBe(1);
    expect(restored.log.all().some(e => ['fish', 'cook'].includes(String(e.conditions.action)))).toBe(false);
    expect(restored.community!.stores.rawFishKg).toBeUndefined();
    const corrupt = structuredClone(c); corrupt.people[0]!.skills.fishing = .9; expect(isCommunityState(corrupt)).toBe(false);
    const newer = createWorld(options).community!; newer.stores.rawFishKg = -1; expect(isCommunityState(newer)).toBe(false);
    newer.stores.rawFishKg = 0; delete newer.people[0]!.skills.fishing; expect(isCommunityState(newer)).toBe(false);
  });
});
