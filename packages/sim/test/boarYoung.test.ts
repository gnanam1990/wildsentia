import { describe, expect, it } from 'vitest';
import { createRng, waterAccessPosition } from '@vana/shared';
import { executeGoal } from '../src/agents/behaviours.js';
import { selectGoal } from '../src/agents/goals.js';
import { canDrinkIndependently, canFollowParent, canForageIndependently, allowsDependentGoal, careRadius, needsOf, needsProvisioning } from '../src/agents/needs.js';
import { perceive } from '../src/agents/perception.js';
import { EventLog } from '../src/events/log.js';
import { waterBudgetResidual } from '../src/fields/drainage.js';
import { buildGrid } from '../src/grid.js';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { makeAgent, makeServices, makeView, SPECIES_DIR, speciesOf } from './helpers.js';
import { ISLAND_GRID } from '@vana/shared';

const cfg = speciesOf('boar');
const worldOptions = { seed: 1, speciesDir: SPECIES_DIR, initialAgents: { boar: 2 }, minPopulation: {} };

function young(ageDays: number, dependentOn: string | null = null) {
  return makeAgent('boar', { id: 'piglet', ageDays, lifeStage: ageDays < 45 ? 'newborn' : 'juvenile',
    massKg: cfg.body.adultMassKg * (ageDays < 45 ? 0.12 : 0.35), dependentOn,
    position: { ...waterAccessPosition(ISLAND_GRID, 0), x: waterAccessPosition(ISLAND_GRID, 0).x + 100 },
    drives: { hunger: 0.1, thirst: 0.9, fatigue: 0, fear: 0 } });
}

function familyWorld(ageDays: number, childFirst = false) {
  const world = createWorld(worldOptions), [mother, child] = world.agents;
  mother!.sex = 'female'; mother!.drives = { hunger: 0.2, thirst: 0.2, fatigue: 0, fear: 0 };
  const juvenile = young(ageDays, mother!.id);
  Object.assign(child!, juvenile, { id: child!.id, motherId: mother!.id });
  mother!.offspringIds = [child!.id]; mother!.patchId = child!.patchId;
  mother!.position = { ...child!.position! };
  if (childFirst) world.agents.reverse();
  return { world, mother: mother!, child: child! };
}

