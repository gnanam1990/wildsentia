import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/world.js';
import { RULES, checkRules } from './animalRules.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const SPECIES = ['blue_duiker', 'bay_duiker', 'peters_duiker', 'water_chevrotain', 'red_river_hog', 'forest_buffalo', 'sitatunga',
  'african_golden_cat', 'african_leopard', 'forest_elephant', 'agile_mangabey', 'crowned_eagle', 'dwarf_crocodile'];

// The owner: run every animal and make each one behave as it would. Every living animal of all
// thirteen species is checked against the rules at every hour's end for four days.
describe('every Congo animal keeps the rules of where it can be', () => {
  it('breaks none of them', () => {
    const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
      initialAgents: Object.fromEntries(SPECIES.map((s) => [s, 40])), minPopulation: {}, retainEvents: 'none' });
    const breaks = new Map<string, number>(), checked = new Map<string, number>();
    for (let h = 0; h < 24 * 4; h++) {
      world.step(1);
      const parents = new Set(world.agents.filter((a) => a.alive && a.dependentOn !== null).map((a) => a.dependentOn!));
      checkRules(world.agents, { grid: world.grid, patches: world.patches, species: world.species, seed: 7, parents }, breaks, checked);
    }
    // Every rule was put to the test, and every species was checked.
    // (A bird's flights end within their hour, so its height in flight is checked on its routes: canopyHeights.test.ts.)
    for (const rule of RULES.filter((r) => r.id !== 'bird-flight')) expect([...checked.keys()].some((k) => k.startsWith(`${rule.id}:`)), rule.id).toBe(true);
    for (const s of SPECIES) expect([...checked.keys()].some((k) => k.endsWith(`:${s}`)), s).toBe(true);
    expect(Object.fromEntries([...breaks].map(([k, n]) => [k, `${n}/${checked.get(k)}`]))).toEqual({});
  }, 600_000);
});
