import { describe, expect, it } from 'vitest';
import { PROTECTED_SPECIES } from '../src/bounties/engine.js';

// No bounty may be set on a threatened animal (docs/2026-10-14-congo-phase-b-research.md): the
// golden cat and the dwarf crocodile are Vulnerable, the forest elephant Critically Endangered;
// the crowned eagle (Near Threatened, decreasing) is kept off too. The agile mangabey is Least Concern.
describe('protected species', () => {
  it('lists the threatened Congo animals, and not the least-concern ones', () => {
    for (const id of ['african_golden_cat', 'forest_elephant', 'dwarf_crocodile', 'crowned_eagle']) expect(PROTECTED_SPECIES.has(id), id).toBe(true);
    for (const id of ['agile_mangabey', 'blue_duiker', 'red_river_hog']) expect(PROTECTED_SPECIES.has(id), id).toBe(false);
  });
});
