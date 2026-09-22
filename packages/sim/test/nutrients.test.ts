import { describe, expect, it } from 'vitest';
import { NUTRIENT_PER_KG_BIOMASS, type Agent } from '@vana/shared';
import { buildGrid } from '../src/grid.js';
import { assertNutrientsConserved, totalNutrients } from '../src/fields/nutrients.js';

const agent = (massKg: number): Agent => ({
  id: 'a1', speciesId: 'sambar', bornAt: 0, massKg, patchId: 0,
  state: 'resting', currentGoal: 'rest', alternativeGoal: null, goalScore: 0,
  drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 }, alive: true,
});

describe('nutrient ledger', () => {
  it('counts soil, plants, agents and the import/export ledger', () => {
    const patches = buildGrid(1);
    const ledger = { imported: 0, exported: 0 };
    const soil = patches.reduce((s, p) => s + p.soilNutrients, 0);
    const plants = patches.reduce((s, p) => s + p.plant.grass + p.plant.browse, 0) * NUTRIENT_PER_KG_BIOMASS;
    expect(totalNutrients(patches, [agent(220)], ledger))
      .toBeCloseTo(soil + plants + 220 * NUTRIENT_PER_KG_BIOMASS, 6);
  });

  it('ignores dead agents, whose mass has already returned to soil', () => {
    const patches = buildGrid(1);
    const ledger = { imported: 0, exported: 0 };
    expect(totalNutrients(patches, [{ ...agent(220), alive: false }], ledger))
      .toBeCloseTo(totalNutrients(patches, [], ledger), 6);
  });

  it('subtracts imported nutrients so immigration does not look like creation', () => {
    const patches = buildGrid(1);
    const base = totalNutrients(patches, [], { imported: 0, exported: 0 });
    expect(totalNutrients(patches, [agent(100)], { imported: 100 * NUTRIENT_PER_KG_BIOMASS, exported: 0 }))
      .toBeCloseTo(base, 6);
  });

  it('throws with both values when the invariant breaks', () => {
    expect(() => assertNutrientsConserved(1000, 1200)).toThrow(/1000/);
    expect(() => assertNutrientsConserved(1000, 1200)).toThrow(/1200/);
  });

  it('accepts drift inside tolerance', () => {
    expect(() => assertNutrientsConserved(1000, 1000.0005)).not.toThrow();
  });
});
