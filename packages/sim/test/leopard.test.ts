import { describe, expect, it } from 'vitest';
import { GRID_SIZE, createRng, patchCentre, treeAnchorForPatch, type Agent } from '@vana/shared';
import { createWorld, type World } from '../src/world.js';
import { ISLAND_POPULATION, FOREST_POPULATION } from '../src/forest.js';
import { canReachCarcass, heldByPredatorOf, perceive, threatens } from '../src/agents/perception.js';
import { selectGoal } from '../src/agents/goals.js';
import { choosePrey } from '../src/agents/predation.js';
import { executeGoal, subdueSecondsFor } from '../src/agents/behaviours.js';
import { locomotionFactor } from '../src/agents/needs.js';
import { targetMass } from '../src/agents/lifecycle.js';
import { makeAgent, makeServices, makeView, SPECIES_DIR, speciesOf } from './helpers.js';

const leopard = speciesOf('leopard');
// Mainland grid, seed 4: patches 210 and 211 are neighbouring land, x 10 and 11 of row 10.
const P = 10 * GRID_SIZE + 10, Q = P + 1;
const calm = { hunger: 0, thirst: 0, fatigue: 0, fear: 0 };
function scene(agents: Record<string, number>, seed = 4): { world: World; get: (species: string, i?: number) => Agent } {
  const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: agents, minPopulation: {} });
  for (const patch of world.patches) patch.waterVolume = 0;
  return { world, get: (species, i = 0) => world.agents.filter(a => a.speciesId === species)[i]! };
}
const place = (world: World, agent: Agent, patchId: number, dx: number, extra: Partial<Agent> = {}) => {
  const c = patchCentre(patchId);
  Object.assign(agent, { patchId, position: { x: c.x + dx, z: c.z, heading: 0 }, drives: { ...calm }, ...extra });
  delete agent.gutKg;
  world.__reindexForTest();
};

describe('the island leopard (sim_0.37.0): config from field data', () => {
  it('has sexed body masses, a 0.7 m shoulder, climbs trees and eats a calibrated ration', () => {
    expect(leopard.id).toBe('leopard');
    expect(leopard.archetype).toBe('apex_predator');
    // Prater: males 50-77 kg, females 29-34; Odden & Wegge 2005 (Bardia): 36 kg female, 44-58 kg
    // males, shoulder 70-75 cm.
    expect(leopard.body.massBySexKg).toEqual({ female: 34, male: 58 });
    expect(leopard.body.adultMassKg).toBe(46);
    expect(leopard.body.shoulderHeightM).toBe(0.7);
    expect(leopard.locomotion.climbsTrees).toBe(true);
    expect(leopard.locomotion.walkMs).toBe(1.0); // Hubel et al. 2018: about 1 m/s
    // Odden & Wegge 2009: a female with cubs ate 4.0 kg a day; maintenance 1.6-4.9 kg.
    expect(leopard.diet.dailyIntakeKg).toBeGreaterThanOrEqual(1.6);
    expect(leopard.diet.dailyIntakeKg).toBeLessThanOrEqual(4.9);
    // Balme et al. 2013: litters of 1-3, independence at 19 months; gestation about 96 days.
    expect(leopard.lifecycle.litterSize).toEqual([1, 3]);
    expect(leopard.lifecycle.gestationDays).toBe(96);
    expect(leopard.lifecycle.dispersalDays).toBe(570);
    expect(leopard.lifecycle.meatFromDays).toBeLessThan(leopard.lifecycle.weanDays);
    // Hayward et al. 2006: preferred prey 10-40 kg. Its Jacobs' indices for Asian prey (chital
    // +0.34, wild pig -0.39) rest on three studies and are not significant, so, as for the dhole,
    // no species weighting is applied: leopards take each kind as they meet it.
    expect(leopard.hunting!.preferredPreyKg).toEqual([10, 40]);
    expect(leopard.hunting!.preyPreference).toBeUndefined();
    expect(leopard.hunting!.preferredPrey).toEqual(expect.arrayContaining(['chital', 'boar', 'langur', 'hare', 'jackal', 'sambar']));
  });

  it('is founded on the island as a male and a female, each at its own sex\'s mass, and on the mainland at 11 per 100 km²', () => {
    expect(ISLAND_POPULATION.leopard).toBe(2);
    expect(FOREST_POPULATION.leopard).toBe(4);
    for (const seed of [1, 2, 3, 7]) {
      const world = createWorld({ seed, speciesDir: SPECIES_DIR, terrainProfile: 'island_v1', initialAgents: { leopard: 2 }, minPopulation: {} });
      const cats = world.agents.filter(a => a.speciesId === 'leopard');
      expect(cats.map(a => a.sex).sort()).toEqual(['female', 'male']);
      for (const cat of cats) {
        expect(cat.massKg).toBe(leopard.body.massBySexKg![cat.sex]);
        expect(targetMass(cat, leopard)).toBe(cat.massKg);
        // A full-grown leopardess runs at full speed: legs are measured against her own sex.
        expect(locomotionFactor(cat, leopard)).toBe(1);
      }
    }
  });
});

