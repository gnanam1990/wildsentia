import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { GOAL_IDS } from '@vana/shared';
import { ARCHETYPE_GOALS, goalsFor } from '../src/agents/archetypes.js';
import { loadSpeciesDir } from '../src/config/loader.js';

const species = loadSpeciesDir(fileURLToPath(new URL('../../../config/species', import.meta.url)));

describe('archetype goals', () => {
  it('has an entry for every archetype the roster uses', () => {
    for (const config of species.values()) {
      expect(goalsFor(config.archetype).length).toBeGreaterThan(0);
    }
  });

  it('only names goals that exist', () => {
    for (const goals of Object.values(ARCHETYPE_GOALS)) {
      for (const goal of goals) expect(GOAL_IDS).toContain(goal);
    }
  });

  it('never lets a grazer hunt', () => {
    expect(goalsFor('herd_grazer')).not.toContain('hunt');
    expect(goalsFor('mega_herbivore')).not.toContain('hunt');
    expect(goalsFor('arboreal_troop')).not.toContain('hunt');
  });

  it('never lets a predator graze', () => {
    expect(goalsFor('apex_predator')).not.toContain('find_food');
    expect(goalsFor('pack_predator')).not.toContain('find_food');
  });

  it('lets only scavengers scavenge', () => {
    for (const [archetype, goals] of Object.entries(ARCHETYPE_GOALS)) {
      const config = [...species.values()].find((c) => c.archetype === archetype);
      if (config === undefined) continue;
      if (goals.includes('scavenge')) {
        expect(config.diet.canScavenge).toBe(true);
      }
    }
  });

  it('gives every prey archetype a flee goal', () => {
    for (const archetype of ['herd_grazer', 'mega_herbivore', 'arboreal_troop', 'omnivore_rooter'] as const) {
      expect(goalsFor(archetype)).toContain('flee');
    }
  });
});
