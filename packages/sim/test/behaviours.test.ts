import { describe, expect, it } from 'vitest';
import {
  NUTRIENT_PER_KG_BIOMASS, carcassMass, createRng, edibleMass,
  type Carcass, type GoalId,
} from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { perceive } from '../src/agents/perception.js';
import { executeGoal } from '../src/agents/behaviours.js';
import { makeCarcass } from '../src/fields/decomposition.js';
import { EventLog } from '../src/events/log.js';
import { makeAgent, makeServices, makeView, speciesOf } from './helpers.js';

function scenario(
  speciesId: string,
  goal: GoalId,
  opts: { drives?: Partial<{ hunger: number; thirst: number; fatigue: number; fear: number }>;
          others?: ReturnType<typeof makeAgent>[]; carcasses?: Carcass[] } = {},
) {
  const patches = buildGrid(11);
  const grassland = patches
    .filter((p) => p.habitat === 'grassland' && p.plant.grass > 100)
    .find((p) => p.neighbours.every((n) => patches[n]!.plant.grass <= p.plant.grass))!;

  const agent = makeAgent(speciesId, {
    patchId: grassland.id,
    drives: { hunger: 0.2, thirst: 0.2, fatigue: 0.2, fear: 0, ...opts.drives },
  });
  const others = (opts.others ?? []).map((o) => ({ ...o, patchId: grassland.id }));
  const carcasses = (opts.carcasses ?? []).map((c) => ({ ...c, patchId: grassland.id }));

  const species = speciesOf(speciesId);
  const view = makeView(patches, [agent, ...others], carcasses);
  const percept = perceive(agent, species, view);
  const log = new EventLog(1, 'sim_test');

  return {
    patches, agent, others, carcasses, log, percept,
    ctx: {
      agent, species, patches, view, percept,
      choice: { goal, score: 1, alternative: null },
      hours: 1, worldTime: 3600, log, rng: createRng(1, 'b'),
      services: makeServices(carcasses),
    },
  };
}

describe('grazing and drinking', () => {
  it('moves biomass from the patch into the animal when feeding', () => {
    const s = scenario('sambar', 'find_food', { drives: { hunger: 0.9 } });
    const before = s.patches[s.agent.patchId]!.plant.grass;
    executeGoal(s.ctx);
    expect(s.patches[s.agent.patchId]!.plant.grass).toBeLessThan(before);
    expect(s.agent.drives.hunger).toBeLessThan(0.9);
    expect(s.agent.state).toBe('grazing');
  });

  it('returns the nutrients it consumed to the soil, conserving mass', () => {
    const s = scenario('sambar', 'find_food', { drives: { hunger: 0.9 } });
    const patch = s.patches[s.agent.patchId]!;
    const before = (patch.plant.grass + patch.plant.browse) * NUTRIENT_PER_KG_BIOMASS + patch.soilNutrients;
    executeGoal(s.ctx);
    const after = (patch.plant.grass + patch.plant.browse) * NUTRIENT_PER_KG_BIOMASS + patch.soilNutrients;
    expect(after).toBeCloseTo(before, 9);
  });

  it('lowers thirst and consumes water when drinking', () => {
    const s = scenario('sambar', 'find_water', { drives: { thirst: 0.9 } });
    s.patches[s.agent.patchId]!.waterVolume = 1000;
    s.percept.bestWater = { patchId: s.agent.patchId, litres: 1000 };
    executeGoal(s.ctx);
    expect(s.agent.drives.thirst).toBeLessThan(0.9);
    expect(s.patches[s.agent.patchId]!.waterVolume).toBeLessThan(1000);
  });

  it('drinks its fill in one visit to plentiful water', () => {
    // A gaur at a waterhole drinks what it needs in minutes. Rationed to a fraction an hour, a
    // thirsty one drank for an hour, got hungry, walked off to pasture, and was thirsty again
    // before it came back: in the dry season, with water and grass kilometres apart, the herd
    // died of thirst commuting between them.
    const s = scenario('gaur', 'find_water', { drives: { thirst: 0.9 } });
    s.patches[s.agent.patchId]!.waterVolume = 50_000;
    s.percept.bestWater = { patchId: s.agent.patchId, litres: 50_000 };
    executeGoal(s.ctx);
    expect(s.agent.drives.thirst).toBeLessThan(0.05);
  });

  it('drinks no more than it needs, leaving the rest for others', () => {
    const s = scenario('gaur', 'find_water', { drives: { thirst: 0.4 } });
    s.patches[s.agent.patchId]!.waterVolume = 50_000;
    s.percept.bestWater = { patchId: s.agent.patchId, litres: 50_000 };
    executeGoal(s.ctx);
    const gaur = s.ctx.species.diet.waterNeedLPerDay;
    expect(50_000 - s.patches[s.agent.patchId]!.waterVolume).toBeLessThanOrEqual(gaur * 1.01);
  });

  it('recovers stamina while resting', () => {
    const s = scenario('tiger', 'rest', { drives: { fatigue: 0.9 } });
    s.agent.stamina = 0.3;
    executeGoal(s.ctx);
    expect(s.agent.state).toBe('resting');
    expect(s.agent.stamina).toBeGreaterThan(0.3);
  });

  it('moves to a neighbouring patch when wandering', () => {
    const s = scenario('sambar', 'wander');
    const start = s.agent.patchId;
    executeGoal(s.ctx);
    expect(s.percept.patch.neighbours).toContain(s.agent.patchId);
    expect(s.agent.patchId).not.toBe(start);
  });
});

