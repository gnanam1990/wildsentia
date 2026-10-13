import { describe, expect, it } from 'vitest';
import { createRng, isMovementTrace, patchCentre, type Agent } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { perceive } from '../src/agents/perception.js';
import { selectGoal } from '../src/agents/goals.js';
import { isCarried } from '../src/agents/needs.js';
import { makeAgent, SPECIES_DIR, speciesOf } from './helpers.js';
import { ISLAND_GRID } from '@vana/shared';

const langur = speciesOf('langur');
const P = 10 * ISLAND_GRID.cols + 10, Q = P + 1;

/** A langur mother with a clinging infant, and a hunting tiger across the patch edge. */
function scene(seed: number, infantDays: number) {
  const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: { langur: 2, tiger: 1 }, minPopulation: {} });
  for (const patch of world.patches) { patch.waterVolume = 0; patch.canopyCover = 0.1; }
  const [mother, infant] = world.agents.filter(a => a.speciesId === 'langur') as [Agent, Agent];
  const tiger = world.agents.find(a => a.speciesId === 'tiger')!;
  const c = patchCentre(ISLAND_GRID, P), q = patchCentre(ISLAND_GRID, Q);
  Object.assign(mother, { sex: 'female', patchId: P, position: { x: c.x + 120, z: c.z, heading: 0 },
    drives: { hunger: 0.1, thirst: 0.1, fatigue: 0, fear: 0 }, offspringIds: [infant.id] });
  Object.assign(infant, makeAgent('langur', { id: infant.id, ageDays: infantDays, lifeStage: 'newborn', dependentOn: mother.id,
    motherId: mother.id, massKg: 13 * 0.1, patchId: P, groupId: mother.groupId, position: { x: c.x + 120.2, z: c.z, heading: 0 },
    drives: { hunger: 0.2, thirst: 0.2, fatigue: 0, fear: 0 } }));
  Object.assign(tiger, { patchId: Q, position: { x: q.x - 130, z: q.z, heading: 0 }, currentGoal: 'hunt', state: 'stalking',
    drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } });
  world.__reindexForTest();
  return { world, mother, infant };
}

describe('a langur infant clings to its mother and is carried (sim_0.37.0)', () => {
  it('is carried for its first four weeks (Dolhinow & Murphy 1982)', () => {
    expect(langur.lifecycle.carriedUntilDays).toBe(28);
    expect(isCarried(makeAgent('langur', { ageDays: 6, dependentOn: 'm' }), langur)).toBe(true);
    expect(isCarried(makeAgent('langur', { ageDays: 30, dependentOn: 'm' }), langur)).toBe(false);
    expect(isCarried(makeAgent('chital', { ageDays: 6, dependentOn: 'm' }), speciesOf('chital'))).toBe(false);
  });

  it('does not flee on its own when frightened; it clings', () => {
    const { world, infant } = scene(3, 6);
    infant.drives.fear = 0.9;
    const percept = perceive(infant, langur, world.__viewForTest());
    for (let i = 0; i < 20; i++) expect(selectGoal(infant, langur, percept, createRng(i, 'cling')).goal).toBe('rest');
  });

  it('goes where its fleeing mother goes, along her route, and stays in contact', () => {
    let carried = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { world, mother, infant } = scene(seed, 6);
      world.step(1);
      const fled = world.log.all().find(e => (e.type === 'fled' || e.type === 'moved') && e.actors[0] === mother.id);
      if (!fled) continue;
      carried++;
      const ride = world.log.all().find(e => e.type === 'moved' && e.actors[0] === infant.id && e.conditions.reason === 'carried')!;
      expect(ride.actors).toEqual([infant.id, mother.id]);
      expect(ride.causalParents).toEqual([fled.id]);
      expect(isMovementTrace(ISLAND_GRID, ride.movement)).toBe(true);
      expect(ride.movement!.samples.map(s => s.position)).toEqual(fled.movement!.samples.map(s => s.position));
      expect(infant.patchId).toBe(mother.patchId);
      expect(Math.hypot(infant.position!.x - mother.position!.x, infant.position!.z - mother.position!.z)).toBeLessThan(1);
    }
    expect(carried).toBeGreaterThan(5);
  });

  it('a five-week-old infant is not carried: it follows on its own feet', () => {
    const { world, mother, infant } = scene(4, 35);
    world.step(1);
    expect(world.log.all().some(e => e.actors[0] === infant.id && e.conditions.reason === 'carried')).toBe(false);
    expect(mother.offspringIds).toContain(infant.id);
  });
});

describe('a carried infant stays with its carrier for the rest of the hour', () => {
  it('does not walk back to where its mother set off once she has carried it', () => {
    // Calm, and too thirsty to care for it, she goes to drink and carries the infant there.
    let carried = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: { langur: 2 }, minPopulation: {} });
      for (const patch of world.patches) { patch.waterVolume = patch.id === Q ? 5e5 : 0; patch.canopyCover = 0.1; }
      const [mother, infant] = world.agents.filter(a => a.speciesId === 'langur') as [Agent, Agent];
      const c = patchCentre(ISLAND_GRID, P);
      Object.assign(mother, { sex: 'female', patchId: P, position: { x: c.x + 120, z: c.z, heading: 0 },
        drives: { hunger: 0.1, thirst: 0.8, fatigue: 0, fear: 0 }, offspringIds: [infant.id] });
      Object.assign(infant, makeAgent('langur', { id: infant.id, ageDays: 6, lifeStage: 'newborn', dependentOn: mother.id,
        motherId: mother.id, massKg: 13 * 0.1, patchId: P, groupId: mother.groupId, position: { x: c.x + 120.2, z: c.z, heading: 0 },
        drives: { hunger: 0.2, thirst: 0.2, fatigue: 0, fear: 0 } }));
      world.__reindexForTest();
      world.step(1);
      const ride = world.log.all().find(e => e.type === 'moved' && e.actors[0] === infant.id && e.conditions.reason === 'carried');
      if (!ride) continue;
      carried++;
      const own = world.log.all().filter(e => (e.type === 'moved' || e.type === 'fled') && e.actors[0] === infant.id && e !== ride);
      expect(own).toEqual([]);
      expect(infant.patchId).toBe(mother.patchId);
      expect(Math.hypot(infant.position!.x - mother.position!.x, infant.position!.z - mother.position!.z)).toBeLessThan(1);
    }
    expect(carried).toBeGreaterThan(20);
  });
});
