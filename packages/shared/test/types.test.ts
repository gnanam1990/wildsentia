import { describe, expect, it } from 'vitest';
import { GRID_SIZE, NUTRIENT_PER_KG_BIOMASS, PATCH_METRES, isGoalId } from '../src/index.js';

describe('domain constants', () => {
  it('describes a 20x20 grid of 300m patches', () => {
    expect(GRID_SIZE).toBe(20);
    expect(PATCH_METRES).toBe(300);
    expect(GRID_SIZE * GRID_SIZE).toBe(400);
  });

  it('fixes the nutrient content of biomass', () => {
    expect(NUTRIENT_PER_KG_BIOMASS).toBeCloseTo(0.02);
  });

  it('recognises the M1 goal set', () => {
    expect(isGoalId('find_food')).toBe(true);
    expect(isGoalId('find_water')).toBe(true);
    expect(isGoalId('rest')).toBe(true);
    expect(isGoalId('wander')).toBe(true);
    expect(isGoalId('teleport')).toBe(false);
  });
});