describe('leopards keep away from tigers (intraguild avoidance)', () => {
  it('detects a tiger, flees it, and does not hunt in the patch where the tiger stands', () => {
    const { world, get } = scene({ leopard: 1, tiger: 1, chital: 3 });
    const cat = get('leopard'), tiger = get('tiger');
    place(world, cat, P, 100, { drives: { ...calm, hunger: 0.6 } });
    place(world, tiger, Q, -100);
    for (let i = 0; i < 3; i++) place(world, get('chital', i), Q, -60 + i * 5);
    const view = world.__viewForTest();
    const percept = perceive(cat, leopard, view);
    expect(percept.threat).toMatchObject({ patchId: Q });
    expect(percept.dangerous.has(Q)).toBe(true);
    // The chital stand beside the tiger: not prey for a leopard that is not starving.
    expect(percept.prey).toEqual([]);
    // The same chital, the tiger gone: prey again.
    tiger.patchId = 0; tiger.position = { ...patchCentre(0), heading: 0 }; world.__reindexForTest();
    expect(perceive(cat, leopard, world.__viewForTest()).prey.length).toBe(3);
    // A starving leopard hunts where it must.
    place(world, tiger, Q, -100);
    cat.drives.hunger = 0.85;
    expect(perceive(cat, leopard, world.__viewForTest()).prey.length).toBe(3);
  });

  it('can flee a tiger it detects, while a tiger, which nothing hunts, never gains the goal', () => {
    const { world, get } = scene({ leopard: 1, tiger: 1 });
    const cat = get('leopard'), tiger = get('tiger');
    // A tiger walking in the open 100 m off, inside the leopard's 150 m sight.
    place(world, cat, P, 100); place(world, tiger, Q, -100, { currentGoal: 'wander', state: 'travelling' });
    const percept = perceive(cat, leopard, world.__viewForTest());
    cat.drives.fear = Math.max(0.6, percept.threat!.fear);
    const choice = selectGoal(cat, leopard, percept, createRng(1, 'flee'));
    expect(choice.goal).toBe('flee');
    const tigerPercept = perceive(tiger, speciesOf('tiger'), world.__viewForTest());
    expect(tigerPercept.threat).toBeNull();
    tiger.drives.fear = 1;
    for (let i = 0; i < 50; i++) expect(selectGoal(tiger, speciesOf('tiger'), tigerPercept, createRng(i, 't')).goal).not.toBe('flee');
  });

  it('climbs its patch\'s tree to escape a tiger in the same patch', () => {
    const { world, get } = scene({ leopard: 1, tiger: 1 });
    const treed = world.patches.find(p => treeAnchorForPatch(p) && p.neighbours.length === 4)!;
    const cat = get('leopard'), tiger = get('tiger');
    place(world, cat, treed.id, 40); place(world, tiger, treed.id, -10, { currentGoal: 'wander', state: 'travelling' });
    const view = world.__viewForTest();
    const percept = perceive(cat, leopard, view);
    expect(percept.threat?.patchId).toBe(treed.id);
    cat.drives.fear = 1;
    const log = world.log;
    executeGoal({ agent: cat, species: leopard, patches: world.patches, view, percept,
      choice: { goal: 'flee', score: 1, alternative: null }, hours: 1, worldTime: world.now(), log, rng: createRng(2, 'climb'),
      services: makeServices([]) });
    const climb = log.all().find(e => e.type === 'tree_climbed' && e.actors[0] === cat.id);
    expect(climb?.outcome).toBe('success');
    expect(cat.altitudeM).toBeGreaterThan(0);
    // Up the tree, it is no prey for the tiger's planar hunt.
    expect(perceive(tiger, speciesOf('tiger'), world.__viewForTest()).prey.map(p => p.agent.id)).not.toContain(cat.id);
  });

  it('does not wander into a patch where it has detected a tiger', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { world, get } = scene({ leopard: 1, tiger: 1 }, 4);
      const cat = get('leopard'), tiger = get('tiger');
      place(world, cat, P, 100); place(world, tiger, Q, -100);
      const view = world.__viewForTest();
      executeGoal({ agent: cat, species: leopard, patches: world.patches, view, percept: perceive(cat, leopard, view),
        choice: { goal: 'wander', score: 1, alternative: null }, hours: 1, worldTime: world.now(), log: world.log,
        rng: createRng(seed, 'wander'), services: makeServices([]) });
      const moved = world.log.all().find(e => e.type === 'moved' && e.actors[0] === cat.id);
      expect(moved?.conditions.destination).not.toBe(Q);
    }
  });

  it('avoids tigers without being their prey, and keeps off a carcass a tiger is holding', () => {
    // Tigers killing leopards is reported only anecdotally; no rate was found to calibrate it, so
    // the model has leopards avoid tigers (Odden et al. 2010) but tigers do not hunt them.
    expect(leopard.escape.avoids).toEqual(['tiger']);
    expect(speciesOf('tiger').hunting!.preferredPrey).not.toContain('leopard');
    expect(threatens(speciesOf('tiger'), leopard)).toBe(true);
    expect(threatens(leopard, speciesOf('tiger'))).toBe(false);
    expect(threatens(speciesOf('dhole'), leopard)).toBe(false);
    // A carcass a tiger fed from within the hour is the tiger's: the leopard does not feed there.
    const kill = { id: 'c1', originId: 'x', speciesId: 'chital', patchId: Q, diedAt: 0, originalMassKg: 70,
      cause: 'predation' as const, causeConfidence: 'authoritative' as const,
      biomass: { muscle: 30, organ: 8, hide: 10, bone: 20 }, decayStage: 1 as const, pathogenLoad: 0, scentRadiusM: 200,
      consumers: [{ agentId: 'tiger_x', at: 3600, kg: 5 }] };
    const view = { ...makeView([], []), agentById: (id: string) => id === 'tiger_x' ? makeAgent('tiger', { id }) : undefined };
    expect(heldByPredatorOf(kill, 'leopard', 3600, view)).toBe(true);
    expect(heldByPredatorOf(kill, 'boar', 3600, view)).toBe(true);
    expect(heldByPredatorOf(kill, 'dhole', 3600, view)).toBe(false);
  });
});

