import { describe, expect, it } from 'vitest';
import { patchCentre } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { ISLAND_POPULATION } from '../src/forest.js';
import { isFloater } from '../src/agents/territory.js';
import { careRadius } from '../src/agents/needs.js';
import { makeAgent, SPECIES_DIR, speciesOf } from './helpers.js';

const dhole = speciesOf('dhole');

const MORNING = 7;

/** A pack with a mother whose pups are `pupDays` old, lying 40 m from her in the next patch. */
function denWorld(seed: number, pupDays: number) {
  const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: { dhole: 5, chital: 10 }, minPopulation: {} });
  world.step(MORNING); // sim_0.37.0: dholes hunt by day; start at 07:00
  const dholes = world.agents.filter(a => a.speciesId === 'dhole');
  const mother = dholes[0]!, pups = dholes.slice(3);
  const den = patchCentre(210);
  world.agents.forEach((a, i) => {
    a.patchId = 211;
    a.position = { x: patchCentre(211).x + i * 3, z: den.z, heading: 0 };
    a.drives = { hunger: 0.6, thirst: 0.1, fatigue: 0, fear: 0 };
    delete a.gutKg;
  });
  mother.sex = 'female';
  mother.patchId = 210; mother.position = { x: den.x + 40, z: den.z, heading: 0 };
  for (const pup of pups) Object.assign(pup, makeAgent('dhole', { id: pup.id, ageDays: pupDays, lifeStage: 'newborn',
    dependentOn: mother.id, motherId: mother.id, massKg: 17 * 0.12, patchId: 210, groupId: mother.groupId,
    position: { x: den.x, z: den.z + (pup === pups[0] ? 0 : 0.2), heading: 0 }, drives: { hunger: 0.1, thirst: 0.05, fatigue: 0, fear: 0 } }));
  mother.offspringIds = pups.map(p => p.id);
  world.__reindexForTest();
  return { world, mother, pups };
}

describe('dhole den mother and founding pack (sim_0.37.0)', () => {
  it('founds the island with one pack of five, none of them a floater wherever the leader stands', () => {
    // Indian packs run 5-12 (Tadoba 6.4 +- 1.3: Bhandari et al. 2021; Bandipur 8.3 adults:
    // Johnsingh 1982). The island held four before; its land now holds the smallest working pack.
    expect(ISLAND_POPULATION.dhole).toBe(5);
    const world = createWorld({ seed: 2, speciesDir: SPECIES_DIR, terrainProfile: 'island_v1', initialAgents: { dhole: 5 }, minPopulation: {} });
    const pack = world.agents.filter(a => a.speciesId === 'dhole');
    expect(new Set(pack.map(a => a.groupId)).size).toBe(1);
    expect(pack.filter(a => isFloater(a, dhole, pack, world.patches))).toEqual([]);
    expect(dhole.lifecycle.denStayDays).toBe(60);
  });

  it('a mother of young pups stays at the den instead of hunting, and goes back to it', () => {
    for (const seed of [1, 2, 3]) {
      const { world, mother, pups } = denWorld(seed, 12);
      let atDen = 0;
      for (let h = 0; h < 18; h++) {
        mother.drives.hunger = Math.max(mother.drives.hunger, 0.6);
        world.step(1);
        expect(world.log.all().some(e => e.type === 'hunt' && (e.actors[0] === mother.id
          || String(e.conditions.packmateIds ?? '').split(',').includes(mother.id)))).toBe(false);
        const den = pups.find(p => p.alive)!;
        if (mother.patchId === den.patchId) atDen++;
        if (h === 17 && mother.patchId === den.patchId) expect(Math.hypot(mother.position!.x - den.position!.x, mother.position!.z - den.position!.z))
          .toBeLessThanOrEqual(mother.currentGoal === 'find_water' ? 300 : careRadius(dhole) + 1e-6);
      }
      // She stays in the den's patch, leaving the den itself only to drink at its pool (the run starts
      // at 07:00, sim_0.37.0, and so spans her drinking hours).
      expect(atDen).toBeGreaterThanOrEqual(16);
    }
  });

  it('hunts again once her hunger is desperate, and once her pups are past the denning months', () => {
    let desperateHunts = 0, olderHunts = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const desperate = denWorld(seed, 12);
      const older = denWorld(seed, 65);
      for (let h = 0; h < 12; h++) {
        desperate.mother.drives.hunger = 0.85; older.mother.drives.hunger = Math.max(older.mother.drives.hunger, 0.6);
        desperate.world.step(1); older.world.step(1);
      }
      desperateHunts += desperate.world.log.all().filter(e => e.type === 'hunt' && e.actors[0] === desperate.mother.id).length;
      olderHunts += older.world.log.all().filter(e => e.type === 'hunt' && (e.actors[0] === older.mother.id
        || String(e.conditions.packmateIds ?? '').split(',').includes(older.mother.id))).length;
    }
    expect(desperateHunts).toBeGreaterThan(0);
    expect(olderHunts).toBeGreaterThan(0);
  });

  it('applies only to a species whose pack feeds the mother', () => {
    const jackal = speciesOf('jackal');
    expect(jackal.lifecycle.denStayDays).toBeUndefined();
    expect(speciesOf('tiger').lifecycle.denStayDays).toBeUndefined();
  });
});
