import { describe, expect, it } from 'vitest';
import { edibleMass, patchCentre } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { makeCarcass } from '../src/fields/decomposition.js';
import { SPECIES_DIR } from './helpers.js';

/** A fed tiger beside a 120 kg kill. `fedFrom` says whether it has already eaten from it. */
function tigerAtKill(fedFrom: boolean, cause: 'predation' | 'natural' = 'predation') {
  const world = createWorld({ seed: 4, speciesDir: SPECIES_DIR, initialAgents: { tiger: 1 }, minPopulation: {} });
  const tiger = world.agents[0]!;
  Object.assign(tiger, { patchId: 210, position: { ...patchCentre(210), heading: 0 },
    drives: { hunger: 0.02, thirst: 0, fatigue: 0, fear: 0 } });
  const carcass = makeCarcass('carc_kill', 'sambar_x', 'sambar', 210, 0, cause, 'authoritative', 120);
  carcass.position = { ...patchCentre(210), x: patchCentre(210).x + 40, heading: 0 };
  if (fedFrom) carcass.consumers.push({ agentId: tiger.id, at: 0, kg: 10 });
  world.carcasses.push(carcass);
  return { world, tiger, carcass };
}

describe('a hunter stays with its unfinished kill (sim_0.33.0)', () => {
  it('feeds again from a kill it has eaten from instead of wandering off', () => {
    const { world, tiger, carcass } = tigerAtKill(true);
    const before = edibleMass(carcass.biomass);
    world.step(1);
    expect(tiger.currentGoal).toBe('scavenge');
    const meal = world.log.all().find(e => e.type === 'scavenged' && e.actors[0] === tiger.id);
    expect(meal?.conditions.carcassId).toBe('carc_kill');
    expect(edibleMass(carcass.biomass)).toBeLessThan(before);
    expect(Math.hypot(tiger.position!.x - carcass.position!.x, tiger.position!.z - carcass.position!.z)).toBeLessThan(2);
  });

  it('does not hold an idle hunter at a carcass it never fed from, or at one it did not kill', () => {
    for (const [fedFrom, cause] of [[false, 'predation'], [true, 'natural']] as const) {
      const { world, tiger } = tigerAtKill(fedFrom, cause);
      world.step(1);
      expect(tiger.currentGoal, `${fedFrom} ${cause}`).not.toBe('scavenge');
    }
  });

  it('lets the kill go once it has rotted past what the hunter will eat', () => {
    const { world, tiger, carcass } = tigerAtKill(true);
    carcass.pathogenLoad = world.species.get('tiger')!.diet.carrionTolerance + 0.01;
    world.step(1);
    expect(tiger.currentGoal).not.toBe('scavenge');
  });
});
