import { describe, expect, it } from 'vitest';
import { NUTRIENT_PER_KG_BIOMASS, isGoalId } from '../src/index.js';
import { ISLAND_GRID } from '../src/grid.js';

describe('domain constants', () => {
  it('describes a 20x20 grid of 300m patches', () => {
    expect(ISLAND_GRID.cols).toBe(20);
    expect(ISLAND_GRID.patchM).toBe(300);
    expect(ISLAND_GRID.cols * ISLAND_GRID.cols).toBe(400);
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
