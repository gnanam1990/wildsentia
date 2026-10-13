import { describe, expect, it } from 'vitest';
import { CONGO_GRID, gridForProfile, HABITAT_ANALOGUE, isClosedProfile, isIslandProfile, terrainCostFor } from '../src/index.js';

describe('congo_v1 profile', () => {
  it('is a closed, non-island profile on the 48 km grid', () => {
    expect(gridForProfile('congo_v1')).toEqual(CONGO_GRID);
    expect(isIslandProfile('congo_v1')).toBe(false);
    expect(isClosedProfile('congo_v1')).toBe(true);
    expect(isClosedProfile('island_v2')).toBe(true);
    expect(isClosedProfile('mainland')).toBe(false);
  });
  it('costs a Congo habitat as its analogue unless the species says otherwise', () => {
    const cfg = { locomotion: { terrainCost: { shola: 1.4, grassland: 1, riparian: 1.2, rock: 2, marsh: 1.8, water: 3, bai: 0.9 } } };
    expect(terrainCostFor(cfg as never, 'terra_firme')).toBe(1.4);
    expect(terrainCostFor(cfg as never, 'flooded_forest')).toBe(1.2);
    expect(terrainCostFor(cfg as never, 'bai')).toBe(0.9);
    expect(terrainCostFor(cfg as never, 'marsh')).toBe(1.8);
    expect(HABITAT_ANALOGUE.swamp_forest).toBe('marsh');
  });
});
