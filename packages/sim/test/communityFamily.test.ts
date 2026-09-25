import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { isCommunityState } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { closeKin } from '../src/communityFamily.js';

const options = { seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  terrainProfile: 'island_v1' as const, communityProfile: 'household_v1' as const,
  initialCommunityRulesVersion: 7 as const, initialAgents: {}, minPopulation: {} };

function dueFixture() {
  const world = createWorld(options), state = world.community!;
  const mother = state.people[0]!, father = state.people[1]!;
  for (const p of state.people) { p.needs = { hunger: .1, thirst: .1, fatigue: .9 }; }
  const conceived = world.log.append({ type: 'human_conceived', worldTime: 0, simVersion: '', patchId: mother.patchId,
    position: { ...mother.position }, actors: [mother.id, father.id, state.id],
    conditions: { model: 'test_persisted_pregnancy' }, outcome: 'success', effects: {},
    causalParents: [], confidence: 'authoritative' });
  // The fixture pays every gram into the prenatal stock before measuring conservation.
  const kg = 2.8;
  world.patches[mother.patchId]!.plant.grass -= kg;
  mother.pregnancy = { fatherId: father.id, conceivedAt: 0, dueAt: 3600,
    fetusKg: kg, conceivedEventId: conceived.id };
  return { world, state, mother, father };
}

describe('household v7 family lifecycle', () => {
  it('transfers saved prenatal biomass into a persistent named child and keeps the birth hour honest', () => {
    const { world, state, mother, father } = dueFixture();
    const baseline = world.totalNutrients();
    expect(isCommunityState(state)).toBe(true);
    world.step(1);
    expect(state.people).toHaveLength(5);
    const child = state.people[4]!;
    expect(child).toMatchObject({ id: 'person_0005', motherId: mother.id, fatherId: father.id,
      generation: 1, bornAt: 3600, massKg: 2.8, alive: true, task: null });
    const birth = world.log.all().find(e => e.type === 'human_born')!;
    expect(birth.actors).toEqual([child.id, mother.id, father.id, state.id]);
    expect(birth.causalParents).toHaveLength(1);
    expect(state.motion).toBeUndefined(); // No fabricated pre-birth motion samples.
    expect(world.totalNutrients()).toBeCloseTo(baseline, 7);
    expect(isCommunityState(state)).toBe(true);
    world.step(1);
    expect(state.motion?.tracks).toHaveLength(5);
    expect(isCommunityState(state)).toBe(true);
    const saved = takeSnapshot(world), restored = restoreSnapshot(structuredClone(saved), options);
    expect(restored.community).toEqual(state);
  });

  it('requires carried supplies and local contact for caregiving, then grows the child from finite food', () => {
    const { world, state, father } = dueFixture();
    world.step(1);
    const child = state.people[4]!;
    child.needs.hunger = .8; child.needs.thirst = .8;
    for (const p of state.people.slice(0, 4)) { p.task = null; p.needs = { hunger: .1, thirst: .1, fatigue: .1 }; }
    father.inventory.foodKg = .5; father.inventory.waterL = .8;
    const baseline = world.totalNutrients(), beforeMass = child.massKg;
    world.step(2);
    const care = world.log.all().find(e => e.type === 'human_cared' && e.actors[0] === child.id)!;
    expect(care).toBeDefined();
    expect(care.actors[1]).toBe(father.id);
    expect(care.causalParents).toHaveLength(1);
    expect(care.effects.childGrowthKg).toBeGreaterThan(0);
    expect(child.massKg).toBeGreaterThan(beforeMass);
    expect(world.totalNutrients()).toBeCloseTo(baseline, 6);
    expect(isCommunityState(state)).toBe(true);
  });

  it('rejects fabricated parentage or a second copy of a child ID', () => {
    const { world } = dueFixture(); world.step(1);
    const bad = structuredClone(world.community!);
    bad.people[4]!.motherId = bad.people[4]!.id;
    expect(isCommunityState(bad)).toBe(false);
    const duplicate = structuredClone(world.community!);
    duplicate.people[4]!.id = duplicate.people[0]!.id;
    expect(isCommunityState(duplicate)).toBe(false);
  });

  it('returns an undergrown pregnancy to local soil without creating a child', () => {
    const { world, state, mother } = dueFixture();
    const pregnancy = mother.pregnancy!;
    const retained = 1.25;
    world.patches[mother.patchId]!.plant.grass += pregnancy.fetusKg - retained;
    pregnancy.fetusKg = retained;
    const baseline = world.totalNutrients();
    world.step(1);
    expect(state.people).toHaveLength(4);
    expect(mother.pregnancy).toBeNull();
    expect(world.log.all().find(e => e.type === 'human_pregnancy_lost')).toMatchObject({
      effects: { returnedKg: retained }, conditions: { reason: 'insufficient_growth' },
    });
    expect(world.totalNutrients()).toBeCloseTo(baseline, 7);
    expect(isCommunityState(state)).toBe(true);
  });

  it('does not inject kinship fields or birth behavior into a pinned v6 household', () => {
    const world = createWorld({ ...options, initialCommunityRulesVersion: 6 });
    const state = world.community!;
    expect(state.version).toBe(6);
    expect(state.nextPersonSeq).toBeUndefined();
    world.step(24);
    expect(state.people).toHaveLength(4);
    expect(state.people.every(p => p.bornAt === undefined && p.pregnancy === undefined)).toBe(true);
    expect(world.log.all().some(e => e.type === 'human_born' || e.type === 'human_conceived')).toBe(false);
    expect(isCommunityState(state)).toBe(true);
  });

  it('excludes direct ancestors and shared-lineage partners, including a grandparent', () => {
    const { world, state, mother, father } = dueFixture();
    world.step(1);
    const child = state.people[4]!;
    expect(closeKin(state, mother, child)).toBe(true);
    expect(closeKin(state, father, child)).toBe(true);
    const grandchild = { ...child, id: 'person_future', motherId: child.id, fatherId: state.people[2]!.id };
    expect(closeKin(state, mother, grandchild)).toBe(true);
    expect(closeKin(state, child, grandchild)).toBe(true);
    expect(closeKin(state, state.people[2]!, mother)).toBe(false);
  });
});
