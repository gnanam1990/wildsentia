import { describe, expect, it } from 'vitest';
import {
  NUTRIENT_PER_KG_BIOMASS, carcassMass, createRng, edibleMass, patchCentre,
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
  if (goal === 'hunt') {
    const centre = patchCentre(grassland.id);
    agent.position = { x: centre.x - 30, z: centre.z, heading: Math.PI / 2 };
    for (const other of others) other.position = { ...centre, heading: Math.PI / 2 };
  }
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
  it('preserves a partial wander until arrival and abandons it when a higher need wins', () => {
    const s = scenario('sambar', 'wander');
    s.ctx.hours = 1 / 3600;
    executeGoal(s.ctx);
    const route = structuredClone(s.agent.journey!);
    const before = { ...s.agent.position! };
    executeGoal(s.ctx);
    expect(s.agent.journey!.destinationPatchId).toBe(route.destinationPatchId);
    expect(Math.hypot(s.agent.position!.x - before.x, s.agent.position!.z - before.z)).toBeLessThanOrEqual(s.ctx.species.locomotion.walkMs);
    s.ctx.choice.goal = 'rest'; executeGoal(s.ctx);
    expect(s.agent.journey).toBeUndefined();
  });

  it('cannot consume a remote resource until arrival, then uses only remaining time', () => {
    for (const goal of ['find_food', 'find_water'] as const) {
      const run = (hours: number) => {
        const s = scenario('sambar', goal, { drives: { hunger: 0.9, thirst: 0.9 } });
        const source = s.percept.patch; const dest = s.patches[source.neighbours[0]!]!;
        source.plant.grass = 0; source.plant.browse = 0; source.waterVolume = 0;
        dest.plant.grass = 1000; dest.plant.browse = 1000; dest.waterVolume = 1000;
        s.percept.bestFood = { patchId: dest.id, kg: 2000 };
        s.percept.bestWater = { patchId: dest.id, litres: 1000 };
        s.ctx.hours = hours; executeGoal(s.ctx); return s;
      };
      const partial = run(1 / 3600);
      expect(partial.log.all().some((e) => e.type === 'fed' || e.type === 'drank')).toBe(false);
      expect(partial.agent.drives.hunger).toBe(0.9); expect(partial.agent.drives.thirst).toBe(0.9);
      const full = run(1);
      const move = full.log.all().find((e) => e.type === 'moved')!;
      expect(move.movement!.completed).toBe(true);
      const brief = run((move.effects.durationSeconds! + 1) / 3600);
      const actionType = goal === 'find_food' ? 'fed' : 'drank';
      const key = goal === 'find_food' ? 'kg' : 'litres';
      const meal = brief.log.all().find((e) => e.type === actionType)!;
      expect(meal.effects[key]).toBeGreaterThan(0);
      expect(meal.effects[key]).toBeLessThan(full.log.all().find((e) => e.type === actionType)!.effects[key]! / 100);
    }
  });
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

  it('browses finite standing guild vegetation once but cannot eat unharvestable seeds', () => {
    const s = scenario('sambar', 'find_food', { drives: { hunger: 0.9 } });
    const patch = s.patches[s.agent.patchId]!;
    patch.plant.grass = 0; patch.plant.browse = 0;
    patch.floweringGuild = { guildId: 'insect_visited_understorey_v1', capacityKg: 100,
      vegetativeKg: 100, lastBloomYear: 0,
      seedBank: [{ biomassKg: 10, maturedAt: 0, germinateAt: 3600, expiresAt: 7200 }] };
    s.percept.bestFood = { patchId: patch.id, kg: 100 };
    const soil = patch.soilNutrients;
    executeGoal(s.ctx);
    const meal = s.log.all().find(event => event.type === 'fed')!;
    expect(meal.effects.kg).toBeGreaterThan(0);
    expect(patch.floweringGuild.vegetativeKg).toBeCloseTo(100 - meal.effects.kg!, 8);
    expect(patch.floweringGuild.seedBank[0]!.biomassKg).toBe(10);
    expect(patch.soilNutrients - soil).toBeCloseTo(meal.effects.kg! * NUTRIENT_PER_KG_BIOMASS, 8);
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
  it('budgets a fresh-kill meal only after the recorded hunt and final approach', () => {
    for (let seed = 1; seed < 60; seed++) {
      const run = (hours: number) => {
        const s = scenario('tiger', 'hunt', { drives: { hunger: 0.9 }, others: [makeAgent('sambar', { id: 's1' })] });
        s.ctx.rng = createRng(seed, 'hunt'); s.ctx.hours = hours;
        executeGoal(s.ctx); return s;
      };
      const full = run(1);
      const hunt = full.log.all().find((e) => e.type === 'hunt')!;
      if (hunt.outcome !== 'success') continue;
      const seconds = hunt.encounter!.samples.at(-1)!.seconds;
      const short = run((seconds + 1) / 3600);
      expect(short.carcasses).toHaveLength(1);
      const meal = short.log.all().find((e) => e.type === 'fed')!;
      expect(meal).toBeDefined();
      expect(meal.conditions.feedingSeconds).toBeGreaterThan(0);
      expect(meal.conditions.feedingSeconds).toBeLessThanOrEqual(1 + 1e-8);
      expect(meal.effects.kg).toBeLessThan(full.carcasses[0]!.consumers[0]!.kg / 100);
      expect(meal.causalParents).toContain(hunt.id);
      expect(Number(meal.conditions.arrivalWorldTime)).toBeGreaterThanOrEqual(short.ctx.worldTime + seconds);
      expect(meal.worldTime).toBe(Math.floor(short.ctx.worldTime + seconds + 1));
      for (const e of short.log.all()) expect(e.causalParents).not.toContain(e.id);
      return;
    }
    throw new Error('no successful hunt fixture');
  });
  it('keeps a visible approach target rather than changing prey on every travel tick', () => {
    const s = scenario('dhole', 'hunt', { others: [makeAgent('chital', { id: 'c1' }), makeAgent('chital', { id: 'c2' })] });
    const destination = s.percept.patch.neighbours[0]!;
    s.others[1]!.patchId = destination;
    s.percept.prey = s.others.map((agent) => ({ agent, patchId: agent.patchId, herdSize: 1 }));
    s.agent.targetId = 'c2';
    executeGoal(s.ctx);
    expect(s.agent.targetId).toBe('c2');
    expect(s.agent.patchId).toBe(destination);
    expect(s.log.all().some((e) => e.type === 'hunt')).toBe(false);
  });

  it('leaves to search after an edge escape instead of retrying the same trapped encounter next hour', () => {
    const s = scenario('dhole', 'hunt', { others: [makeAgent('chital', { id: 'c1' })] });
    s.agent.patchId = 19; s.agent.position = { x: 5840, z: 0, heading: 0 };
    const prey = s.others[0]!;
    prey.patchId = 19; prey.position = { x: 5849, z: 0, heading: 0 };
    s.percept.patch = s.patches[19]!;
    s.percept.prey = [{ agent: prey, patchId: 19, herdSize: 1 }];
    s.ctx.rng.bool = () => false;
    executeGoal(s.ctx);
    expect(s.log.all().find((e) => e.type === 'hunt')!.conditions.stage).toBe('boundary_escape');
    expect(s.agent.failedHunts?.[0]?.preyId).toBe('c1');
    expect(s.carcasses).toHaveLength(0);
    s.ctx.worldTime += 3600;
    executeGoal(s.ctx);
    expect(s.log.all().filter((e) => e.type === 'hunt')).toHaveLength(1);
    expect(s.agent.patchId).not.toBe(19);
    expect(s.agent.targetId).toBeNull();
  });

  it('ignores prey that has died, left the patch or already participated in this tick', () => {
    for (const reason of ['dead', 'moved', 'busy']) {
      const s = scenario('tiger', 'hunt', { others: [makeAgent('sambar', { id: 's1' })] });
      const target = s.others[0]!;
      if (reason === 'dead') target.alive = false;
      if (reason === 'moved') target.patchId = s.percept.patch.neighbours[0]!;
      if (reason === 'busy') target.lastEncounterAt = s.ctx.worldTime;
      executeGoal(s.ctx);
      expect(s.log.all().some((e) => e.type === 'hunt')).toBe(false);
      expect(s.carcasses).toHaveLength(0);
    }
  });
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
      const event = s.log.all().find((e) => e.type === 'hunt')!;
      expect(event.encounter!.samples.at(-1)!.phase).toBe('contact');
      expect(carcass.position).toEqual(event.encounter!.samples.at(-1)!.prey);
      expect(carcass.diedAt).toBe(event.worldTime);
      expect(carcass.consumers.every((c) => c.at >= carcass.diedAt)).toBe(true);
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
  const contactScenario = () => {
    const carcass = makeCarcass('c1', 'x', 'sambar', 0, 0, 'predation', 'authoritative', 200);
    const s = scenario('jackal', 'scavenge', { drives: { hunger: 0.9, fatigue: 0 }, carcasses: [carcass] });
    const centre = patchCentre(s.agent.patchId);
    s.agent.position = { ...centre, heading: 0 };
    s.carcasses[0]!.position = { x: centre.x + 10, z: centre.z, heading: 0 };
    s.ctx.species = structuredClone(s.ctx.species);
    s.ctx.species.locomotion.walkMs = 1;
    s.ctx.species.locomotion.terrainCost[s.percept.patch.habitat] = 1;
    return s;
  };
  it('approaches over multiple ticks and takes no food before contact', () => {
    const s = contactScenario();
    const body = s.carcasses[0]!;
    const before = edibleMass(body.biomass); const position = { ...s.agent.position! };
    const soil = s.percept.patch.soilNutrients;
    s.ctx.hours = 5 / 3600;
    executeGoal(s.ctx);
    expect(s.agent.position!.x - position.x).toBeCloseTo(5);
    expect(s.agent.state).toBe('travelling');
    expect(body.consumers).toHaveLength(0);
    expect(edibleMass(body.biomass)).toBe(before);
    expect(s.agent.drives.hunger).toBe(0.9);
    expect(s.percept.patch.soilNutrients).toBe(soil);
    expect(s.log.all().find((e) => e.type === 'moved')).toMatchObject({ outcome: 'interrupted', worldTime: 3605 });
    s.ctx.worldTime += 5; s.ctx.hours = 10 / 3600;
    executeGoal(s.ctx);
    expect(s.agent.state).toBe('feeding');
    expect(body.consumers).toHaveLength(1);
    const meal = s.log.all().find((e) => e.type === 'scavenged')!;
    const radius = Math.max(0.35, s.ctx.species.body.shoulderHeightM * 0.65);
    expect(meal.conditions.feedingSeconds).toBeCloseTo(5 + radius);
    expect(meal.conditions.arrivalWorldTime).toBeCloseTo(3610 - radius);
    expect(body.consumers[0]!.at).toBe(3615);
    expect(meal.worldTime).toBe(3615);
    expect(meal.causalParents).toHaveLength(1);
    expect(edibleMass(body.biomass) + body.consumers[0]!.kg).toBeCloseTo(before, 9);
    expect((s.percept.patch.soilNutrients - soil) / NUTRIENT_PER_KG_BIOMASS).toBeCloseTo(body.consumers[0]!.kg, 8);
    const move = s.log.all().find((e) => e.id === meal.causalParents[0])!;
    expect(move.causalParents).toEqual([]);
  });
  it('cannot use time before a carcass created later in the tick exists', () => {
    const s = contactScenario(); const body = s.carcasses[0]!;
    body.diedAt = s.ctx.worldTime + 100; s.ctx.hours = 60 / 3600;
    const before = { ...s.agent.position! };
    executeGoal(s.ctx);
    expect(s.agent.position).toEqual(before);
    expect(body.consumers).toHaveLength(0);
    body.diedAt = s.ctx.worldTime + 20;
    executeGoal(s.ctx);
    const move = s.log.all().find((e) => e.type === 'moved')!;
    const meal = s.log.all().find((e) => e.type === 'scavenged')!;
    expect(move.conditions.startWorldTime).toBe(body.diedAt);
    expect(Number(meal.conditions.feedingSeconds) + move.effects.durationSeconds!).toBeCloseTo(40);
    expect(meal.worldTime).toBe(3660);
  });
  it('scales approach by body size, fatigue and terrain rather than teleporting young animals', () => {
    for (const factor of ['small', 'tired', 'terrain']) {
      const s = contactScenario(); const before = s.agent.position!.x;
      if (factor === 'small') s.agent.massKg = s.ctx.species.body.adultMassKg / 4;
      if (factor === 'tired') s.agent.drives.fatigue = 1;
      if (factor === 'terrain') s.ctx.species.locomotion.terrainCost[s.percept.patch.habitat] = 2;
      s.ctx.hours = 4 / 3600;
      executeGoal(s.ctx);
      expect(s.agent.position!.x - before).toBeCloseTo(2);
      expect(s.carcasses[0]!.consumers).toHaveLength(0);
    }
  });
  it('takes edible mass from the carcass and lowers hunger', () => {
    const carcass = makeCarcass('c1', 'x', 'sambar', 0, 0, 'predation', 'authoritative', 200);
    const s = scenario('vulture', 'scavenge', { drives: { hunger: 0.9 }, carcasses: [carcass] });
    const before = edibleMass(s.carcasses[0]!.biomass);
    executeGoal(s.ctx);
    expect(edibleMass(s.carcasses[0]!.biomass)).toBeLessThan(before);
    expect(s.agent.drives.hunger).toBeLessThan(0.9);
    const anchor = s.carcasses[0]!.position!;
    const position = s.agent.position!;
    expect(Math.hypot(position.x - anchor.x, position.z - anchor.z)).toBeLessThanOrEqual(2);
    expect(position.heading).toBeCloseTo(Math.atan2(anchor.x - position.x, anchor.z - position.z));
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
  it('does not replenish sprint capacity between partial flee decisions', () => {
    const s = scenario('sambar', 'flee');
    s.ctx.species = structuredClone(s.ctx.species);
    s.ctx.species.locomotion.sprintStaminaS = 2;
    s.ctx.hours = 1 / 3600;
    executeGoal(s.ctx);
    expect(s.agent.stamina).toBeCloseTo(0.5);
    s.ctx.worldTime += 1; executeGoal(s.ctx);
    expect(s.agent.stamina).toBeCloseTo(0);
    s.ctx.worldTime += 1; executeGoal(s.ctx);
    const last = s.log.all().at(-1)!;
    expect(last.type).toBe('fled'); expect(last.effects.sprintSeconds).toBe(0);
    expect(last.effects.distanceM).toBeGreaterThan(0);
  });
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
