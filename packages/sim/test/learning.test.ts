import { describe, expect, it } from 'vitest';
import { createRng } from '@vana/shared';
import {
  confidenceOf, decaySkills, experiencedSkills, recordOutcome, skillFactor, teach,
} from '../src/agents/learning.js';
import { makeAgent, speciesOf } from './helpers.js';

const chital = speciesOf('chital');
const tiger = speciesOf('tiger');

describe('confidence', () => {
  it('reads the innate floor for a skill the animal has never used', () => {
    const fawn = makeAgent('chital', { skills: {} });
    expect(confidenceOf(fawn, chital, 'predator_avoidance'))
      .toBe(chital.learning!.innate.predator_avoidance);
  });

  it('is neutral for a skill the species never uses, so the mechanic is unchanged', () => {
    const deer = makeAgent('chital', { skills: {} });
    expect(confidenceOf(deer, chital, 'stalk_technique')).toBe(0.5);
  });

  it('rises with practice only as far as an animal can teach itself', () => {
    const cat = makeAgent('tiger', { skills: {} });
    for (let i = 0; i < 20000; i++) recordOutcome(cat, tiger, 'stalk_technique', true, i);
    expect(confidenceOf(cat, tiger, 'stalk_technique')).toBeLessThanOrEqual(0.6);
    expect(confidenceOf(cat, tiger, 'stalk_technique')).toBeGreaterThan(0.55);
  });

  it('counts a failure without eroding the skill: most hunts fail, even for the best', () => {
    // Tigers kill on about one hunt in six. When each miss cost confidence, every predator's
    // technique sank to its floor within a generation, and tigers dwindled to their last two.
    const cat = makeAgent('tiger', { skills: {} });
    cat.skills!.stalk_technique = { confidence: 0.7, successes: 0, failures: 0, lastUsed: 0, taughtBy: null };
    for (let i = 0; i < 500; i++) recordOutcome(cat, tiger, 'stalk_technique', false, i);
    expect(confidenceOf(cat, tiger, 'stalk_technique')).toBe(0.7);
    expect(cat.skills!.stalk_technique!.failures).toBe(500);
    expect(cat.skills!.stalk_technique!.lastUsed).toBe(499);
  });
});

describe('teach', () => {
  it('brings the young toward the parent, and never past her', () => {
    const mother = makeAgent('chital', { id: 'mum', skills: {} });
    mother.skills!.water_locations = { confidence: 0.9, successes: 50, failures: 2, lastUsed: 0, taughtBy: null };
    const fawn = makeAgent('chital', { id: 'fawn', skills: {} });
    for (let d = 0; d < 2000; d++) teach(fawn, mother, chital, 'water_locations', d * 86_400);
    const learned = confidenceOf(fawn, chital, 'water_locations');
    expect(learned).toBeGreaterThan(0.85);
    expect(learned).toBeLessThanOrEqual(0.9);
    expect(fawn.skills!.water_locations!.taughtBy).toBe('mum');
  });

  it('teaches nothing when the parent knows less than the young', () => {
    // A mother who is a poor hunter raises poor hunters.
    const mother = makeAgent('chital', { id: 'mum', skills: {} });
    const fawn = makeAgent('chital', { id: 'fawn', skills: {} });
    fawn.skills!.water_locations = { confidence: 0.8, successes: 0, failures: 0, lastUsed: 0, taughtBy: null };
    expect(teach(fawn, mother, chital, 'water_locations', 0)).toBe(false);
    expect(confidenceOf(fawn, chital, 'water_locations')).toBe(0.8);
  });

  it('reports a milestone only when the pupil crosses a tenth, so the log stays bounded', () => {
    const mother = makeAgent('chital', { id: 'mum', skills: {} });
    mother.skills!.forage_efficiency = { confidence: 0.95, successes: 0, failures: 0, lastUsed: 0, taughtBy: null };
    const fawn = makeAgent('chital', { id: 'fawn', skills: {} });
    let milestones = 0;
    for (let d = 0; d < 2000; d++) if (teach(fawn, mother, chital, 'forage_efficiency', d * 86_400)) milestones++;
    const floor = chital.learning!.innate.forage_efficiency!;
    expect(milestones).toBe(Math.floor(confidenceOf(fawn, chital, 'forage_efficiency') * 10) - Math.floor(floor * 10));
  });
});

