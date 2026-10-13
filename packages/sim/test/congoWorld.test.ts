import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { islandPopulation } from '../src/forest.js';
import { SPECIES_DIR } from './helpers.js';

const congo = () => createWorld({ seed: 7, speciesDir: SPECIES_DIR, terrainProfile: 'congo_v1', initialAgents: { hare: 400, leopard: 6 }, minPopulation: {} });

describe('congo_v1 world', () => {
  it('founds animals on dry ground across the 48 km map and steps', () => {
    const world = congo();
    expect(world.grid.cols).toBe(160);
    expect(world.agents.every((a) => world.patches[a.patchId]!.habitat !== 'water')).toBe(true);
    const spread = new Set(world.agents.map((a) => a.patchId % 160 < 80));
    expect(spread.size).toBe(2);
    world.step(24);
    expect(world.agents.filter((a) => a.alive).length).toBeGreaterThan(300);
  }, 120_000);

  it('refuses floors or exchange, like an island', () => {
    expect(() => createWorld({ seed: 7, speciesDir: SPECIES_DIR, terrainProfile: 'congo_v1', initialAgents: { hare: 2 }, minPopulation: { hare: 1 } })).toThrow('closed population');
  });

  it('round-trips through a snapshot and refuses one from another profile', () => {
    const world = congo(); world.step(2);
    const saved = takeSnapshot(world);
    const back = restoreSnapshot(saved, { seed: 7, speciesDir: SPECIES_DIR, terrainProfile: 'congo_v1', initialAgents: {}, minPopulation: {} });
    expect(back.patches).toHaveLength(25_600);
    expect(back.agents.length).toBe(world.agents.length);
    expect(() => restoreSnapshot(saved, { seed: 7, speciesDir: SPECIES_DIR, terrainProfile: 'island_v2', initialAgents: {}, minPopulation: {} })).toThrow();
  }, 120_000);

  it('refuses an island checkpoint restored as Congo', () => {
    const island = createWorld({ seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v2', initialAgents: islandPopulation('island_v2'), minPopulation: {} });
    const saved = { ...takeSnapshot(island), terrainProfile: 'congo_v1' as const };
    expect(() => restoreSnapshot(saved, { seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'congo_v1', initialAgents: {}, minPopulation: {} })).toThrow();
  }, 120_000);
});
