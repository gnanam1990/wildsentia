import { describe, expect, it } from 'vitest';
import { WORLD_SECONDS_PER_DAY, createRng } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { Pedigree } from '../src/agents/pedigree.js';
import {
  assessMate, attemptCourtship, birth, conceive, endOestrus, isReadyToGiveBirth, isReceptive,
  packAllowsBreeding,
} from '../src/agents/reproduction.js';
import { makeAgent, makeView, makeServices, speciesOf } from './helpers.js';
import { executeGoal } from '../src/agents/behaviours.js';
import { perceive } from '../src/agents/perception.js';
import { EventLog } from '../src/events/log.js';
import type { Carcass } from '@vana/shared';

const chital = speciesOf('chital');

describe('gestation identity', () => {
  it('keeps the conceived father through hunting and a later birth', () => {
    const mother = makeAgent('tiger', { id: 'tiger_mother' });
    const father = makeAgent('tiger', { id: 'tiger_father', sex: 'male' });
    const prey = makeAgent('sambar', { id: 'sambar_prey' });
    const patches = buildGrid(1), cfg = speciesOf('tiger'), carcasses: Carcass[] = [];
    const view = makeView(patches, [mother, father, prey], carcasses);
    conceive(mother, father, 0);
    executeGoal({ agent: mother, species: cfg, patches, view,
      percept: perceive(mother, cfg, view), choice: { goal: 'hunt', score: 1, alternative: null },
      hours: 1, worldTime: 3600, log: new EventLog(1, 'test'), rng: createRng(1, 'test'),
      services: makeServices(carcasses) });
    expect(mother.targetId).toBeNull();
    expect(mother.pregnancyFatherId).toBe(father.id);
    const litter = birth(mother, father, cfg, patches[0]!, new Pedigree(), createRng(2, 'birth'),
      cfg.lifecycle.gestationDays * WORLD_SECONDS_PER_DAY, (() => { let n = 0; return () => `cub_${n++}`; })());
    expect(litter.newborns.length).toBeGreaterThan(0);
    for (const cub of litter.newborns) expect(cub.fatherId).toBe(father.id);
    expect(mother.pregnancyFatherId).toBeNull();
  });
});

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
    const { interBirthIntervalDays, gestationDays } = chital.lifecycle;
    const tooSoon = (interBirthIntervalDays - gestationDays - 1) * WORLD_SECONDS_PER_DAY;
    expect(isReceptive(recent, chital, tooSoon)).toBe(false);
  });

  it('lets her conceive in time to give birth again one inter-birth interval later', () => {
    // The interval is birth to birth, as field studies report it. Waiting the whole interval
    // before conceiving added a gestation on top: a chital calved every seventeen months
    // instead of every ten, and an annual breeder like the dhole slipped a season every year.
    const recent = makeAgent('chital', { sex: 'female', lastBirthAt: 0 });
    const { interBirthIntervalDays, gestationDays } = chital.lifecycle;
    const conceiveBy = (interBirthIntervalDays - gestationDays) * WORLD_SECONDS_PER_DAY;
    expect(isReceptive(recent, chital, conceiveBy)).toBe(true);
  });
});

describe('oestrus', () => {
  it('leaves a female whose courtship failed unreceptive until her next cycle', () => {
    const doe = makeAgent('chital', { sex: 'female' });
    endOestrus(doe, chital, 0);
    const cycle = chital.lifecycle.oestrusCycleDays * WORLD_SECONDS_PER_DAY;
    expect(isReceptive(doe, chital, cycle - WORLD_SECONDS_PER_DAY)).toBe(false);
    expect(isReceptive(doe, chital, cycle)).toBe(true);
  });

  it('makes crowding cost whole cycles, not hours', () => {
    // A female that retried every hour conceived within a day or two however crowded she was,
    // so crowding never slowed a population. Tried once per cycle, it does.
    const conceptionsInAYear = (density: number): number => {
      const rng = createRng(3, 'oestrus');
      const doe = makeAgent('hare', { id: 'doe', sex: 'female' });
      const buck = makeAgent('hare', { id: 'buck', sex: 'male' });
      const hare = speciesOf('hare');
      let conceptions = 0;
      for (let hour = 0; hour < 365 * 24; hour++) {
        const now = hour * 3600;
        if (doe.pregnantSince !== null && isReadyToGiveBirth(doe, hare, now)) {
          doe.pregnantSince = null;
          doe.lastBirthAt = now;
        }
        if (!isReceptive(doe, hare, now)) continue;
        if (attemptCourtship(doe, buck, rng, density, hare.social.groupSize[1])) {
          conceive(doe, buck, now);
          conceptions++;
        } else {
          endOestrus(doe, hare, now);
        }
      }
      return conceptions;
    };
    expect(conceptionsInAYear(40)).toBeLessThan(conceptionsInAYear(1) / 2);
  });
});

describe('pack breeding', () => {
  const dhole = speciesOf('dhole');
  const nursing = new Set<string>();
  const hasDependants = (a: { id: string }): boolean => nursing.has(a.id);

  it('lets a female breed when no packmate is carrying or raising a litter', () => {
    const her = makeAgent('dhole', { id: 'her', sex: 'female' });
    const mate = makeAgent('dhole', { id: 'm', sex: 'male' });
    const sister = makeAgent('dhole', { id: 'sis', sex: 'female' });
    expect(packAllowsBreeding(her, dhole, [her, mate, sister], hasDependants)).toBe(true);
  });

  it('stops a second female breeding while another in the pack is pregnant', () => {
    // A dhole pack raises one litter, the dominant female's. Every female breeding at once
    // turned twelve dholes into fifty-six in four months, then starved most of them.
    const her = makeAgent('dhole', { id: 'her', sex: 'female' });
    const alpha = makeAgent('dhole', { id: 'alpha', sex: 'female', pregnantSince: 0 });
    expect(packAllowsBreeding(her, dhole, [her, alpha], hasDependants)).toBe(false);
  });

  it('stops a second female breeding while another in the pack is raising pups', () => {
    const her = makeAgent('dhole', { id: 'her', sex: 'female' });
    const alpha = makeAgent('dhole', { id: 'alpha', sex: 'female' });
    nursing.add('alpha');
    expect(packAllowsBreeding(her, dhole, [her, alpha], hasDependants)).toBe(false);
    nursing.clear();
  });

  it('does not apply to herds', () => {
    const doe = makeAgent('chital', { id: 'doe', sex: 'female' });
    const other = makeAgent('chital', { id: 'o', sex: 'female', pregnantSince: 0 });
    expect(packAllowsBreeding(doe, chital, [doe, other], hasDependants)).toBe(true);
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

  it('does not count the courting pair themselves as crowding', () => {
    // The density the world passes counts every animal of the species around the female, the
    // male she is in contact with included. A pair alone is not a crowd.
    const a = makeAgent('chital', { id: 'a', sex: 'female', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } });
    const b = makeAgent('chital', { id: 'b', sex: 'male', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } });
    const rate = (density: number): number => {
      const rng = createRng(3, 'c');
      let yes = 0;
      for (let i = 0; i < 4000; i++) if (attemptCourtship(a, b, rng, density, 6)) yes++;
      return yes / 4000;
    };
    expect(rate(2)).toBeCloseTo(0.85, 1);
    expect(rate(2)).toBe(rate(1));
    expect(rate(3)).toBeLessThan(rate(2));
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