describe('hunting', () => {
  it('spends stamina and frightens the prey whether or not it kills', () => {
    const prey = makeAgent('sambar', { id: 's1' });
    const s = scenario('tiger', 'hunt', { drives: { hunger: 0.9 }, others: [prey] });
    const target = s.others[0]!;
    executeGoal(s.ctx);
    expect(s.agent.stamina!).toBeLessThan(1);
    expect(target.drives.fear).toBeGreaterThan(0.5);
  });

  it('logs a hunt event carrying the stage it reached', () => {
    const s = scenario('tiger', 'hunt', { drives: { hunger: 0.9 }, others: [makeAgent('sambar', { id: 's1' })] });
    executeGoal(s.ctx);
    const hunt = s.log.all().find((e) => e.type === 'hunt');
    expect(hunt).toBeDefined();
    expect(typeof hunt!.conditions.stage).toBe('string');
  });

  it('creates a carcass carrying the prey mass when it kills', () => {
    // Run until this seed produces a kill, then check what the kill left behind.
    for (let seed = 1; seed < 60; seed++) {
      const prey = makeAgent('sambar', { id: 's1' });
      const s = scenario('tiger', 'hunt', { drives: { hunger: 0.9 }, others: [prey] });
      s.ctx.rng = createRng(seed, 'hunt');
      executeGoal(s.ctx);
      if (s.carcasses.length === 0) continue;

      const carcass = s.carcasses[0]!;
      expect(carcass.cause).toBe('predation');
      expect(s.others[0]!.alive).toBe(false);
      // The tiger has already started eating, so the carcass is lighter than the animal was.
      expect(carcassMass(carcass.biomass)).toBeLessThanOrEqual(carcass.originalMassKg);
      expect(carcass.consumers.length).toBeGreaterThan(0);
      return;
    }
    throw new Error('no kill in 60 seeds — the hunt model may be broken');
  });

  it('wanders when there is nothing to hunt', () => {
    const s = scenario('tiger', 'hunt', { drives: { hunger: 0.9 } });
    const start = s.agent.patchId;
    executeGoal(s.ctx);
    expect(s.agent.patchId).not.toBe(start);
  });
});

describe('scavenging', () => {
  it('takes edible mass from the carcass and lowers hunger', () => {
    const carcass = makeCarcass('c1', 'x', 'sambar', 0, 0, 'predation', 'authoritative', 200);
    const s = scenario('vulture', 'scavenge', { drives: { hunger: 0.9 }, carcasses: [carcass] });
    const before = edibleMass(s.carcasses[0]!.biomass);
    executeGoal(s.ctx);
    expect(edibleMass(s.carcasses[0]!.biomass)).toBeLessThan(before);
    expect(s.agent.drives.hunger).toBeLessThan(0.9);
  });

  it('conserves mass: what the scavenger takes lands in the soil', () => {
    const carcass = makeCarcass('c1', 'x', 'sambar', 0, 0, 'predation', 'authoritative', 200);
    const s = scenario('jackal', 'scavenge', { drives: { hunger: 0.9 }, carcasses: [carcass] });
    const patch = s.patches[s.agent.patchId]!;
    const before = carcassMass(s.carcasses[0]!.biomass) * NUTRIENT_PER_KG_BIOMASS + patch.soilNutrients;
    executeGoal(s.ctx);
    const after = carcassMass(s.carcasses[0]!.biomass) * NUTRIENT_PER_KG_BIOMASS + patch.soilNutrients;
    expect(after).toBeCloseTo(before, 9);
  });

  it('records who fed, so the carcass carries its own history', () => {
    const carcass = makeCarcass('c1', 'x', 'sambar', 0, 0, 'predation', 'authoritative', 200);
    const s = scenario('vulture', 'scavenge', { drives: { hunger: 0.9 }, carcasses: [carcass] });
    executeGoal(s.ctx);
    expect(s.carcasses[0]!.consumers[0]!.agentId).toBe(s.agent.id);
  });
});

describe('fleeing', () => {
  it('leaves the patch and spends stamina', () => {
    const s = scenario('sambar', 'flee', { drives: { fear: 0.9 } });
    const start = s.agent.patchId;
    executeGoal(s.ctx);
    expect(s.agent.patchId).not.toBe(start);
    expect(s.agent.state).toBe('fleeing');
    expect(s.agent.stamina!).toBeLessThan(1);
  });

  it('logs where it fled from', () => {
    const s = scenario('sambar', 'flee', { drives: { fear: 0.9 } });
    const start = s.agent.patchId;
    executeGoal(s.ctx);
    expect(s.log.all().find((e) => e.type === 'fled')!.conditions.from).toBe(start);
  });
});
