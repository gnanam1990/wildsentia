import { describe, expect, it } from 'vitest';
import { NUTRIENT_PER_KG_BIOMASS, createRng, type Patch } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { createWorld } from '../src/world.js';
import { ROOTING_CAPACITY_KG, establishRooting, growRooting, rootingEligible } from '../src/fields/rooting.js';
import { executeGoal } from '../src/agents/behaviours.js';
import { perceive } from '../src/agents/perception.js';
import { breedingFertility, updateCondition } from '../src/agents/needs.js';
import { birth, isReceptive } from '../src/agents/reproduction.js';
import { Pedigree } from '../src/agents/pedigree.js';
import { EventLog } from '../src/events/log.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { makeAgent, makeServices, makeView, SPECIES_DIR, speciesOf } from './helpers.js';

const boar = speciesOf('boar');
const stock = (p: Patch) => p.soilNutrients + (p.plant.grass + p.plant.browse + (p.rooting?.kg ?? 0)) * NUTRIENT_PER_KG_BIOMASS;

describe('wild boar rooting and mast food (sim_0.37.0)', () => {
  it('is a finite pool on land, established and regrown out of the soil with nutrients conserved', () => {
    const patches = buildGrid(3, 'island_v1');
    const before = patches.map(stock);
    establishRooting(patches);
    for (const [i, p] of patches.entries()) {
      expect(p.rooting !== undefined).toBe(rootingEligible(p));
      if (p.rooting) expect(p.rooting).toEqual({ kg: ROOTING_CAPACITY_KG[p.habitat] * 0.6, capacityKg: ROOTING_CAPACITY_KG[p.habitat] });
      expect(stock(p)).toBeCloseTo(before[i]!, 9);
    }
    const shola = patches.find(p => p.habitat === 'shola' && p.rooting)!;
    shola.rooting!.kg = 0;
    const was = stock(shola);
    let grown = 0;
    for (let h = 0; h < 24 * 60; h++) grown += growRooting(shola, 1, 'monsoon');
    expect(grown).toBeGreaterThan(0);
    expect(shola.rooting!.kg).toBeLessThanOrEqual(shola.rooting!.capacityKg);
    expect(stock(shola)).toBeCloseTo(was, 9);
    // It never grows past capacity, nor out of soil that is not there.
    shola.soilNutrients = 0;
    expect(growRooting({ ...shola, rooting: { kg: 10, capacityKg: 900 } }, 1, 'monsoon')).toBe(0);
  });

  it('feeds a boar from the rooting food first; grass alone keeps it going at under a third of the value', () => {
    const patches = buildGrid(4);
    establishRooting(patches);
    const patch = patches.find(p => p.rooting && p.plant.grass > 1000)!;
    const feedOnce = (rootsKg: number) => {
      for (const p of patches) if (p.rooting) p.rooting.kg = rootsKg;
      patch.plant.grass = 5000;
      const pig = makeAgent('boar', { patchId: patch.id, drives: { hunger: 0.6, thirst: 0, fatigue: 0, fear: 0 } });
      const log = new EventLog(1, 'test');
      const view = makeView(patches, [pig]);
      executeGoal({ agent: pig, species: boar, patches, view, percept: perceive(pig, boar, view),
        choice: { goal: 'find_food', score: 1, alternative: null }, hours: 1, worldTime: 0, log, rng: createRng(1, 'f'),
        services: makeServices([]) });
      const fed = log.all().find(e => e.type === 'fed')!;
      return { hunger: pig.drives.hunger, kg: Number(fed.effects.kg), rootsKg: Number(fed.effects.rootsKg ?? 0) };
    };
    const rooted = feedOnce(500), grazed = feedOnce(0);
    expect(rooted.rootsKg).toBeGreaterThan(0);
    expect(rooted.rootsKg).toBeCloseTo(rooted.kg, 9);
    // On grass alone the same gut fill feeds it far less (van Wieren 2000: pigs cannot live on
    // fibrous grass).
    expect(grazed.rootsKg).toBe(0);
    expect(grazed.kg).toBeGreaterThan(0);
    expect((0.6 - grazed.hunger) / grazed.kg).toBeLessThan((0.6 - rooted.hunger) / rooted.kg * 0.6);
    // Any other grazer's feeding is unchanged by the pool.
    expect(speciesOf('chital').diet.eats.some(e => e.target === 'roots' || e.foodValue !== undefined)).toBe(false);
  });

  it('cannot make up for poor food by feeding all day: the gut takes a day\'s limit', () => {
    const patches = buildGrid(4);
    establishRooting(patches);
    for (const p of patches) if (p.rooting) p.rooting.kg = 0;
    const patch = patches.find(p => p.plant.grass > 1000)!;
    patch.plant.grass = 5000;
    const pig = makeAgent('boar', { patchId: patch.id, drives: { hunger: 0.7, thirst: 0, fatigue: 0, fear: 0 } });
    const log = new EventLog(1, 'test');
    let eaten = 0;
    for (let h = 0; h < 20; h++) {
      const view = makeView(patches, [pig]);
      executeGoal({ agent: pig, species: boar, patches, view, percept: perceive(pig, boar, view),
        choice: { goal: 'find_food', score: 1, alternative: null }, hours: 1, worldTime: h * 3600, log, rng: createRng(h, 'g'),
        services: makeServices([]) });
    }
    for (const e of log.all()) if (e.type === 'fed') eaten += Number(e.effects.kg);
    expect(eaten).toBeCloseTo(boar.diet.maxDailyIntakeKg!, 6);
    expect(pig.gutFill).toEqual({ day: 0, kg: expect.closeTo(boar.diet.maxDailyIntakeKg!, 6), naturalKg: 0 });
    // On grass and browse alone that is under a day's need.
    expect(pig.drives.hunger).toBeGreaterThan(0.7 - 0.14);
  });

  it('tracks body condition over weeks and breeds and carries litters by it', () => {
    const policy = boar.lifecycle.condition!;
    const sow = makeAgent('boar', { sex: 'female', drives: { hunger: 0.1, thirst: 0.1, fatigue: 0, fear: 0 } });
    const need = boar.diet.dailyIntakeKg;
    // The first hour starts a tally; condition starts full.
    updateCondition(sow, boar, 0);
    expect(sow.gutFill).toEqual({ day: 0, kg: 0, naturalKg: 0 });
    // A day fed half on roots and mast folds in once, at the next day's first hour.
    sow.gutFill = { day: 0, kg: 7, naturalKg: need / 2 };
    updateCondition(sow, boar, 1);
    expect(sow.condition).toBeCloseTo(1 + (0.5 - 1) / policy.conditionDays, 9);
    updateCondition(sow, boar, 1);
    expect(sow.condition).toBeCloseTo(1 + (0.5 - 1) / policy.conditionDays, 9);
    // Two months on green forage alone, however full, drag condition down; it takes weeks.
    for (let d = 1; d <= 60; d++) { sow.gutFill = { day: d, kg: 9, naturalKg: 0 }; updateCondition(sow, boar, d + 1);
      if (d === 5) expect(sow.condition!).toBeGreaterThan(0.75); }
    expect(sow.condition!).toBeLessThan(policy.minBreedingCondition);
    expect(breedingFertility(sow, boar)).toBe(0);
    expect(isReceptive(sow, boar, 0)).toBe(false);
    sow.condition = 0.9;
    expect(breedingFertility(sow, boar)).toBe(1);
    expect(isReceptive(sow, boar, 0)).toBe(true);
    // Species without a condition policy breed as before.
    expect(breedingFertility(makeAgent('chital'), speciesOf('chital'))).toBe(1);

    const litter = (condition: number) => {
      const sizes: number[] = [];
      for (let i = 0; i < 200; i++) {
        const mother = makeAgent('boar', { id: `sow${i}`, sex: 'female', condition, pregnantSince: 0 });
        const patch = { ...buildGrid(4)[210]!, soilNutrients: 1e6 };
        sizes.push(birth(mother, null, boar, patch, new Pedigree(), createRng(i, 'litter'), 0, (() => { let n = 0; return () => `p${i}_${n++}`; })()).newborns.length);
      }
      return sizes;
    };
    const lean = litter(policy.minBreedingCondition), fat = litter(1);
    // A sow in the poorest breeding condition carries half the litter a fat one does.
    expect(Math.min(...lean)).toBe(boar.lifecycle.litterSize[0] / 2);
    expect(Math.max(...lean)).toBe(boar.lifecycle.litterSize[1] / 2);
    expect(Math.min(...fat)).toBe(boar.lifecycle.litterSize[0]);
    expect(Math.max(...fat)).toBe(boar.lifecycle.litterSize[1]);
    const mean = (xs: number[]) => xs.reduce((s, n) => s + n, 0) / xs.length;
    expect(mean(fat) - mean(lean)).toBeGreaterThan(2.5);
  });

  it('checkpoints condition and rooting food, and rejects impossible values', () => {
    const options = { seed: 6, speciesDir: SPECIES_DIR, initialAgents: { boar: 4 }, minPopulation: {} };
    const world = createWorld(options);
    world.step(25);
    const snapshot = takeSnapshot(world);
    expect(snapshot.agents.every(a => a.condition !== undefined)).toBe(true);
    expect(snapshot.patches.filter(rootingEligible).every(p => p.rooting !== undefined)).toBe(true);
    const restored = restoreSnapshot(structuredClone(snapshot), options);
    expect(restored.agents).toEqual(world.agents);
    expect(restored.totalNutrients()).toBeCloseTo(world.totalNutrients(), 9);
    const badCondition = structuredClone(snapshot); badCondition.agents[0]!.condition = 1.5;
    expect(() => restoreSnapshot(badCondition, options)).toThrow(/body condition/);
    const wrongSpecies = structuredClone(snapshot); wrongSpecies.agents[0]!.speciesId = 'chital';
    expect(() => restoreSnapshot(wrongSpecies, options)).toThrow(/body condition/);
    const badFill = structuredClone(snapshot); badFill.agents[0]!.gutFill = { day: 99, kg: 1 };
    expect(() => restoreSnapshot(badFill, options)).toThrow(/gut fill/);
    const badPool = structuredClone(snapshot);
    const pooled = badPool.patches.find(p => p.rooting)!; pooled.rooting!.kg = pooled.rooting!.capacityKg * 2;
    expect(() => restoreSnapshot(badPool, options)).toThrow(/rooting/);
  });
});
