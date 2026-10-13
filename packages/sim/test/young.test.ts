import { describe, expect, it } from 'vitest';
import { createRng } from '@vana/shared';
import { allowsDependentGoal, canForageIndependently, canHuntIndependently, locomotionFactor, needsOf, needsProvisioning, provisionYoung } from '../src/agents/needs.js';
import { selectGoal } from '../src/agents/goals.js';
import { executeGoal } from '../src/agents/behaviours.js';
import { perceive } from '../src/agents/perception.js';
import { buildGrid } from '../src/grid.js';
import { EventLog } from '../src/events/log.js';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot, upgradeV6Snapshot } from '../src/snapshot.js';
import { HUNGER_PER_DAY, THIRST_PER_DAY } from '../src/agents/drives.js';
import { makeAgent, makeServices, makeView, SPECIES_DIR, speciesOf } from './helpers.js';
import { asLegacySnapshot } from './legacySnapshot.js';
import { ISLAND_GRID } from '@vana/shared';

const cfg = speciesOf('dhole');
const pup = () => makeAgent('dhole', { id: 'pup', ageDays: 10, lifeStage: 'newborn',
  massKg: cfg.body.adultMassKg * 0.12, dependentOn: 'parent', position: { x: 0, z: 0, heading: 0 } });
const donor = (overrides: Parameters<typeof makeAgent>[1] = {}) => makeAgent('dhole',
  { id: 'parent', position: { x: 0.5, z: 0, heading: 0 }, ...overrides });