describe('leopard hunting and the recorded hold', () => {
  it('takes the piglet before the sow and passes over prey heavier than it will tackle', () => {
    const rng = createRng(9, 'size');
    const sow = { agent: makeAgent('boar', { id: 'sow', massKg: 75 }), patchId: 0, herdSize: 3 };
    const piglet = { agent: makeAgent('boar', { id: 'piglet', massKg: 26, lifeStage: 'juvenile', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } }), patchId: 0, herdSize: 3 };
    for (let i = 0; i < 50; i++) expect(choosePrey([sow, piglet], rng, {}, leopard.hunting!.preferredPreyKg).agent.id).toBe('piglet');
    // Without a preferred size the most vulnerable (here the tired sow) is taken.
    sow.agent.drives.fatigue = 0.9;
    expect(choosePrey([sow, piglet], rng).agent.id).toBe('sow');

    const { world, get } = scene({ leopard: 1, sambar: 2 });
    const cat = get('leopard'), stag = get('sambar', 0), fawn = get('sambar', 1);
    place(world, cat, P, 0, { drives: { ...calm, hunger: 0.6 } });
    place(world, stag, P, 20); place(world, fawn, P, 25, { massKg: 26, ageDays: 20, lifeStage: 'newborn' });
    const prey = perceive(cat, leopard, world.__viewForTest()).prey.map(p => p.agent.id);
    expect(prey).toEqual([fawn.id]);
  });

  it('holds small prey for seconds and a chital-sized one for minutes', () => {
    expect(subdueSecondsFor(leopard.hunting!, 2.5, 1)).toBeLessThan(10);
    expect(subdueSecondsFor(leopard.hunting!, 20, 1)).toBeLessThanOrEqual(20);
    expect(subdueSecondsFor(leopard.hunting!, 70, 1)).toBeGreaterThan(60);
    expect(subdueSecondsFor(leopard.hunting!, 70, 1)).toBeLessThanOrEqual(180);
    expect(leopard.hunting!.subdueBreakFree).toBe(0.2);
  });

  it('kills with a recorded subdue hold, the prey dying at its end, and feeds after it', () => {
    let seen = false;
    for (let seed = 1; seed <= 60 && !seen; seed++) {
      const { world, get } = scene({ leopard: 1, chital: 4 }, seed);
      const cat = get('leopard');
      place(world, cat, P, -20, { drives: { ...calm, hunger: 0.6 } });
      for (let i = 0; i < 4; i++) place(world, get('chital', i), P, 5 + i * 3);
      world.step(1);
      const hunt = world.log.all().find(e => e.type === 'hunt' && e.actors[0] === cat.id && e.outcome === 'success');
      if (!hunt) continue;
      seen = true;
      const samples = hunt.encounter!.samples;
      expect(samples.at(-1)!.phase).toBe('subdue');
      expect(samples.some(s => s.phase === 'contact')).toBe(true);
      const died = world.log.all().find(e => e.type === 'died' && e.actors[0] === hunt.actors[1])!;
      expect(died.worldTime).toBe(hunt.worldTime);
      expect(hunt.worldTime).toBe(Math.floor(hunt.encounter!.startWorldTime + samples.at(-1)!.seconds));
      const fed = world.log.all().find(e => e.type === 'fed' && e.actors[0] === cat.id);
      expect(Number(fed?.effects.kg)).toBeGreaterThan(0);
    }
    expect(seen).toBe(true);
  });

  it('does not spend its hunts on hares while deer are in view, unless starving', () => {
    const picks: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const { world, get } = scene({ leopard: 1, hare: 6, chital: 1 }, seed);
      const cat = get('leopard');
      place(world, cat, P, -40, { drives: { ...calm, hunger: 0.6 } });
      for (let i = 0; i < 6; i++) place(world, get('hare', i), P, 10 + i * 4);
      place(world, get('chital'), P, 30);
      world.step(1);
      const hunt = world.log.all().find(e => e.type === 'hunt' && e.actors[0] === cat.id);
      if (hunt) picks.push(String(hunt.conditions.preySpecies));
    }
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every(p => p === 'chital')).toBe(true);
  });
});

