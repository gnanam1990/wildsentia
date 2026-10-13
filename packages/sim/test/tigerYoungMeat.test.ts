import { describe, expect, it } from 'vitest';
import { NUTRIENT_PER_KG_BIOMASS, createRng, edibleMass, patchCentre } from '@vana/shared';
import { executeGoal } from '../src/agents/behaviours.js';
import { selectGoal } from '../src/agents/goals.js';
import { allowsDependentGoal, canEatMaternalCarcass, canEatMaternalMeat,
  canHuntIndependently, needsProvisioning } from '../src/agents/needs.js';
import { perceive } from '../src/agents/perception.js';
import { EventLog } from '../src/events/log.js';
import { makeCarcass } from '../src/fields/decomposition.js';
import { buildGrid } from '../src/grid.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { createWorld } from '../src/world.js';
import { makeAgent, makeServices, makeView, SPECIES_DIR, speciesOf } from './helpers.js';
import { ISLAND_GRID } from '@vana/shared';

const tiger = speciesOf('tiger');
const patchId = 210;

function family(ageDays = 70, motherAlive = true) {
  const patches = buildGrid(1), centre = patchCentre(ISLAND_GRID, patchId);
  const mother = makeAgent('tiger', { id: 'tiger_mother', sex: 'female', alive: motherAlive,
    patchId, position: { ...centre } });
  const child = makeAgent('tiger', { id: 'tiger_cub', ageDays,
    lifeStage: ageDays < 90 ? 'newborn' : 'juvenile', massKg: tiger.body.adultMassKg * 0.12,
    motherId: mother.id, dependentOn: mother.id, patchId, position: { ...centre },
    drives: { hunger: 0.4, thirst: 0, fatigue: 0, fear: 0 } });
  const carcass = makeCarcass('parent_opened', 'sambar_dead', 'sambar', patchId, 0,
    'predation', 'authoritative', 100);
  carcass.position = { ...centre, x: centre.x + 40 };
  carcass.pathogenLoad = 0;
  carcass.consumers.push({ agentId: mother.id, at: 1800, kg: 2 });
  const carcasses = [carcass], agents = [child, mother], view = makeView(patches, agents, carcasses);
  const log = new EventLog(1, 'test');
  return { patches, mother, child, carcass, carcasses, view, log };
}

function forceScavenge(s: ReturnType<typeof family>, hours = 1, species = tiger, now = 3600) {
  executeGoal({ agent: s.child, species, patches: s.patches, view: s.view,
    percept: { ...perceive(s.child, species, s.view), carrion: { carcass: s.carcass, patchId } },
    choice: { goal: 'scavenge', score: 1, alternative: null }, hours, worldTime: now,
    log: s.log, rng: createRng(3, 'young-meat'), services: makeServices(s.carcasses) });
}

