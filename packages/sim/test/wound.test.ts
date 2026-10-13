import { describe, expect, it } from 'vitest';
import { createRng, patchAtPosition, patchCentre, type Carcass, type Wound } from '@vana/shared';
import { resolveSpatialHunt, type SpatialHuntInput } from '../src/agents/encounters.js';
import { exposeToContactWound, advanceWound, woundMobilityFactor } from '../src/agents/wound.js';
import { locomotionFactor } from '../src/agents/needs.js';
import { EventLog } from '../src/events/log.js';
import { createWorld } from '../src/world.js';
import { takeSnapshot, restoreSnapshot } from '../src/snapshot.js';
import { makeAgent, speciesOf, SPECIES_DIR } from './helpers.js';
import { buildGrid } from '../src/grid.js';
import { executeGoal } from '../src/agents/behaviours.js';
import { makeServices, makeView } from './helpers.js';
import { ISLAND_GRID } from '@vana/shared';

const contactInput: SpatialHuntInput = { grid: ISLAND_GRID,
  predatorId: 'tiger_a', preyId: 'chital_a', patchId: 0, worldTime: 3600,
  predator: { x: 0, z: 0, heading: 0 }, prey: { x: 20, z: 0, heading: 0 },
  predatorWalkMs: 1, predatorSprintMs: 10, preySprintMs: 1, preyTrotMs: 0.5,
  predatorSprintSeconds: 25, preySprintSeconds: 40, contactRadiusM: 1,
  secondsAvailable: 3600, chaseStaminaCost: 0.34,
  contest: { baseSuccess: 0, stalkConcealment: 1, canopyCover: 1, predatorStamina: 1,
    predatorCondition: 1, preyEvasiveness: 0, preyCondition: 1, preyAlert: false,
    herdSize: 1, commitDistanceM: 10 },
};

function attemptedHunt(input: SpatialHuntInput = contactInput) {
  const outcome = resolveSpatialHunt(input, createRng(3, 'wound-contact'));
  const last = outcome.trace.samples.at(-1)!;
  const prey = makeAgent('chital', { id: input.preyId, patchId: patchAtPosition(ISLAND_GRID, last.prey),
    position: { ...last.prey } });
  const log = new EventLog(3, 'sim_test');
  const hunt = log.append({ type: 'hunt', worldTime: input.worldTime + last.seconds,
    simVersion: '', patchId: prey.patchId, actors: [input.predatorId, input.preyId],
    conditions: { stage: outcome.stage }, outcome: outcome.killed ? 'success' : 'failure',
    effects: {}, causalParents: [], confidence: 'authoritative', encounter: outcome.trace });
  const rng = createRng(4, 'forced-wound'); rng.bool = () => true;
  return { outcome, prey, log, hunt, rng };
}

function episode(overrides: Partial<Wound> = {}): Wound {
  return { kind: 'contact_injury', phase: 'open', sourceHuntEventId: 'hunt_source',
    woundEventId: 'wounded_source', acquiredAt: 0, lastUpdatedAt: 3600,
    severity: 0.4, recoveryRemainingHours: 100, infectionBudget: 100,
    mortalityBudget: 100, ...overrides };
}