describe('young physiology and ability policy', () => {
  it.each([null, 'mother'])('allows pre-weaning hare foraging from day eight without adult abilities; parent=%s', dependentOn => {
    const spec = speciesOf('hare'), patches = buildGrid(1);
    const child = makeAgent('hare', { ageDays: 8, lifeStage: 'newborn', massKg: 0.3, dependentOn,
      position: { x: 0, z: 0, heading: 0 }, drives: { hunger: 0.95, thirst: 0, fear: 0, fatigue: 0 } });
    const view = makeView(patches, [child]), log = new EventLog(1, 'test');
    expect(needsProvisioning(child, spec)).toBe(true);
    expect(canForageIndependently(child, spec)).toBe(true);
    expect(canHuntIndependently(child, spec)).toBe(false);
    expect(locomotionFactor(child, spec)).toBeLessThan(0.5);
    for (const goal of ['hunt', 'scavenge', 'wander', 'breed'] as const) expect(allowsDependentGoal(child, spec, goal)).toBe(false);
    const context = { agent: child, species: spec, patches, view, percept: perceive(child, spec, view), log,
      rng: createRng(1, 'early-forage'), hours: 1, worldTime: 0, services: makeServices([]) };
    expect(selectGoal(child, spec, context.percept, createRng(1, 'goals')).goal).toBe('find_food');
    const before = child.drives.hunger;
    executeGoal({ ...context, choice: { goal: 'find_food', score: 1, alternative: null } });
    const fed = log.all().find(e => e.type === 'fed')!;
    expect(Number(fed.effects.kg)).toBeGreaterThan(0);
    expect(before - child.drives.hunger).toBeCloseTo(Number(fed.effects.kg) / needsOf(child, spec).foodKg * HUNGER_PER_DAY);
    child.drives.hunger = 0; child.drives.thirst = 0.95;
    expect(selectGoal(child, spec, context.percept, createRng(1, 'goals')).goal).toBe('find_water');
    executeGoal({ ...context, choice: { goal: 'find_water', score: 1, alternative: null } });
    expect(Number(log.all().find(e => e.type === 'drank')!.effects.litres)).toBeGreaterThan(0);
    expect(child.dependentOn).toBe(dependentOn);
  });
  it.each(['find_food', 'find_water'] as const)('cannot force %s before the early-foraging threshold', goal => {
    const spec = speciesOf('hare'), patches = buildGrid(1);
    const child = makeAgent('hare', { ageDays: 8 - 1 / 24, lifeStage: 'newborn', massKg: 0.3,
      dependentOn: null, position: { x: 0, z: 0, heading: 0 }, drives: { hunger: 0.9, thirst: 0.9, fear: 0, fatigue: 0 } });
    const view = makeView(patches, [child]), percept = perceive(child, spec, view), log = new EventLog(1, 'test');
    expect(canForageIndependently(child, spec)).toBe(false);
    expect(selectGoal(child, spec, percept, createRng(1, 'goals')).goal).toBe('rest');
    const before = { hunger: child.drives.hunger, thirst: child.drives.thirst };
    executeGoal({ agent: child, species: spec, patches, view, percept, log, rng: createRng(1, 'execute'),
      hours: 1, worldTime: 0, services: makeServices([]), choice: { goal, score: 1, alternative: null } });
    expect(child.currentGoal).toBe('rest'); expect(child.drives).toMatchObject(before);
    expect(log.all().some(e => e.type === 'fed' || e.type === 'drank')).toBe(false);
  });
  it('preserves adult needs and speed but scales a young body', () => {
    const adult = makeAgent('dhole');
    expect(needsOf(adult, cfg)).toEqual({ foodKg: cfg.diet.dailyIntakeKg, waterL: cfg.diet.waterNeedLPerDay });
    expect(locomotionFactor(adult, cfg)).toBe(1);
    expect(needsOf(pup(), cfg).foodKg).toBeCloseTo(cfg.diet.dailyIntakeKg * 0.12 ** 0.75);
    expect(locomotionFactor(pup(), cfg)).toBeLessThan(0.5);
    expect(canHuntIndependently(pup(), cfg)).toBe(false);
    const juvenile = { ...pup(), ageDays: 100, lifeStage: 'juvenile' as const, dependentOn: null };
    expect(canHuntIndependently(juvenile, cfg)).toBe(false);
    expect(canHuntIndependently({ ...juvenile, ageDays: 400, lifeStage: 'subadult' }, cfg)).toBe(true);
  });

  it('transfers exact equivalent reserves without resetting drives or changing mass', () => {
    const parent = donor(), child = pup();
    const source = needsOf(parent, cfg), target = needsOf(child, cfg);
    const hunger = parent.drives.hunger, thirst = parent.drives.thirst;
    const childHunger = child.drives.hunger, childThirst = child.drives.thirst;
    const result = provisionYoung(ISLAND_GRID, parent, child, cfg, 1);
    expect(result.foodEquivalentKg).toBeGreaterThan(0);
    expect(result.waterEquivalentL).toBeGreaterThan(0);
    expect((parent.drives.hunger - hunger) * source.foodKg / HUNGER_PER_DAY)
      .toBeCloseTo((childHunger - child.drives.hunger) * target.foodKg / HUNGER_PER_DAY, 12);
    expect((parent.drives.thirst - thirst) * source.waterL / THIRST_PER_DAY)
      .toBeCloseTo((childThirst - child.drives.thirst) * target.waterL / THIRST_PER_DAY, 12);
    expect(parent.massKg).toBe(cfg.body.adultMassKg);
    expect(child.massKg).toBe(pup().massKg);
  });

  it('never overdraws a donor even for a large hungry litter', () => {
    const parent = donor({ drives: { hunger: 0.799, thirst: 0.799, fatigue: 0, fear: 0 } });
    let supplied = 0;
    for (let i = 0; i < 20; i++) supplied += provisionYoung(ISLAND_GRID, parent, pup(), cfg, 24).foodEquivalentKg;
    expect(supplied).toBeGreaterThan(0);
    expect(parent.drives.hunger).toBeCloseTo(0.8, 12);
    expect(parent.drives.thirst).toBeCloseTo(0.8, 12);
    expect(provisionYoung(ISLAND_GRID, parent, pup(), cfg, 24)).toEqual({ foodEquivalentKg: 0, waterEquivalentL: 0 });
  });

  it('cannot provision from a dead, absent, unrelated or remote parent or after weaning', () => {
    for (const parent of [makeAgent('dhole', { id: 'parent', alive: false }),
      makeAgent('dhole', { id: 'other' }), makeAgent('dhole', { id: 'parent', patchId: 1 }),
      makeAgent('tiger', { id: 'parent' })]) {
      expect(provisionYoung(ISLAND_GRID, parent, pup(), cfg, 1).foodEquivalentKg).toBe(0);
    }
    const child = pup(); child.ageDays = cfg.lifecycle.weanDays;
    expect(provisionYoung(ISLAND_GRID, makeAgent('dhole', { id: 'parent' }), child, cfg, 1).foodEquivalentKg).toBe(0);
  });

  it('does not let an orphan select or execute an adult hunt', () => {
    const child = pup(); child.dependentOn = null; child.drives.hunger = 0.95;
    const patches = buildGrid(1), prey = makeAgent('chital');
    const view = makeView(patches, [child, prey]);
    const percept = perceive(child, cfg, view), log = new EventLog(1, 'test');
    expect(selectGoal(child, cfg, percept, createRng(1, 'goal')).goal).toBe('rest');
    executeGoal({ agent: child, species: cfg, patches, view, percept, log, rng: createRng(1, 'hunt'),
      choice: { goal: 'hunt', score: 1, alternative: null }, hours: 1, worldTime: 0, services: makeServices([]) });
    expect(child.currentGoal).toBe('rest'); expect(prey.alive).toBe(true);
    expect(log.all().some((e) => e.type === 'hunt')).toBe(false);
  });

  it('lets weaned young choose their own age-sized food and water while retaining family identity', () => {
    const child = makeAgent('chital', { ageDays: 200, lifeStage: 'juvenile', dependentOn: 'mother', massKg: 10,
      drives: { hunger: 0.95, thirst: 0, fatigue: 0, fear: 0 } });
    const patches = buildGrid(1), spec = speciesOf('chital'), view = makeView(patches, [child]);
    expect(selectGoal(child, spec, perceive(child, spec, view), createRng(1, 'g')).goal).toBe('find_food');
    expect(child.dependentOn).toBe('mother');
    const before = child.drives.hunger, log = new EventLog(1, 'test');
    const context = { agent: child, species: spec, patches, view, percept: perceive(child, spec, view),
      log, rng: createRng(1, 'feed'), hours: 1, worldTime: 0, services: makeServices([]) };
    executeGoal({ ...context, choice: { goal: 'find_food', score: 1, alternative: null } });
    const fed = log.all().find((e) => e.type === 'fed')!;
    expect(fed.effects.kg).toBeGreaterThan(0);
    expect(before - child.drives.hunger).toBeCloseTo(fed.effects.kg! / needsOf(child, spec).foodKg * HUNGER_PER_DAY);
    child.drives.thirst = 0.5;
    executeGoal({ ...context, choice: { goal: 'find_water', score: 1, alternative: null } });
    const drank = log.all().find((e) => e.type === 'drank')!;
    expect(drank.effects.litres).toBeCloseTo(0.5 / THIRST_PER_DAY * needsOf(child, spec).waterL);
  });
});

