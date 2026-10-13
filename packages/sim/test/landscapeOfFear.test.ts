import { describe, expect, it } from 'vitest';
import { patchCentre, type Agent } from '@vana/shared';
import { createWorld, type World } from '../src/world.js';
import { perceive, threatFear } from '../src/agents/perception.js';
import { selectGoal } from '../src/agents/goals.js';
import { createRng } from '@vana/shared';
import { restoreSnapshot, takeSnapshot, upgradeV33Snapshot } from '../src/snapshot.js';
import { SPECIES_DIR } from './helpers.js';
import { ISLAND_GRID } from '@vana/shared';

// Mainland grid, seed 4: patches 210 and 211 are neighbouring land, x 10 and 11 of row 10.
const P = 10 * ISLAND_GRID.cols + 10, Q = P + 1;
const calm = { hunger: 0, thirst: 0, fatigue: 0, fear: 0 };
function scene(agents: Record<string, number>): { world: World; get: (species: string, i?: number) => Agent } {
  const world = createWorld({ seed: 4, speciesDir: SPECIES_DIR, initialAgents: agents, minPopulation: {} });
  for (const patch of world.patches) { patch.waterVolume = 0; }
  const get = (species: string, i = 0) => world.agents.filter(a => a.speciesId === species)[i]!;
  return { world, get };
}
const place = (world: World, agent: Agent, patchId: number, dx: number, extra: Partial<Agent> = {}) => {
  const c = patchCentre(ISLAND_GRID, patchId);
  Object.assign(agent, { patchId, position: { x: c.x + dx, z: c.z, heading: 0 }, drives: { ...calm }, ...extra });
  world.__reindexForTest();
};