describe('boar pre-weaning water and solid-food transitions', () => {
  it('keeps the youngest piglets dependent, then separately unlocks following, drinking and plant foraging', () => {
    const infant = young(9 + 23 / 24, 'mother'), mobile = young(10, 'mother'), rooter = young(21, 'mother');
    expect(needsProvisioning(infant, cfg)).toBe(true);
    expect(canFollowParent(infant, cfg)).toBe(false);
    expect(canDrinkIndependently(infant, cfg)).toBe(false);
    expect(canForageIndependently(infant, cfg)).toBe(false);
    expect(canFollowParent(mobile, cfg)).toBe(true);
    expect(canDrinkIndependently(mobile, cfg)).toBe(true);
    expect(canForageIndependently(mobile, cfg)).toBe(false);
    expect(allowsDependentGoal(mobile, cfg, 'find_water')).toBe(true);
    for (const forbidden of ['find_food', 'scavenge', 'hunt', 'wander', 'breed'] as const)
      expect(allowsDependentGoal(mobile, cfg, forbidden)).toBe(false);
    expect(canForageIndependently(rooter, cfg)).toBe(true);
    expect(allowsDependentGoal(rooter, cfg, 'find_food')).toBe(true);
    expect(allowsDependentGoal(rooter, cfg, 'scavenge')).toBe(false);
  });

  it.each([null, 'mother'])('lets a thirsty day-ten piglet route to finite water with or without a parent; parent=%s', dependentOn => {
    const patches = buildGrid(1), child = young(10, dependentOn), water = patches[0]!.waterVolume;
    patches[0]!.habitat = 'grassland';
    const view = makeView(patches, [child]), log = new EventLog(1, 'test');
    const percept = perceive(child, cfg, view), choice = selectGoal(child, cfg, percept, createRng(1, 'boar-choice'));
    expect(choice.goal).toBe('find_water');
    const start = { ...child.position! }, thirst = child.drives.thirst;
    const context = { agent: child, species: cfg, patches, view, percept, choice, log, rng: createRng(1, 'boar-exec'),
      services: makeServices([]), hours: 1, worldTime: 0 };
    let withdrawn = 0;
    context.services.consumedWater = litres => { withdrawn += litres; };
    executeGoal(context);
    const move = log.all().find(e => e.type === 'moved'), drink = log.all().find(e => e.type === 'drank')!;
    expect(move?.movement?.completed).toBe(true);
    expect(drink).toBeDefined();
    expect(drink.causalParents).toEqual([move!.id]);
    expect(drink.effects.litres).toBeGreaterThan(0);
    expect(water - patches[0]!.waterVolume).toBeCloseTo(Number(drink.effects.litres));
    expect(withdrawn).toBeCloseTo(Number(drink.effects.litres));
    expect(thirst - child.drives.thirst).toBeCloseTo(Number(drink.effects.litres) / needsOf(child, cfg).waterL * 0.4);
    expect(child.position).not.toEqual(start);
    expect(child.dependentOn).toBe(dependentOn);
  });

  it('does not let an underage orphan gain a water goal through a forced action', () => {
    const patches = buildGrid(1), child = young(9, null), view = makeView(patches, [child]);
    const log = new EventLog(1, 'test'), percept = perceive(child, cfg, view), start = { ...child.position! };
    expect(selectGoal(child, cfg, percept, createRng(1, 'boar-goal')).goal).toBe('rest');
    executeGoal({ agent: child, species: cfg, patches, view, percept, log, rng: createRng(1, 'boar-forced'),
      services: makeServices([]), choice: { goal: 'find_water', score: 1, alternative: null }, hours: 1, worldTime: 0 });
    expect(child.currentGoal).toBe('rest');
    expect(child.position).toEqual(start);
    expect(log.all().some(e => e.type === 'drank' || e.type === 'moved')).toBe(false);
  });

  it('permits pre-weaning plant intake only from the existing finite plant pool', () => {
    const patches = buildGrid(1), child = young(21, null);
    child.drives = { hunger: 0.95, thirst: 0, fatigue: 0, fear: 0 };
    const view = makeView(patches, [child]), log = new EventLog(1, 'test'), percept = perceive(child, cfg, view);
    const choice = selectGoal(child, cfg, percept, createRng(1, 'boar-food'));
    expect(choice.goal).toBe('find_food');
    const before = patches[0]!.plant.grass + patches[0]!.plant.browse;
    executeGoal({ agent: child, species: cfg, patches, view, percept, log, rng: createRng(1, 'boar-feed'),
      services: makeServices([]), choice, hours: 1, worldTime: 0 });
    const fed = log.all().find(e => e.type === 'fed')!;
    expect(fed).toBeDefined();
    expect(before - patches[0]!.plant.grass - patches[0]!.plant.browse).toBeCloseTo(Number(fed.effects.kg));
    expect(child.currentGoal).toBe('find_food');
  });

  it('drinks in the authoritative world, conserves water, and resumes from a snapshot without inventing care', () => {
    const options = { seed: 1, speciesDir: SPECIES_DIR, initialAgents: { boar: 1 }, minPopulation: {} };
    const world = createWorld(options), child = world.agents[0]!;
    Object.assign(child, young(10, null), { id: child.id });
    const before = { ...child.position! }, baseline = world.totalNutrients();
    world.step(1);
    const drink = world.log.all().find(e => e.type === 'drank' && e.actors[0] === child.id)!;
    expect(drink).toBeDefined();
    expect(drink.effects.litres).toBeGreaterThan(0);
    expect(world.waterBudget.animalConsumptionL).toBeGreaterThanOrEqual(Number(drink.effects.litres));
    expect(child.position).not.toEqual(before);
    expect(child.dependentOn).toBeNull();
    expect(world.log.all().some(e => e.type === 'provisioned')).toBe(false);
    expect(world.totalNutrients()).toBeCloseTo(baseline, 6);
    expect(Math.abs(waterBudgetResidual(world.patches, world.waterBudget))).toBeLessThan(1e-4);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(world))), options);
    world.log.take();
    for (let i = 0; i < 12; i++) { world.step(1); restored.step(1); }
    expect(restored.agents).toEqual(world.agents);
    expect(restored.log.all()).toEqual(world.log.all());
    expect(restored.waterBudget).toEqual(world.waterBudget);
  });

  it.each([false, true])('does not let a planned maternal care visit overlap the child water trip; child-first=%s', childFirst => {
    const { world, mother, child } = familyWorld(10, childFirst);
    child.drives = { hunger: 0.7, thirst: 0.3, fatigue: 0, fear: 0 };
    const childStart = { ...child.position! }, motherStart = { ...mother.drives }, childThirst = child.drives.thirst;
    const baseline = world.totalNutrients();
    world.step(1);
    const care = world.log.all().find(e => e.type === 'provisioned' && e.actors[0] === child.id)!;
    expect(care).toBeDefined();
    expect(Number(care.effects.foodEquivalentKg)).toBeGreaterThan(0);
    expect(Number(care.effects.waterEquivalentL)).toBeGreaterThan(0);
    expect(world.log.all().some(e => e.actors[0] === child.id && (e.type === 'drank' || e.type === 'fed' || e.type === 'moved'))).toBe(false);
    expect(child.position).toEqual(childStart);
    const water = Number(care.effects.waterEquivalentL);
    expect(mother.drives.thirst - motherStart.thirst - 0.4 / 24).toBeCloseTo(water / needsOf(mother, cfg).waterL * 0.4);
    expect(childThirst + 0.4 / 24 - child.drives.thirst).toBeCloseTo(water / needsOf(child, cfg).waterL * 0.4);
    expect(world.totalNutrients()).toBeCloseTo(baseline, 6);
    expect(Math.abs(waterBudgetResidual(world.patches, world.waterBudget))).toBeLessThan(1e-4);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(world))), worldOptions);
    world.log.take();
    for (let i = 0; i < 24; i++) { world.step(1); restored.step(1); }
    expect(restored.agents).toEqual(world.agents);
    expect(restored.log.all()).toEqual(world.log.all());
  });

  it.each([10, 21])('executes the chosen independent need if a planned maternal visit fails at age %i', ageDays => {
    const { world, mother, child } = familyWorld(ageDays);
    child.drives = ageDays === 10
      ? { hunger: 0.1, thirst: 0.3, fatigue: 0, fear: 0 }
      : { hunger: 0.4, thirst: 0.1, fatigue: 0, fear: 0 };
    // The parent was committed to a prior encounter. Care selection at the decision start is
    // still possible, but its visit never takes place; this is not a free care promise.
    mother.lastEncounterAt = world.now();
    const start = { ...child.position! };
    world.step(1);
    expect(world.log.all().some(e => e.type === 'provisioned' && e.actors[0] === child.id)).toBe(false);
    const expected = ageDays === 10 ? 'drank' : 'fed';
    expect(world.log.all().some(e => e.type === expected && e.actors[0] === child.id)).toBe(true);
    expect(child.currentGoal).toBe(ageDays === 10 ? 'find_water' : 'find_food');
    if (ageDays === 10) expect(child.position).not.toEqual(start);
  });

  it('does not suppress a child water approach when the parent care route cannot reach contact', () => {
    const { world, mother, child } = familyWorld(10);
    child.drives = { hunger: 0.5, thirst: 0.3, fatigue: 0, fear: 0 };
    mother.position!.x -= 100;
    world.species.get('boar')!.locomotion.walkMs = 0.001;
    const start = { ...child.position! };
    world.step(1);
    expect(world.log.all().some(e => e.type === 'provisioned' && e.actors[0] === child.id)).toBe(false);
    expect(world.log.all().some(e => e.type === 'moved' && e.actors[0] === mother.id && e.goal === 'care_for_young')).toBe(true);
    expect(world.log.all().some(e => e.type === 'moved' && e.actors[0] === child.id && e.goal === 'find_water')).toBe(true);
    expect(child.position).not.toEqual(start);
    expect(child.currentGoal).toBe('find_water');
  });

  it('lets genuinely urgent thirst override a nearby planned care visit', () => {
    const { world, child } = familyWorld(10);
    child.drives = { hunger: 0.5, thirst: 0.8, fatigue: 0, fear: 0 };
    world.step(1);
    expect(world.log.all().some(e => e.type === 'drank' && e.actors[0] === child.id)).toBe(true);
    expect(world.log.all().some(e => e.type === 'provisioned' && e.actors[0] === child.id)).toBe(false);
  });

  it('keeps a hydrated day-sixteen child at its known care site beyond sensory range instead of looping water trips', () => {
    const { world, mother, child } = familyWorld(16);
    child.drives = { hunger: 0.95, thirst: 0.016, fatigue: 0, fear: 0 };
    child.position = { ...waterAccessPosition(ISLAND_GRID, 0) };
    mother.position = { ...waterAccessPosition(ISLAND_GRID, 3) };
    mother.patchId = 3;
    expect(Math.hypot(child.position.x - mother.position.x, child.position.z - mother.position.z))
      .toBeGreaterThan(cfg.senses.smellRangeM);
    const percept = perceive(child, cfg, makeView(world.patches, world.agents));
    expect(selectGoal(child, cfg, percept, createRng(1, 'hydrated-dependent')).goal).toBe('rest');
    const start = { ...child.position };
    world.step(1);
    expect(child.currentGoal).toBe('rest');
    expect(child.position).toEqual(start);
    expect(world.log.all().some(e => e.actors[0] === child.id && (e.type === 'drank' || e.type === 'moved'))).toBe(false);
    child.drives.thirst = 0.5;
    expect(selectGoal(child, cfg, perceive(child, cfg, makeView(world.patches, world.agents)),
      createRng(1, 'urgent-dependent')).goal).toBe('find_water');
  });

  it('regroups a day-sixteen sibling at the selected care site with two completed routes, not a position snap', () => {
    const world = createWorld({ ...worldOptions, initialAgents: { boar: 3 } });
    const [mother, target, sibling] = world.agents;
    mother!.sex = 'female'; mother!.drives = { hunger: 0.2, thirst: 0.2, fatigue: 0, fear: 0 };
    for (const child of [target!, sibling!]) {
      const youngBody = young(16, mother!.id);
      Object.assign(child, youngBody, { id: child.id, motherId: mother!.id });
      child.drives = { hunger: child === target ? 0.7 : 0.4, thirst: 0.2, fatigue: 0, fear: 0 };
    }
    mother!.offspringIds = [target!.id, sibling!.id];
    mother!.patchId = target!.patchId; mother!.position = { ...target!.position!, x: target!.position!.x - 30 };
    sibling!.position = { ...target!.position!, x: target!.position!.x + 100 };
    const origin = { ...sibling!.position! };
    world.step(1);
    const movement = world.log.all().find(e => e.type === 'moved' && e.actors[0] === sibling!.id && e.goal === 'follow_parent')!;
    const care = world.log.all().find(e => e.type === 'provisioned' && e.actors[0] === sibling!.id)!;
    expect(movement?.movement?.completed).toBe(true);
    expect(care).toBeDefined();
    expect(care.causalParents).toContain(movement.id);
    expect(sibling!.position).not.toEqual(origin);
    expect(Math.hypot(sibling!.position!.x - mother!.position!.x, sibling!.position!.z - mother!.position!.z))
      .toBeLessThanOrEqual(careRadius(cfg));
    expect(world.log.all().some(e => e.type === 'drank' && e.actors[0] === sibling!.id)).toBe(false);
    for (let hour = 1; hour < 24; hour++) world.step(1);
    expect(target!.alive).toBe(true);
    expect(sibling!.alive).toBe(true);
    expect(world.log.all().filter(e => e.type === 'provisioned' && e.actors[0] === sibling!.id).length).toBeGreaterThan(1);
    expect(Math.abs(waterBudgetResidual(world.patches, world.waterBudget))).toBeLessThan(1e-4);
  });
});
