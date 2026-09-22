import { describe, expect, it } from 'vitest';
import { WORLD_SECONDS_PER_DAY, createRng } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { Pedigree } from '../src/agents/pedigree.js';
import {
  assessMate, attemptCourtship, birth, conceive, isReadyToGiveBirth, isReceptive,
} from '../src/agents/reproduction.js';
import { makeAgent, speciesOf } from './helpers.js';

const chital = speciesOf('chital');

describe('isReceptive', () => {
  it('accepts a healthy adult female', () => {
    const doe = makeAgent('chital', { sex: 'female' });
    expect(isReceptive(doe, chital, 0)).toBe(true);
  });

  it('refuses a juvenile', () => {
    const fawn = makeAgent('chital', { ageDays: 10, lifeStage: 'juvenile' });
    expect(isReceptive(fawn, chital, 0)).toBe(false);
  });

  it('refuses an animal in poor condition', () => {
    const starving = makeAgent('chital', {
      drives: { hunger: 0.9, thirst: 0.2, fatigue: 0.2, fear: 0 },
    });
    expect(isReceptive(starving, chital, 0)).toBe(false);
  });

  it('refuses one already pregnant', () => {
    expect(isReceptive(makeAgent('chital', { pregnantSince: 0 }), chital, 0)).toBe(false);
  });

  it('refuses a female inside her inter-birth interval', () => {
    const recent = makeAgent('chital', { sex: 'female', lastBirthAt: 0 });
    const halfway = chital.lifecycle.interBirthIntervalDays / 2 * WORLD_SECONDS_PER_DAY;
    expect(isReceptive(recent, chital, halfway)).toBe(false);
    const later = (chital.lifecycle.interBirthIntervalDays + 1) * WORLD_SECONDS_PER_DAY;
    expect(isReceptive(recent, chital, later)).toBe(true);
  });
});

describe('assessMate', () => {
  const pedigree = new Pedigree();

  it('refuses the same sex', () => {
    const a = makeAgent('chital', { id: 'a', sex: 'female' });
    const b = makeAgent('chital', { id: 'b', sex: 'female' });
    expect(assessMate(a, b, pedigree)).toBeNull();
  });

  it('accepts an unrelated animal of the other sex', () => {
    const a = makeAgent('chital', { id: 'a', sex: 'female' });
    const b = makeAgent('chital', { id: 'b', sex: 'male' });
    expect(assessMate(a, b, pedigree)).not.toBeNull();
  });

  it('refuses a full sibling', () => {
    const family = new Pedigree();
    family.record('mum', null, null);
    family.record('dad', null, null);
    family.record('a', 'mum', 'dad');
    family.record('b', 'mum', 'dad');
    const a = makeAgent('chital', { id: 'a', sex: 'female' });
    const b = makeAgent('chital', { id: 'b', sex: 'male' });
    expect(assessMate(a, b, family)).toBeNull();
  });

  it('prefers the candidate in better condition', () => {
    const chooser = makeAgent('chital', { id: 'a', sex: 'female' });
    const fit = makeAgent('chital', { id: 'fit', sex: 'male' });
    const thin = makeAgent('chital', {
      id: 'thin', sex: 'male', drives: { hunger: 0.6, thirst: 0.2, fatigue: 0.2, fear: 0 },
    });
    expect(assessMate(chooser, fit, pedigree)!.score)
      .toBeGreaterThan(assessMate(chooser, thin, pedigree)!.score);
  });
});

describe('courtship and birth', () => {
  it('sometimes fails and sometimes succeeds', () => {
    const a = makeAgent('chital', { id: 'a', sex: 'female' });
    const b = makeAgent('chital', { id: 'b', sex: 'male' });
    const rng = createRng(1, 'c');
    const outcomes = new Set(Array.from({ length: 200 }, () => attemptCourtship(a, b, rng)));
    expect(outcomes).toEqual(new Set([true, false]));
  });

  it('is suppressed by crowding', () => {
    const a = makeAgent('chital', { id: 'a', sex: 'female' });
    const b = makeAgent('chital', { id: 'b', sex: 'male' });
    const rate = (density: number): number => {
      const rng = createRng(2, 'c');
      let yes = 0;
      for (let i = 0; i < 2000; i++) if (attemptCourtship(a, b, rng, density, 6)) yes++;
      return yes / 2000;
    };
    expect(rate(40)).toBeLessThan(rate(1));
  });

  it('carries a pregnancy for the configured gestation', () => {
    const mother = makeAgent('chital', { id: 'm', sex: 'female' });
    const father = makeAgent('chital', { id: 'f', sex: 'male' });
    conceive(mother, father, 0);
    expect(mother.pregnantSince).toBe(0);
    const almost = (chital.lifecycle.gestationDays - 1) * WORLD_SECONDS_PER_DAY;
    expect(isReadyToGiveBirth(mother, chital, almost)).toBe(false);
    const due = chital.lifecycle.gestationDays * WORLD_SECONDS_PER_DAY;
    expect(isReadyToGiveBirth(mother, chital, due)).toBe(true);
  });

  it('produces a litter inside the configured range, with both parents named', () => {
    const patches = buildGrid(3);
    const mother = makeAgent('chital', { id: 'm', sex: 'female' });
    const father = makeAgent('chital', { id: 'f', sex: 'male' });
    const pedigree = new Pedigree();
    pedigree.record('m', null, null);
    pedigree.record('f', null, null);

    let n = 0;
    const result = birth(
      mother, father, chital, patches[0]!, pedigree, createRng(3, 'b'), 1000,
      () => `chital_kid_${n++}`,
    );

    const [min, max] = chital.lifecycle.litterSize;
    expect(result.newborns.length).toBeGreaterThanOrEqual(min);
    expect(result.newborns.length).toBeLessThanOrEqual(max);
    for (const child of result.newborns) {
      expect(child.motherId).toBe('m');
      expect(child.fatherId).toBe('f');
      expect(child.generation).toBe(1);
      expect(child.dependentOn).toBe('m');
      expect(child.lifeStage).toBe('newborn');
    }
    expect(mother.pregnantSince).toBeNull();
    expect(mother.lastBirthAt).toBe(1000);
    expect(mother.offspringIds).toHaveLength(result.newborns.length);
  });

  it('draws the litter mass from the patch soil so nothing is created from nothing', () => {
    const patches = buildGrid(3);
    const before = patches[0]!.soilNutrients;
    const mother = makeAgent('chital', { id: 'm', sex: 'female' });
    const father = makeAgent('chital', { id: 'f', sex: 'male' });
    const pedigree = new Pedigree();
    let n = 0;
    const result = birth(
      mother, father, chital, patches[0]!, pedigree, createRng(4, 'b'), 0,
      () => `k${n++}`,
    );
    expect(before - patches[0]!.soilNutrients).toBeCloseTo(result.massDrawnKg * 0.02, 9);
  });
});
