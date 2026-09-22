import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { NUTRIENT_PER_KG_BIOMASS, createRng, type Agent, type GoalId } from '@vana/shared';
import { loadSpeciesDir } from '../src/config/loader.js';
import { buildGrid } from '../src/grid.js';
import { perceive } from '../src/agents/perception.js';
import { executeGoal } from '../src/agents/behaviours.js';
import { EventLog } from '../src/events/log.js';

const species = loadSpeciesDir(fileURLToPath(new URL('../../../config/species', import.meta.url))).get('sambar')!;

const setup = (goal: GoalId, drives: Agent['drives']) => {
  const patches = buildGrid(11);
  // Pick a grassland patch whose neighbours hold no more food, so "best food" is here.
  const grassland = patches
    .filter((p) => p.habitat === 'grassland' && p.plant.grass > 100)
    .find((p) => p.neighbours.every((n) => patches[n]!.plant.grass <= p.plant.grass))!;
  const agent: Agent = {
    id: 'a1', speciesId: 'sambar', bornAt: 0, massKg: 220, patchId: grassland.id,
    state: 'resting', currentGoal: goal, alternativeGoal: null, goalScore: 1, drives, alive: true,
  };
  const percept = perceive(agent, patches, species);
  const log = new EventLog(1, 'sim_0.1.0');
  return {
    patches, agent, percept, log,
    ctx: {
      agent, species, patches, percept, choice: { goal, score: 1, alternative: null },
      hours: 1, worldTime: 3600, log, rng: createRng(1, 'b'),
    },
  };
};

describe('executeGoal', () => {
  it('moves biomass from the patch into the animal when feeding', () => {
    const { ctx, patches, agent } = setup('find_food', { hunger: 0.9, thirst: 0.1, fatigue: 0.1, fear: 0 });
    const before = patches[agent.patchId]!.plant.grass;
    executeGoal(ctx);
    expect(patches[agent.patchId]!.plant.grass).toBeLessThan(before);
    expect(agent.drives.hunger).toBeLessThan(0.9);
    expect(agent.state).toBe('grazing');
  });

  it('returns the nutrients it consumed to the soil, conserving mass', () => {
    const { ctx, patches, agent } = setup('find_food', { hunger: 0.9, thirst: 0.1, fatigue: 0.1, fear: 0 });
    const patch = patches[agent.patchId]!;
    const before = (patch.plant.grass + patch.plant.browse) * NUTRIENT_PER_KG_BIOMASS + patch.soilNutrients;
    executeGoal(ctx);
    const after = (patch.plant.grass + patch.plant.browse) * NUTRIENT_PER_KG_BIOMASS + patch.soilNutrients;
    expect(after).toBeCloseTo(before, 9);
  });

  it('lowers thirst and consumes water when drinking', () => {
    const { ctx, patches, agent, percept } = setup('find_water', { hunger: 0.1, thirst: 0.9, fatigue: 0.1, fear: 0 });
    patches[agent.patchId]!.waterVolume = 1000;
    percept.bestWater = { patchId: agent.patchId, litres: 1000 };
    executeGoal(ctx);
    expect(agent.drives.thirst).toBeLessThan(0.9);
    expect(patches[agent.patchId]!.waterVolume).toBeLessThan(1000);
  });

  it('sets the resting state when the goal is rest', () => {
    const { ctx, agent } = setup('rest', { hunger: 0.1, thirst: 0.1, fatigue: 0.9, fear: 0 });
    executeGoal(ctx);
    expect(agent.state).toBe('resting');
  });

  it('moves to a neighbouring patch when wandering', () => {
    const { ctx, agent, percept } = setup('wander', { hunger: 0.1, thirst: 0.1, fatigue: 0.1, fear: 0 });
    const start = agent.patchId;
    executeGoal(ctx);
    expect(percept.patch.neighbours).toContain(agent.patchId);
    expect(agent.patchId).not.toBe(start);
    expect(agent.state).toBe('travelling');
  });

  it('logs an event for every action it takes', () => {
    const { ctx, log } = setup('find_food', { hunger: 0.9, thirst: 0.1, fatigue: 0.1, fear: 0 });
    executeGoal(ctx);
    expect(log.size()).toBeGreaterThan(0);
    expect(log.all()[0]!.actors).toContain('a1');
  });
});