describe('a landscape of fear (sim_0.34.0)', () => {
  it('scales fear by how close the predator is and what it is visibly doing', () => {
    const chital = { detectionDistanceM: 110, flightInitiationM: 55 };
    expect(threatFear('hunting', 0, 45, chital)).toBe(1);
    expect(threatFear('hunting', 45, 45, chital)).toBeCloseTo(0.6);
    // A predator walking in the open: run inside the escape detection distance, else keep watch.
    expect(threatFear('moving', 0, 160, chital)).toBeCloseTo(0.7);
    expect(threatFear('moving', 110, 160, chital)).toBeCloseTo(0.5);
    expect(threatFear('moving', 120, 160, chital)).toBeLessThan(0.5);
    // A resting one: step away inside the flight-initiation distance, else vigilance only.
    expect(threatFear('settled', 50, 160, chital)).toBe(0.5);
    expect(threatFear('settled', 60, 160, chital)).toBeLessThan(0.5);
    expect(threatFear('settled', 160, 160, chital)).toBeCloseTo(0.2);
  });

  it('a chital flees that hour from a hunting tiger it spots across the patch edge', () => {
    const { world, get } = scene({ chital: 1, tiger: 1 });
    const chital = get('chital'), tiger = get('tiger');
    // 40 m apart across the boundary: inside the 45 m at which a stalking tiger (concealment
    // 0.72) is noticed by a chital that sees 160 m.
    place(world, chital, P, 130); place(world, tiger, Q, -130, { currentGoal: 'hunt', state: 'stalking' });
    const percept = perceive(chital, world.species.get('chital')!, world.__viewForTest());
    expect(percept.threat).toMatchObject({ patchId: Q, posture: 'hunting' });
    expect(percept.threat!.fear).toBeGreaterThan(0.6);
    // Concealment: the same stalking tiger 100 m off is not noticed at all.
    place(world, tiger, Q, -70, { currentGoal: 'hunt', state: 'stalking' });
    expect(perceive(chital, world.species.get('chital')!, world.__viewForTest()).threat).toBeNull();
    place(world, tiger, Q, -130, { currentGoal: 'hunt', state: 'stalking', drives: { ...calm, hunger: 0 } });
    const startX = chital.position!.x;
    world.step(1);
    expect(chital.currentGoal).toBe('flee');
    expect(chital.patchId).not.toBe(Q);
    expect(chital.position!.x).toBeLessThan(startX);
  });

  it('a chital beside a resting, fed tiger keeps its distance but goes on grazing', () => {
    const { world, get } = scene({ chital: 1, tiger: 1 });
    const chital = get('chital'), tiger = get('tiger');
    // 80 m off: outside the chital's 55 m flight-initiation distance, inside its 160 m senses.
    place(world, chital, P, 40, { drives: { ...calm, hunger: 0.6 } });
    place(world, tiger, P, -40, { state: 'resting', currentGoal: 'rest' });
    const percept = perceive(chital, world.species.get('chital')!, world.__viewForTest());
    expect(percept.threat).toMatchObject({ posture: 'settled' });
    expect(percept.threat!.fear).toBeLessThan(0.5);
    expect(percept.dangerous.has(P)).toBe(true);
    expect(percept.bestFood?.patchId).not.toBe(P);
    world.step(1);
    expect(chital.currentGoal).toBe('find_food');
    expect(chital.patchId).not.toBe(P);
    expect(chital.drives.hunger).toBeLessThan(0.6);
  });

  it('chooses a pool no predator stands at, unless thirst is desperate', () => {
    const { world, get } = scene({ chital: 1, tiger: 1 });
    const chital = get('chital'), tiger = get('tiger'), cfg = world.species.get('chital')!;
    world.patches[P]!.waterVolume = 5000; world.patches[Q]!.waterVolume = 800;
    place(world, chital, P, 60, { drives: { ...calm, thirst: 0.5 } });
    place(world, tiger, P, -40, { state: 'drinking', currentGoal: 'find_water' });
    expect(perceive(chital, cfg, world.__viewForTest()).bestWater?.patchId).toBe(Q);
    chital.drives.thirst = 0.75;
    expect(perceive(chital, cfg, world.__viewForTest()).bestWater?.patchId).toBe(P);
  });

  it('chital take up a langur\'s alarm at a tiger they cannot themselves detect', () => {
    for (const withLangur of [true, false]) {
      const { world, get } = scene(withLangur ? { chital: 1, langur: 1, tiger: 1 } : { chital: 1, tiger: 1 });
      const chital = get('chital'), tiger = get('tiger');
      place(world, chital, P, 140, { drives: { ...calm, hunger: 0.3 } });
      place(world, tiger, P, -60, { state: 'resting', currentGoal: 'rest' });
      if (withLangur) place(world, get('langur'), P, -10);
      world.step(1);
      // 200 m is beyond what a chital senses (160 m); the langur, 50 m from the tiger, calls.
      if (withLangur) expect(chital.drives.fear, 'with langur').toBeGreaterThan(0);
      else expect(chital.drives.fear, 'alone').toBe(0);
    }
  });

  it('a pup too young to follow lies still instead of running from a hunting tiger; an older one runs', () => {
    const { world, get } = scene({ jackal: 2, tiger: 1 });
    const mother = get('jackal', 0), pup = get('jackal', 1), tiger = get('tiger');
    const cfg = world.species.get('jackal')!;
    place(world, mother, P, 0);
    place(world, pup, P, 10, { dependentOn: mother.id, motherId: mother.id, ageDays: 20, lifeStage: 'newborn', massKg: 1 });
    place(world, tiger, P, -20, { currentGoal: 'hunt', state: 'stalking' });
    pup.drives.fear = 0.9;
    const percept = perceive(pup, cfg, world.__viewForTest());
    expect(percept.threat?.posture).toBe('hunting');
    expect(selectGoal(pup, cfg, percept, createRng(1, 't')).goal).toBe('rest');
    // A weaned, independent jackal in the same spot runs.
    Object.assign(pup, { dependentOn: null, ageDays: cfg.lifecycle.weanDays + 1, lifeStage: 'juvenile' });
    expect(selectGoal(pup, cfg, perceive(pup, cfg, world.__viewForTest()), createRng(1, 't')).goal).toBe('flee');
  });

  it('opts a real v0.33 world in without rewriting its state', () => {
    const options = { seed: 4, speciesDir: SPECIES_DIR, initialAgents: { chital: 3 }, minPopulation: {} };
    const current = takeSnapshot(createWorld(options));
    const old = structuredClone(current); old.simVersion = 'sim_0.33.0';
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV33Snapshot(old);
    expect(upgraded).toEqual(current);
    expect(old).toEqual(before);
    expect(() => upgradeV33Snapshot(upgraded)).toThrow(/only sim_0.33.0/);
  });
});
