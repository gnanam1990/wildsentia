import { describe, expect, it } from 'vitest';
import { createRng, patchCentre, type Illness } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { createWorld } from '../src/world.js';
import { takeSnapshot, restoreSnapshot } from '../src/snapshot.js';
import { executeGoal } from '../src/agents/behaviours.js';
import { makeCarcass } from '../src/fields/decomposition.js';
import { EventLog } from '../src/events/log.js';
import { makeAgent, makeServices, makeView, speciesOf, SPECIES_DIR } from './helpers.js';

function carrionMeal(seconds: number, pathogenLoad = 1) {
  const patches = buildGrid(1), patch = patches[210]!;
  const centre = patchCentre(patch.id);
  const agent = makeAgent('jackal', { patchId: patch.id,
    position: { ...centre, heading: 0 },
    drives: { hunger: 0.8, thirst: 0, fatigue: 0, fear: 0 } });
  const carcass = makeCarcass('carc_illness', 'chital_dead', 'chital', patch.id, 0,
    'natural', 'high', 100);
  carcass.position = { ...centre, x: centre.x + 20 };
  carcass.pathogenLoad = pathogenLoad;
  const carcasses = [carcass], log = new EventLog(1, 'sim_test');
  const view = makeView(patches, [agent], carcasses);
  const rng = createRng(2, 'forced-infection');
  rng.bool = () => true;
  executeGoal({ agent, species: speciesOf('jackal'), patches, view,
    percept: { patch, neighbours: [], bestFood: null, bestWater: null, prey: [],
      carrion: { carcass, patchId: patch.id }, threat: null, dangerous: new Set(), herdSize: 1 },
    choice: { goal: 'scavenge', score: 1, alternative: null }, hours: seconds / 3600,
    worldTime: 0, log, rng, services: makeServices(carcasses) });
  return { agent, carcass, log, patches };
}

function episode(overrides: Partial<Illness> = {}): Illness {
  return { kind: 'carrion_infection', phase: 'active', sourceCarcassId: 'carc_source',
    sourceMealEventId: 'scavenged_meal', contractedEventId: 'disease_contracted_source',
    onsetEventId: 'disease_symptomatic_source', acquiredAt: 0, incubationUntil: 3600,
    lastUpdatedAt: 3600, severity: 0.8, recoveryRemainingHours: 100,
    mortalityBudget: 100, ...overrides };
}

