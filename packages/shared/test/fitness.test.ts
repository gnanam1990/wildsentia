import { describe, expect, it } from 'vitest';
import { EVEN_FITNESS, EVEN_NEED, fitnessEffects, fitnessLabel, fitnessOf } from '../src/fitness.js';

// An animal kept fed, watered and rested is fitter: faster, longer in the sprint, surer in the
// catch and harder to catch. One that is starving, parched, worn out or hurt is weaker.
describe('fitness', () => {
  const drives = (hunger: number, thirst: number, fatigue: number) => ({ hunger, thirst, fatigue, fear: 0 });

  it('is full for an animal fed, watered, rested and unhurt, and falls with each need', () => {
    expect(fitnessOf({ drives: drives(0, 0, 0) }).score).toBe(1);
    const kept = fitnessOf({ drives: drives(0.2, 0.2, 0.1), condition: 0.95 }).score;
    const hungry = fitnessOf({ drives: drives(0.8, 0.2, 0.1), condition: 0.95 }).score;
    const parched = fitnessOf({ drives: drives(0.2, 0.8, 0.1), condition: 0.95 }).score;
    const worn = fitnessOf({ drives: drives(0.2, 0.2, 0.9), condition: 0.95 }).score;
    for (const weaker of [hungry, parched, worn]) expect(weaker).toBeLessThan(kept - 0.1);
    expect(fitnessOf({ drives: drives(0.2, 0.2, 0.1), condition: 0.4 }).score).toBeLessThan(kept);
    // A wound halves what is left at its worst.
    expect(fitnessOf({ drives: drives(0, 0, 0), woundSeverity: 1 }).score).toBe(0.5);
    expect(fitnessOf({ drives: drives(1, 1, 1), condition: 0, woundSeverity: 1 }).score).toBe(0);
  });

  it('reads its parts back, each between 0 and 1', () => {
    const f = fitnessOf({ drives: drives(0.25, 0.5, 0.75), condition: 0.8, woundSeverity: 0.2 });
    expect(f).toMatchObject({ fed: 0.75, watered: 0.5, rested: 0.25, condition: 0.8, hurt: 0.2 });
    // Out-of-range inputs are held to the range.
    expect(fitnessOf({ drives: drives(-1, 2, 0.5), condition: 3 }).fed).toBe(1);
    expect(fitnessOf({ drives: drives(-1, 2, 0.5), condition: 3 }).watered).toBe(0);
  });

  it('turns fitness into speed, breath and the odds of a catch: even at a well-kept wild level, a fit animal ahead of a weak one', () => {
    expect(fitnessEffects(EVEN_FITNESS)).toEqual({ speed: 1, breath: 1, grip: 1, dodge: 1 });
    expect(fitnessOf({ drives: drives(EVEN_NEED, EVEN_NEED, EVEN_NEED) }).score).toBe(EVEN_FITNESS);
    expect(fitnessEffects(1)).toEqual({ speed: 1.1, breath: 1.2, grip: 1.2, dodge: 0.8 });
    expect(fitnessEffects(0)).toEqual({ speed: 0.7, breath: 0.4, grip: 0.4, dodge: 1.6 });
    // A fit hunter on a starving prey has about twice the odds of an even pair; a starving hunter on a fit prey a third.
    const fit = fitnessEffects(1), starving = fitnessEffects(0.25);
    expect(fit.grip * starving.dodge).toBeCloseTo(1.68);
    expect(starving.grip * fit.dodge).toBeCloseTo(0.48);
  });

  it('names a fitness in a word for a glance at another animal', () => {
    expect(fitnessLabel(0.9)).toBe('fit');
    expect(fitnessLabel(0.6)).toBe('fair');
    expect(fitnessLabel(0.3)).toBe('weak');
  });
});
