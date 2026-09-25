import { describe, expect, it } from 'vitest';
import { createRng, waterAccessPosition } from '@vana/shared';
import { executeGoal } from '../src/agents/behaviours.js';
import { selectGoal } from '../src/agents/goals.js';
import { allowsDependentGoal, canDrinkIndependently, canFollowParent, canHuntIndependently,
  needsOf, needsProvisioning } from '../src/agents/needs.js';
import { perceive } from '../src/agents/perception.js';
import { EventLog } from '../src/events/log.js';
import { waterBudgetResidual } from '../src/fields/drainage.js';
import { buildGrid } from '../src/grid.js';
import { createWorld } from '../src/world.js';
import { makeAgent, makeServices, makeView, SPECIES_DIR, speciesOf } from './helpers.js';

const tiger = speciesOf('tiger');

function cub(ageDays: number) {
  const access = waterAccessPosition(0);
  return makeAgent('tiger', { id: 'tiger_cub', ageDays,
    lifeStage: ageDays < 90 ? 'newborn' : 'juvenile',
    massKg: tiger.body.adultMassKg * 0.12, dependentOn: 'tiger_mother',
    position: { ...access, x: access.x + 100 },
    drives: { hunger: 0.1, thirst: 0.9, fatigue: 0, fear: 0 } });
}