describe('a leopard caches its kill in a tree (Balme et al. 2017)', () => {
  it('only she and her young can feed from a cached kill', () => {
    let seen = false;
    for (let seed = 1; seed <= 80 && !seen; seed++) {
      const { world, get } = scene({ leopard: 2, chital: 4, boar: 2 }, seed);
      const treed = world.patches.find(p => treeAnchorForPatch(p) && p.neighbours.length === 4)!;
      const [cat, cub] = [get('leopard', 0), get('leopard', 1)];
      place(world, cat, treed.id, -20, { drives: { ...calm, hunger: 0.6 } });
      place(world, cub, P, 0, { dependentOn: cat.id, motherId: cat.id, ageDays: 150, lifeStage: 'juvenile', massKg: 18 });
      for (let i = 0; i < 4; i++) place(world, get('chital', i), treed.id, 5 + i * 3);
      for (let i = 0; i < 2; i++) place(world, get('boar', i), P, 40 + i * 3);
      world.step(1);
      const hunt = world.log.all().find(e => e.type === 'hunt' && e.actors[0] === cat.id && e.outcome === 'success');
      if (!hunt) continue;
      seen = true;
      expect(hunt.conditions.cachedInTree).toBe(1);
      const carcass = world.carcasses.find(c => c.originId === hunt.actors[1])!;
      expect(carcass.cachedBy).toBe(cat.id);
      world.__reindexForTest();
      const view = world.__viewForTest();
      // The same carcass uncached is open to a hungry pig standing over it.
      const open = { ...carcass, cachedBy: undefined };
      expect(canReachCarcass(open, get("boar", 0))).toBe(true);
      const pig = get('boar', 0);
      const near = { ...pig, patchId: carcass.patchId, position: { ...carcass.position! }, drives: { ...calm, hunger: 0.9 } };
      expect(perceive(near, speciesOf('boar'), view).carrion).toBeNull();
      const kitten = { ...cub, patchId: carcass.patchId, position: { ...carcass.position! }, ageDays: 150 };
      expect(perceive(kitten, leopard, view).carrion?.carcass.id).toBe(carcass.id);
    }
    expect(seen).toBe(true);
  });
});

describe('a cat mother hunts for her weaned cubs (sim_0.37.0)', () => {
  it('hunts while sated when the cubs she feeds at her kills are hungry, and not otherwise', () => {
    const { world, get } = scene({ leopard: 1, chital: 3 });
    const mother = get('leopard');
    place(world, mother, P, -20, { drives: { ...calm, hunger: 0.1 } });
    for (let i = 0; i < 3; i++) place(world, get('chital', i), P, 10 + i * 3);
    mother.gutKg = 2;
    const percept = perceive(mother, leopard, world.__viewForTest());
    expect(percept.prey.length).toBe(3);
    const hunts = (litterHunger: number) => {
      let n = 0;
      for (let i = 0; i < 40; i++) if (selectGoal(mother, leopard, percept, createRng(i, 'litter'), litterHunger).goal === 'hunt') n++;
      return n;
    };
    expect(hunts(0)).toBe(0);
    expect(hunts(0.2)).toBe(0); // below the hunting hunger
    expect(hunts(0.7)).toBeGreaterThan(20);
  });
});