describe('young in the authoritative world', () => {
  function family() {
    const options = { seed: 5, speciesDir: SPECIES_DIR, initialAgents: { dhole: 2 }, minPopulation: {} };
    const world = createWorld(options);
    const [parent, child] = world.agents;
    parent!.sex = 'female'; parent!.pregnantSince = null;
    Object.assign(child!, pup(), { id: child!.id, dependentOn: parent!.id, motherId: parent!.id, patchId: parent!.patchId });
    child!.position = { ...parent!.position! };
    parent!.drives = { hunger: 0.2, thirst: 0.2, fatigue: 0.2, fear: 0 };
    parent!.offspringIds = [child!.id];
    return { world, parent: parent!, child: child!, options };
  }

  it('records provisioning, conserves nutrients and resumes deterministically', () => {
    const { world, child, parent, options } = family();
    const nutrients = world.totalNutrients();
    world.step(1);
    const event = world.log.all().find((e) => e.type === 'provisioned');
    expect(event?.actors).toEqual([child.id, parent.id]);
    expect(event?.effects.foodEquivalentKg).toBeGreaterThan(0);
    expect(world.totalNutrients()).toBeCloseTo(nutrients, 6);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(world))), options);
    world.log.take();
    for (let i = 0; i < 24; i++) { world.step(1); restored.step(1); }
    expect(restored.agents).toEqual(world.agents);
    expect(restored.log.all()).toEqual(world.log.all());
    expect(world.totalNutrients()).toBeCloseTo(nutrients, 6);
  });

  it('records orphanhood once, never conjures milk, and never gives a newborn a hunt', () => {
    const { world, parent, child } = family();
    parent.drives.hunger = 1;
    world.step(1); world.step(1);
    expect(child.dependentOn).toBeNull();
    expect(child.drives.hunger).toBeGreaterThan(0.2);
    expect(world.log.all().filter((e) => e.type === 'parent_lost' && e.actors[0] === child.id)).toHaveLength(1);
    expect(world.log.all().some((e) => e.type === 'provisioned')).toBe(false);
    expect(world.log.all().some((e) => e.type === 'hunt' && e.actors[0] === child.id)).toBe(false);
    child.drives.thirst = 1; world.step(1);
    const death = world.log.all().find((e) => e.type === 'died' && e.actors[0] === child.id)!;
    expect(death.conditions).toMatchObject({ cause: 'dehydration', careState: 'unweaned_without_parent', lifeStage: 'newborn' });
  });

  it('requires explicit v0.6 upgrade and leaves the source checkpoint intact', () => {
    const { world, options } = family();
    const old = asLegacySnapshot(takeSnapshot(world), 'sim_0.6.0'), before = JSON.stringify(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV6Snapshot(old);
    expect(restoreSnapshot(upgraded, options).agents).toEqual(world.agents);
    expect(JSON.stringify(old)).toBe(before);
    expect(() => upgradeV6Snapshot({ ...old, simVersion: 'sim_0.5.0' })).toThrow();
  });
});