describe('contact-grounded survivor wound', () => {
  it('wires the actual hunt behaviour to the survivor injury after its recorded contact', () => {
    const patches = buildGrid(12), patch = patches.find(candidate => candidate.habitat === 'grassland')!;
    const centre = patchCentre(ISLAND_GRID, patch.id);
    const predator = makeAgent('tiger', { patchId: patch.id,
      position: { ...centre, x: centre.x - 8, heading: Math.PI / 2 } });
    const prey = makeAgent('chital', { patchId: patch.id,
      position: { ...centre, heading: Math.PI / 2 } });
    const species = { ...speciesOf('tiger'), hunting: { ...speciesOf('tiger').hunting!, baseSuccess: 0 } };
    const log = new EventLog(12, 'sim_test'), rng = createRng(12, 'forced-contact-wound');
    let rolls = 0;
    rng.bool = () => ++rolls === 4;
    const carcasses: Carcass[] = [];
    executeGoal({ agent: predator, species, patches, view: makeView(patches, [predator, prey]),
      percept: { patch, neighbours: [], bestFood: null, bestWater: null,
        prey: [{ agent: prey, patchId: patch.id, herdSize: 1 }], carrion: null,
        threat: null, dangerous: new Set(), herdSize: 1 }, choice: { goal: 'hunt', score: 1, alternative: null },
      hours: 1, worldTime: 3600, log, rng, services: makeServices(carcasses) });
    const hunt = log.all().find(event => event.type === 'hunt')!;
    const wound = log.all().find(event => event.type === 'wounded')!;
    expect(hunt.conditions.stage).toBe('escaped');
    expect(hunt.encounter?.samples.some(sample => sample.phase === 'contact')).toBe(true);
    expect(wound.causalParents).toEqual([hunt.id]);
    expect(prey.wound?.woundEventId).toBe(wound.id);
    expect(carcasses).toHaveLength(0);
  });
  it('uses a real failed physical contact and links one bounded episode to the hunt', () => {
    const { outcome, prey, log, hunt, rng } = attemptedHunt();
    expect(outcome.stage).toBe('escaped');
    expect(outcome.trace.samples.some(sample => sample.phase === 'contact')).toBe(true);
    expect(exposeToContactWound(ISLAND_GRID, prey, hunt, 7200, rng, log)).toBe(true);
    const wound = log.all().find(event => event.type === 'wounded')!;
    expect(wound.causalParents).toEqual([hunt.id]);
    expect(wound.position).toEqual(prey.position);
    expect(prey.wound).toMatchObject({ sourceHuntEventId: hunt.id,
      woundEventId: wound.id, lastUpdatedAt: 7200 });
    expect(exposeToContactWound(ISLAND_GRID, prey, hunt, 7200, rng, log)).toBe(false);
    expect(log.all().filter(event => event.type === 'wounded')).toHaveLength(1);
    expect(advanceWound(prey, 7200, log)).toBeNull();
    expect(prey.wound?.recoveryRemainingHours).toBeGreaterThan(0);
  });

  it('never wounds a no-contact chase, alerted prey, kill, wrong species or dead prey', () => {
    for (const input of [
      { ...contactInput, preySprintMs: 12 },
      { ...contactInput, secondsAvailable: 2 },
      { ...contactInput, contest: { ...contactInput.contest, baseSuccess: 1 } },
    ]) {
      const trial = attemptedHunt(input);
      expect(exposeToContactWound(ISLAND_GRID, trial.prey, trial.hunt, 7200, trial.rng, trial.log)).toBe(false);
      expect(trial.prey.wound).toBeUndefined();
    }
    const trial = attemptedHunt();
    trial.prey.speciesId = 'hare';
    expect(exposeToContactWound(ISLAND_GRID, trial.prey, trial.hunt, 7200, trial.rng, trial.log)).toBe(false);
    trial.prey.speciesId = 'chital'; trial.prey.alive = false;
    expect(exposeToContactWound(ISLAND_GRID, trial.prey, trial.hunt, 7200, trial.rng, trial.log)).toBe(false);
  });

  it('reduces actual locomotion, heals or infects at decision end from persisted budgets', () => {
    const prey = makeAgent('chital', { wound: episode({ recoveryRemainingHours: 0.2 }) });
    const healthy = makeAgent('chital');
    expect(woundMobilityFactor(prey)).toBeLessThan(1);
    expect(locomotionFactor(prey, speciesOf('chital'))).toBeLessThan(locomotionFactor(healthy, speciesOf('chital')));
    const log = new EventLog(1, 'sim_test');
    expect(advanceWound(prey, 7200, log)).toBeNull();
    expect(prey.wound).toBeUndefined();
    expect(log.all().filter(event => event.type === 'wound_healed')).toHaveLength(1);

    prey.wound = episode({ infectionBudget: 0, recoveryRemainingHours: 100 });
    expect(advanceWound(prey, 10800, log)).toBeNull();
    expect(prey.wound?.phase).toBe('infected');
    const infected = log.all().find(event => event.type === 'wound_infected')!;
    expect(infected.causalParents).toEqual(['wounded_source']);
    expect(prey.wound?.infectionEventId).toBe(infected.id);
  });

  it('persists progression across restart and settles fatal infection through one conserved carcass', () => {
    const options = { seed: 73, speciesDir: SPECIES_DIR,
      initialAgents: { chital: 1 }, minPopulation: {} };
    const world = createWorld(options); world.step(1);
    const agent = world.agents[0]!;
    agent.wound = episode({ infectionBudget: 100, recoveryRemainingHours: 1 });
    const restored = restoreSnapshot(takeSnapshot(world), options);
    world.log.take(); restored.log.take();
    for (let i = 0; i < 4; i++) { world.step(1); restored.step(1); }
    expect(restored.log.all()).toEqual(world.log.all());
    expect(takeSnapshot(restored)).toEqual(takeSnapshot(world));
    expect(world.log.all().filter(event => event.type === 'wound_healed')).toHaveLength(1);

    const fatalWorld = createWorld(options); fatalWorld.step(1);
    const victim = fatalWorld.agents[0]!;
    victim.wound = episode({ phase: 'infected', infectionEventId: 'wound_infected_source',
      recoveryRemainingHours: 100, mortalityBudget: 0 });
    const before = fatalWorld.totalNutrients();
    fatalWorld.log.take(); fatalWorld.step(1);
    const fatal = fatalWorld.log.all().filter(event => event.type === 'wound_infection_fatal');
    const deaths = fatalWorld.log.all().filter(event => event.type === 'died' && event.actors[0] === victim.id);
    expect(fatal).toHaveLength(1); expect(deaths).toHaveLength(1);
    expect(deaths[0]!.causalParents).toEqual([fatal[0]!.id]);
    expect(fatalWorld.carcasses.filter(carcass => carcass.originId === victim.id)).toHaveLength(1);
    expect(fatalWorld.totalNutrients()).toBeCloseTo(before, 6);
  });

  it('restores an infected wound without rerolling and never double-kills with concurrent carrion illness', () => {
    const options = { seed: 74, speciesDir: SPECIES_DIR,
      initialAgents: { chital: 1 }, minPopulation: {} };
    const recovering = createWorld(options); recovering.step(1);
    recovering.agents[0]!.wound = episode({ phase: 'infected', infectionEventId: 'infected_source',
      recoveryRemainingHours: 0.2, infectionBudget: 0, mortalityBudget: 100 });
    const restored = restoreSnapshot(takeSnapshot(recovering), options);
    recovering.log.take(); restored.log.take();
    recovering.step(1); restored.step(1);
    expect(restored.log.all()).toEqual(recovering.log.all());
    expect(takeSnapshot(restored)).toEqual(takeSnapshot(recovering));
    expect(recovering.log.all().filter(event => event.type === 'wound_healed')).toHaveLength(1);

    const competing = createWorld(options); competing.step(1);
    const agent = competing.agents[0]!;
    agent.wound = episode({ phase: 'infected', infectionEventId: 'infected_source',
      infectionBudget: 0, mortalityBudget: 0 });
    agent.illness = { kind: 'carrion_infection', phase: 'active', sourceCarcassId: 'carc_source',
      sourceMealEventId: 'meal_source', contractedEventId: 'contracted_source',
      onsetEventId: 'symptomatic_source', acquiredAt: 0, incubationUntil: 0,
      lastUpdatedAt: 3600, severity: 0.8, recoveryRemainingHours: 100, mortalityBudget: 0 };
    competing.log.take(); competing.step(1);
    expect(competing.log.all().filter(event => event.type === 'died' && event.actors[0] === agent.id)).toHaveLength(1);
    expect(competing.log.all().filter(event => event.type === 'wound_infection_fatal')).toHaveLength(0);
    expect(competing.carcasses.filter(carcass => carcass.originId === agent.id)).toHaveLength(1);
  });

  it('rejects malformed persisted budgets and future timestamps', () => {
    const options = { seed: 75, speciesDir: SPECIES_DIR,
      initialAgents: { chital: 1 }, minPopulation: {} };
    const snapshot = takeSnapshot(createWorld(options));
    snapshot.agents[0]!.wound = episode({ lastUpdatedAt: snapshot.worldTime + 1 });
    expect(() => restoreSnapshot(snapshot, options)).toThrow(/invalid wound/);
    snapshot.agents[0]!.wound = episode({ lastUpdatedAt: 0, infectionBudget: -1 });
    expect(() => restoreSnapshot(snapshot, options)).toThrow(/invalid wound/);
  });
});