describe('authoritative carrion illness lifecycle', () => {
  it('contracts from a real world meal, delays symptoms and replays the same episode after restart', () => {
    const opts = { seed: 37, speciesDir: SPECIES_DIR, initialAgents: { jackal: 1 }, minPopulation: {} };
    const world = createWorld(opts), agent = world.agents[0]!;
    const patch = world.patches.find(p => p.habitat === 'grassland')!;
    agent.patchId = patch.id; agent.position = { ...patchCentre(patch.id), heading: 0 };
    agent.drives = { hunger: 0.8, thirst: 0, fatigue: 0, fear: 0 };
    const carcass = makeCarcass('carc_source', 'chital_dead', 'chital', patch.id, 0,
      'natural', 'high', 100);
    carcass.position = { ...agent.position }; carcass.pathogenLoad = 1;
    world.carcasses.push(carcass);
    const nutrients = world.totalNutrients();
    world.step(1);
    const meal = world.log.all().find(e => e.type === 'scavenged')!;
    const contracted = world.log.all().find(e => e.type === 'disease_contracted')!;
    expect(contracted).toBeDefined();
    expect(contracted.causalParents).toEqual([meal.id]);
    expect(agent.illness).toMatchObject({ phase: 'incubating', lastUpdatedAt: world.now() });
    expect(world.log.all().some(e => e.type === 'disease_symptomatic')).toBe(false);
    expect(world.totalNutrients()).toBeCloseTo(nutrients, 6);

    const restored = restoreSnapshot(takeSnapshot(world), opts);
    world.log.take(); restored.log.take();
    for (let hour = 0; hour < 24; hour++) { world.step(1); restored.step(1); }
    expect(restored.log.all()).toEqual(world.log.all());
    expect(takeSnapshot(restored)).toEqual(takeSnapshot(world));
    const symptomatic = world.log.all().find(e => e.type === 'disease_symptomatic')!;
    expect(symptomatic).toBeDefined();
    expect(symptomatic.causalParents).toEqual([contracted.id]);
  });

  it('exposes only after a completed positive-mass carcass meal and links to that meal', () => {
    const approach = carrionMeal(1);
    expect(approach.log.all().some(e => e.type === 'scavenged')).toBe(false);
    expect(approach.agent.illness).toBeUndefined();
    const clean = carrionMeal(3600, 0);
    expect(clean.log.all().some(e => e.type === 'scavenged')).toBe(true);
    expect(clean.agent.illness).toBeUndefined();
    const infected = carrionMeal(3600);
    const meal = infected.log.all().find(e => e.type === 'scavenged')!;
    const contracted = infected.log.all().find(e => e.type === 'disease_contracted')!;
    expect(meal.effects.kg).toBeGreaterThan(0);
    expect(infected.carcass.consumers).toMatchObject([{ agentId: infected.agent.id, kg: meal.effects.kg }]);
    expect(contracted.causalParents).toEqual([meal.id]);
    expect(contracted.conditions.sourceMealEventId).toBe(meal.id);
    expect(infected.agent.illness).toMatchObject({ sourceCarcassId: infected.carcass.id,
      sourceMealEventId: meal.id, contractedEventId: contracted.id, lastUpdatedAt: meal.worldTime });
  });

  it('settles a fatal episode into one disease death and carcass without nutrient loss', () => {
    const opts = { seed: 11, speciesDir: SPECIES_DIR, initialAgents: { jackal: 1 }, minPopulation: {} };
    const world = createWorld(opts), agent = world.agents[0]!;
    world.step(1);
    agent.illness = episode({ mortalityBudget: 0 });
    agent.drives = { hunger: 0.1, thirst: 0.1, fatigue: 0, fear: 0 };
    const before = world.totalNutrients();
    world.log.take(); world.step(1);
    const fatal = world.log.all().filter(e => e.type === 'disease_fatal');
    const death = world.log.all().filter(e => e.type === 'died' && e.actors[0] === agent.id);
    const created = world.log.all().filter(e => e.type === 'carcass_created' && e.actors[1] === agent.id);
    expect(fatal).toHaveLength(1); expect(death).toHaveLength(1); expect(created).toHaveLength(1);
    expect(death[0]!.conditions.cause).toBe('disease');
    expect(death[0]!.causalParents).toEqual([fatal[0]!.id]);
    expect(death[0]!.worldTime).toBe(world.now());
    expect(world.carcasses.filter(c => c.originId === agent.id)).toHaveLength(1);
    expect(world.totalNutrients()).toBeCloseTo(before, 6);
  });

  it('recovers at decision end and resumes the same persisted illness path after restart', () => {
    const opts = { seed: 12, speciesDir: SPECIES_DIR, initialAgents: { jackal: 1 }, minPopulation: {} };
    const world = createWorld(opts); world.step(1);
    world.agents[0]!.illness = episode({ recoveryRemainingHours: 0.1 });
    const restored = restoreSnapshot(takeSnapshot(world), opts);
    world.log.take(); restored.log.take();
    world.step(1); restored.step(1);
    expect(restored.log.all()).toEqual(world.log.all());
    expect(restored.agents).toEqual(world.agents);
    expect(world.log.all().filter(e => e.type === 'disease_recovered')).toHaveLength(1);
    expect(world.agents[0]!.illness).toBeUndefined();
    expect(world.log.all().some(e => e.type === 'died' && e.conditions.cause === 'disease')).toBe(false);
  });
});
