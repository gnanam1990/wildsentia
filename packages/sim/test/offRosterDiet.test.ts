import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Agent } from '@vana/shared';
import { loadSpeciesDir } from '../src/config/loader.js';
import { HUNGER_PER_DAY, updateDrives } from '../src/agents/drives.js';

const congo = loadSpeciesDir(fileURLToPath(new URL('../../../config/species-congo', import.meta.url)));
const animal = () => ({ state: 'resting', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } }) as unknown as Agent;

// The Congo's cats eat much the sim does not hold: at Lopé a leopard's food was 18% primates and
// 17% large rodents by biomass (Henschel et al. 2005); a golden cat lives mostly on rodents. Only
// the rest of their hunger falls on the simulated prey, or the duikers carry the whole forest's.
describe('food from beyond the roster', () => {
  it('leaves only the simulated share of a day\'s hunger to the simulated prey', () => {
    for (const [id, share] of [['african_leopard', 0.45], ['african_golden_cat', 0.85], ['crowned_eagle', 0.97], ['dwarf_crocodile', 0.95]] as const) {
      const cfg = congo.get(id)!, a = animal();
      expect(cfg.diet.offRosterShare, id).toBe(share);
      updateDrives(a, cfg, 24);
      expect(a.drives.hunger, id).toBeCloseTo(HUNGER_PER_DAY * (1 - share), 10);
    }
    const duiker = congo.get('blue_duiker')!, d = animal();
    updateDrives(d, duiker, 24);
    expect(d.drives.hunger).toBeCloseTo(HUNGER_PER_DAY, 10);
  });
});