describe('tiger cub finite maternal-carcass gate', () => {
  it('opens at 70 days while keeping dependence, weaning, and hunting unchanged', () => {
    const before = family(69 + 23 / 24), at = family(70), later = family(179), adult = family(1100);
    expect(tiger.lifecycle).toMatchObject({ meatFromDays: 70, drinkFromDays: 70, weanDays: 180 });
    expect(canEatMaternalMeat(before.child, tiger)).toBe(false);
    expect(canEatMaternalMeat(at.child, tiger)).toBe(true);
    expect(canEatMaternalMeat(later.child, tiger)).toBe(true);
    for (const s of [before, at, later]) {
      expect(needsProvisioning(s.child, tiger)).toBe(true);
      expect(canHuntIndependently(s.child, tiger)).toBe(false);
      expect(allowsDependentGoal(s.child, tiger, 'hunt')).toBe(false);
      expect(allowsDependentGoal(s.child, tiger, 'find_food')).toBe(false);
    }
    expect(allowsDependentGoal(before.child, tiger, 'scavenge')).toBe(false);
    expect(allowsDependentGoal(at.child, tiger, 'scavenge')).toBe(true);
    expect(needsProvisioning(adult.child, tiger)).toBe(false);
    expect(allowsDependentGoal(adult.child, tiger, 'scavenge')).toBe(true);
    expect(canEatMaternalMeat(adult.child, tiger)).toBe(false);
    expect(allowsDependentGoal(makeAgent('boar', { ageDays: 70, dependentOn: 'mother' }), speciesOf('boar'), 'scavenge')).toBe(false);
  });

  it('proactively selects parent-opened meat and eats only after real approach/contact', () => {
    const s = family();
    const percept = perceive(s.child, tiger, s.view);
    expect(percept.carrion?.carcass).toBe(s.carcass);
    expect(canEatMaternalCarcass(s.child, tiger, s.carcass, s.view, 3600)).toBe(true);
    expect(selectGoal(s.child, tiger, percept, createRng(3, 'cub-choice')).goal).toBe('scavenge');
    const massBefore = edibleMass(s.carcass.biomass), soilBefore = s.patches[patchId]!.soilNutrients;
    forceScavenge(s);
    const move = s.log.all().find(event => event.type === 'moved' && event.goal === 'scavenge');
    const meal = s.log.all().find(event => event.type === 'scavenged');
    expect(move?.outcome).toBe('success');
    expect(move?.conditions.reason).toBe('approach_carcass');
    expect(meal).toBeDefined();
    expect(meal?.causalParents).toContain(move!.id);
    expect(Number(meal!.effects.kg)).toBeGreaterThan(0);
    expect(massBefore - edibleMass(s.carcass.biomass)).toBeCloseTo(Number(meal!.effects.kg));
    expect(s.patches[patchId]!.soilNutrients - soilBefore).toBeCloseTo(Number(meal!.effects.kg) * NUTRIENT_PER_KG_BIOMASS);
    expect(s.carcass.consumers.at(-1)).toMatchObject({ agentId: s.child.id, kg: meal!.effects.kg });
    expect(s.child.drives.hunger).toBeLessThan(0.4);
    expect(s.child.dependentOn).toBe(s.mother.id);
  });

  it('rejects underage, unlinked, nonpositive, future, dead-mother, empty, and stale sources even if forced', () => {
    for (const mode of ['underage', 'unlinked', 'wrongDependency', 'zero', 'future', 'dead', 'empty', 'stale'] as const) {
      const s = family(mode === 'underage' ? 69 : 70, mode !== 'dead');
      if (mode === 'unlinked') s.carcass.consumers[0]!.agentId = 'unrelated_tiger';
      if (mode === 'wrongDependency') s.child.dependentOn = 'other_guardian';
      if (mode === 'zero') s.carcass.consumers[0]!.kg = 0;
      if (mode === 'future') s.carcass.consumers[0]!.at = 7200;
      if (mode === 'empty') { s.carcass.biomass.muscle = 0; s.carcass.biomass.organ = 0; }
      if (mode === 'stale') s.carcasses.splice(0);
      const start = { ...s.child.position! }, mass = edibleMass(s.carcass.biomass);
      const hunger = s.child.drives.hunger;
      forceScavenge(s);
      expect(s.log.all().some(event => event.type === 'scavenged' || event.type === 'moved'), mode).toBe(false);
      expect(s.child.position).toEqual(start);
      expect(s.child.drives.hunger).toBe(hunger);
      expect(edibleMass(s.carcass.biomass)).toBe(mass);
    }
  });

  it('cannot turn an incomplete approach into free food, and a weaned tiger keeps ordinary carrion access', () => {
    const s = family();
    const slow = { ...tiger, locomotion: { ...tiger.locomotion, walkMs: 0.001 } };
    const mass = edibleMass(s.carcass.biomass), hunger = s.child.drives.hunger;
    forceScavenge(s, 1 / 3600, slow);
    expect(s.log.all().some(event => event.type === 'scavenged')).toBe(false);
    expect(edibleMass(s.carcass.biomass)).toBe(mass);
    expect(s.child.drives.hunger).toBe(hunger);
    const weaned = family(180, false);
    weaned.carcass.consumers.length = 0;
    forceScavenge(weaned);
    expect(weaned.log.all().some(event => event.type === 'scavenged')).toBe(true);
  });

  it('links a real cub meal to its carrion disease episode without inventing exposure on approach', () => {
    const s = family();
    s.carcass.pathogenLoad = 1;
    const rng = createRng(3, 'cub-infection');
    rng.bool = () => true;
    executeGoal({ agent: s.child, species: tiger, patches: s.patches, view: s.view,
      percept: perceive(s.child, tiger, s.view),
      choice: { goal: 'scavenge', score: 1, alternative: null }, hours: 1,
      worldTime: 3600, log: s.log, rng, services: makeServices(s.carcasses) });
    const meal = s.log.all().find(event => event.type === 'scavenged');
    const contracted = s.log.all().find(event => event.type === 'disease_contracted');
    expect(meal).toBeDefined();
    expect(contracted).toBeDefined();
    expect(contracted?.causalParents).toEqual([meal!.id]);
    expect(contracted?.conditions).toMatchObject({ sourceCarcassId: s.carcass.id,
      sourceMealEventId: meal!.id, sourceAnimalId: s.carcass.originId });
    expect(contracted?.effects.consumedKg).toBe(meal!.effects.kg);
    expect(s.child.illness).toMatchObject({ sourceCarcassId: s.carcass.id,
      sourceMealEventId: meal!.id, phase: 'incubating' });
  });

  it('replays the same finite dependent meal and event lineage after a JSON snapshot restore', () => {
    const options = { seed: 23, speciesDir: SPECIES_DIR, terrainProfile: 'island_v1' as const,
      initialAgents: { tiger: 2 }, minPopulation: {} };
    const world = createWorld(options), [mother, child] = world.agents;
    const patch = world.patches.find(candidate => candidate.habitat === 'grassland')!;
    const centre = patchCentre(ISLAND_GRID, patch.id);
    mother!.sex = 'female'; mother!.patchId = patch.id; mother!.position = { ...centre };
    mother!.lastEncounterAt = world.now();
    mother!.offspringIds = [child!.id];
    Object.assign(child!, { ageDays: 70, lifeStage: 'newborn', massKg: tiger.body.adultMassKg * 0.12,
      motherId: mother!.id, dependentOn: mother!.id, patchId: patch.id, position: { ...centre },
      drives: { hunger: 0.8, thirst: 0, fatigue: 0, fear: 0 } });
    const carcass = makeCarcass('restored_parent_meal', 'sambar_dead', 'sambar', patch.id, 0,
      'predation', 'authoritative', 100);
    carcass.position = { ...centre, x: centre.x + 20 };
    carcass.pathogenLoad = 0;
    carcass.consumers.push({ agentId: mother!.id, at: 0, kg: 2 });
    world.carcasses.push(carcass);
    world.log.take(); // Snapshot stores continuation cursor, not historical retained spawn events.
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(world))), options);
    world.step(1); restored.step(1);
    const meal = world.log.all().find(event => event.type === 'scavenged' && event.actors[0] === child!.id);
    expect(meal).toBeDefined();
    expect(Number(meal!.effects.kg)).toBeGreaterThan(0);
    expect(restored.log.all()).toEqual(world.log.all());
    expect(takeSnapshot(restored)).toEqual(takeSnapshot(world));
    expect(world.carcasses.find(source => source.id === carcass.id)?.consumers.at(-1))
      .toMatchObject({ agentId: child!.id, kg: meal!.effects.kg });
  });
});