describe('tiger mobile-cub water gate', () => {
  it('unlocks only direct drinking at day 70, not weaning, foraging, or hunting', () => {
    const before = cub(69 + 23 / 24), at = cub(70), later = cub(179), weaned = cub(180);
    expect(tiger.lifecycle).toMatchObject({ followFromDays: 56, drinkFromDays: 70, weanDays: 180 });
    expect(canFollowParent(before, tiger)).toBe(true);
    expect(canDrinkIndependently(before, tiger)).toBe(false);
    expect(canDrinkIndependently(at, tiger)).toBe(true);
    for (const child of [before, at, later]) {
      expect(needsProvisioning(child, tiger)).toBe(true);
      expect(canHuntIndependently(child, tiger)).toBe(false);
      expect(allowsDependentGoal(child, tiger, 'hunt')).toBe(false);
      expect(allowsDependentGoal(child, tiger, 'find_food')).toBe(false);
    }
    expect(allowsDependentGoal(before, tiger, 'find_water')).toBe(false);
    expect(allowsDependentGoal(at, tiger, 'find_water')).toBe(true);
    expect(needsProvisioning(weaned, tiger)).toBe(false);
    // Life-stage dependence still bars a 180-day juvenile from hunting.
    expect(canHuntIndependently(weaned, tiger)).toBe(false);
  });

  it('rejects an underage forced water action without moving or crediting water', () => {
    const patches = buildGrid(1), child = cub(69), view = makeView(patches, [child]);
    const log = new EventLog(1, 'test'), percept = perceive(child, tiger, view);
    const start = { ...child.position! }, volume = patches[0]!.waterVolume, thirst = child.drives.thirst;
    expect(selectGoal(child, tiger, percept, createRng(1, 'tiger-underage-choice')).goal).toBe('rest');
    executeGoal({ agent: child, species: tiger, patches, view, percept, log,
      rng: createRng(1, 'tiger-underage-exec'), services: makeServices([]),
      choice: { goal: 'find_water', score: 1, alternative: null }, hours: 1, worldTime: 0 });
    expect(child.position).toEqual(start);
    expect(child.drives.thirst).toBe(thirst);
    expect(patches[0]!.waterVolume).toBe(volume);
    expect(log.all().some(event => event.type === 'moved' || event.type === 'drank')).toBe(false);
  });

  it('requires a completed route and real contact, then withdraws only finite patch water', () => {
    const patches = buildGrid(1), child = cub(70), initialWater = patches[0]!.waterVolume;
    patches[0]!.habitat = 'grassland';
    const view = makeView(patches, [child]), log = new EventLog(1, 'test');
    const percept = perceive(child, tiger, view);
    const choice = selectGoal(child, tiger, percept, createRng(1, 'tiger-water-choice'));
    expect(choice.goal).toBe('find_water');
    const start = { ...child.position! }, thirst = child.drives.thirst;
    let consumed = 0;
    const services = makeServices([]);
    services.consumedWater = litres => { consumed += litres; };
    executeGoal({ agent: child, species: tiger, patches, view, percept, choice, log,
      rng: createRng(1, 'tiger-water-exec'), services, hours: 1, worldTime: 0 });
    const move = log.all().find(event => event.type === 'moved');
    const drink = log.all().find(event => event.type === 'drank');
    expect(move?.movement?.completed).toBe(true);
    expect(drink?.causalParents).toEqual([move!.id]);
    expect(drink?.position).toBeDefined();
    expect(Number(drink!.effects.litres)).toBeGreaterThan(0);
    expect(child.position).not.toEqual(start);
    expect(initialWater - patches[0]!.waterVolume).toBeCloseTo(Number(drink!.effects.litres));
    expect(consumed).toBeCloseTo(Number(drink!.effects.litres));
    expect(thirst - child.drives.thirst).toBeCloseTo(Number(drink!.effects.litres) / needsOf(child, tiger).waterL * 0.4);
    expect(child.dependentOn).toBe('tiger_mother');
  });

  it('does not give water from an empty source or an incomplete route', () => {
    for (const mode of ['empty', 'incomplete'] as const) {
      const patches = buildGrid(1), child = cub(70);
      patches[0]!.habitat = 'grassland';
      if (mode === 'empty') for (const patch of patches) patch.waterVolume = 0;
      const species = mode === 'incomplete'
        ? { ...tiger, locomotion: { ...tiger.locomotion, walkMs: 0.001 } } : tiger;
      const view = makeView(patches, [child]), log = new EventLog(1, 'test');
      const initialWater = patches[0]!.waterVolume, thirst = child.drives.thirst;
      const services = makeServices([]);
      let consumed = 0;
      services.consumedWater = litres => { consumed += litres; };
      executeGoal({ agent: child, species, patches, view, percept: perceive(child, species, view),
        choice: { goal: 'find_water', score: 1, alternative: null }, log,
        rng: createRng(1, `tiger-${mode}`), services, hours: 1, worldTime: 0 });
      expect(log.all().some(event => event.type === 'drank')).toBe(false);
      expect(child.drives.thirst).toBe(thirst);
      expect(patches[0]!.waterVolume).toBe(initialWater);
      expect(consumed).toBe(0);
    }
  });

  it('cannot withdraw more than a nearly empty contacted freshwater patch holds', () => {
    const patches = buildGrid(1), child = cub(70);
    for (const patch of patches) patch.waterVolume = 0;
    patches[0]!.waterVolume = 0.02;
    child.position = { ...waterAccessPosition(0) };
    const view = makeView(patches, [child]), log = new EventLog(1, 'test');
    const services = makeServices([]);
    let consumed = 0;
    services.consumedWater = litres => { consumed += litres; };
    executeGoal({ agent: child, species: tiger, patches, view, percept: perceive(child, tiger, view),
      choice: { goal: 'find_water', score: 1, alternative: null }, log,
      rng: createRng(1, 'tiger-limited-water'), services, hours: 1, worldTime: 0 });
    const drink = log.all().find(event => event.type === 'drank');
    expect(drink).toBeDefined();
    expect(Number(drink!.effects.litres)).toBeCloseTo(0.02);
    expect(consumed).toBeCloseTo(0.02);
    expect(patches[0]!.waterVolume).toBe(0);
    expect(child.drives.thirst).toBeGreaterThan(0);
  });

  it('does not inherit boar-only litter rendezvous when a mother plans care', () => {
    const world = createWorld({ seed: 1, speciesDir: SPECIES_DIR,
      initialAgents: { tiger: 2 }, minPopulation: {} });
    const [mother, child] = world.agents;
    mother!.sex = 'female';
    mother!.drives = { hunger: 0.2, thirst: 0.2, fatigue: 0, fear: 0 };
    Object.assign(child!, cub(70), { id: child!.id, dependentOn: mother!.id, motherId: mother!.id });
    child!.drives = { hunger: 0.3, thirst: 0.3, fatigue: 0, fear: 0 };
    mother!.offspringIds = [child!.id]; mother!.patchId = child!.patchId;
    mother!.position = { ...child!.position! };
    world.step(1);
    const drink = world.log.all().find(event => event.type === 'drank' && event.actors[0] === child!.id);
    expect(drink).toBeDefined();
    expect(world.log.all().some(event => event.type === 'moved'
      && event.actors[0] === child!.id && event.goal === 'follow_parent')).toBe(false);
    expect(Number(drink!.effects.litres)).toBeGreaterThan(0);
    expect(world.waterBudget.animalConsumptionL).toBeGreaterThanOrEqual(Number(drink!.effects.litres));
    expect(child!.dependentOn).toBe(mother!.id);
    expect(needsProvisioning(child!, tiger)).toBe(true);
    expect(Math.abs(waterBudgetResidual(world.patches, world.waterBudget))).toBeLessThan(1e-4);
  });
});