describe('teaching pace', () => {
  it('teaches a skill once a day however often the parent uses it, so it takes the season', () => {
    // A grazing mother feeds eight hours a day. Taught on every mouthful, a fawn knew all she
    // knew within a fortnight, and a fawn orphaned at a month was as capable as one raised.
    const mother = makeAgent('chital', { id: 'mum', skills: {} });
    mother.skills!.forage_efficiency = { confidence: 0.9, successes: 0, failures: 0, lastUsed: 0, taughtBy: null };
    const fawn = makeAgent('chital', { id: 'fawn', skills: {} });
    for (let h = 0; h < 24; h++) teach(fawn, mother, chital, 'forage_efficiency', h * 3600);
    const oneDay = confidenceOf(fawn, chital, 'forage_efficiency');
    const floor = chital.learning!.innate.forage_efficiency!;
    expect(oneDay - floor).toBeCloseTo((0.9 - floor) * chital.learning!.learnRateFromParent, 6);
  });
});

describe('decay', () => {
  it('lets an unused skill drift back toward the floor, never below it', () => {
    const deer = makeAgent('chital', { skills: {} });
    deer.skills!.water_locations = { confidence: 0.9, successes: 0, failures: 0, lastUsed: 0, taughtBy: null };
    const floor = chital.learning!.innate.water_locations!;
    const day = 86_400;
    decaySkills(deer, chital, 24 * 90, 120 * day);
    const after90 = confidenceOf(deer, chital, 'water_locations');
    expect(after90).toBeLessThan(0.9);
    expect(after90).toBeGreaterThan(floor);
    decaySkills(deer, chital, 24 * 365 * 20, 20 * 365 * day);
    expect(confidenceOf(deer, chital, 'water_locations')).toBeCloseTo(floor, 3);
  });

  it('keeps a skill in use: knowledge fades with disuse, not with time', () => {
    // A lineage keeps what it was taught for as long as it goes on using it. Decaying every
    // skill all the time pulled every family back to the same level within a generation.
    const deer = makeAgent('chital', { skills: {} });
    deer.skills!.water_locations = { confidence: 0.9, successes: 0, failures: 0, lastUsed: 100 * 86_400, taughtBy: null };
    decaySkills(deer, chital, 24 * 10, 110 * 86_400);
    expect(confidenceOf(deer, chital, 'water_locations')).toBe(0.9);
  });

  it('leaves an orphan near its floor for a long time: practice alone is slow', () => {
    const orphan = makeAgent('chital', { skills: {} });
    const floor = chital.learning!.innate.water_locations!;
    for (let d = 0; d < 365; d++) recordOutcome(orphan, chital, 'water_locations', true, d);
    expect(confidenceOf(orphan, chital, 'water_locations')).toBeLessThan(floor + 0.15);
  });
});

describe('experience', () => {
  it('gives founders and immigrants more than the innate floor: they arrive grown', () => {
    const skills = experiencedSkills(chital, createRng(1, 'skills'));
    for (const [skill, floor] of Object.entries(chital.learning!.innate)) {
      expect(skills[skill as keyof typeof skills]!.confidence).toBeGreaterThan(floor!);
    }
  });
});

describe('skillFactor', () => {
  it('is exactly one at the neutral confidence, so tuned mechanics stay where they were', () => {
    expect(skillFactor(0.5, 0.8, 1.2)).toBe(1);
    expect(skillFactor(0, 0.8, 1.2)).toBeCloseTo(0.8);
    expect(skillFactor(1, 0.8, 1.2)).toBeCloseTo(1.2);
  });
});
