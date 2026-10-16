import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSpeciesDir } from '../src/config/loader.js';
import { canHunt } from '../src/agents/perception.js';
import { createWorld } from '../src/world.js';
import { makeAgent } from './helpers.js';

const CONGO = loadSpeciesDir(fileURLToPath(new URL('../../../config/species-congo', import.meta.url)));
const congoAgent = (speciesId: string, over = {}) => ({ ...makeAgent('chital'), speciesId, id: `${speciesId}_t`, massKg: CONGO.get(speciesId)!.body.adultMassKg, ...over });

describe('which prey a predator may take (1B)', () => {
  const leopard = CONGO.get('african_leopard')!, duiker = CONGO.get('blue_duiker')!, chevrotain = CONGO.get('water_chevrotain')!;
  it('takes a duiker or a chevrotain on the ground', () => {
    expect(canHunt(leopard, duiker, congoAgent('blue_duiker'))).toBe(true);
    expect(canHunt(leopard, chevrotain, congoAgent('water_chevrotain'))).toBe(true);
  });
  it('refuses another leopard, prey above its weight, a diver under water, prey up a tree', () => {
    expect(canHunt(leopard, leopard, congoAgent('african_leopard'))).toBe(false);
    expect(canHunt(leopard, duiker, congoAgent('blue_duiker', { massKg: 500 }))).toBe(false);
    expect(canHunt(leopard, chevrotain, congoAgent('water_chevrotain', { locomotionMode: 'submerged', submergedUntil: 99 }))).toBe(false);
    expect(canHunt(leopard, duiker, congoAgent('blue_duiker', { altitudeM: 4 }))).toBe(false);
  });
  it('honours a predator prey life stages', () => {
    const picky = { ...leopard, hunting: { ...leopard.hunting!, preyLifeStages: ['adult' as const] } };
    expect(canHunt(picky, duiker, congoAgent('blue_duiker', { lifeStage: 'juvenile' }))).toBe(false);
    expect(canHunt(picky, duiker, congoAgent('blue_duiker', { lifeStage: 'adult' }))).toBe(true);
  });
  it('is the authority for a live hunt: the world refuses an incompatible kill', () => {
    const world = createWorld({ seed: 7, speciesDir: fileURLToPath(new URL('../../../config/species-congo', import.meta.url)),
      terrainProfile: 'congo_v1', initialAgents: { african_leopard: 2, blue_duiker: 20 }, minPopulation: {} });
    const [a, b] = world.agents.filter((x) => x.speciesId === 'african_leopard');
    const duikerAnimal = world.agents.find((x) => x.speciesId === 'blue_duiker')!;
    expect(world.resolveLiveHunt(a!.id, b!.id, a!.position!, world.now(), true)).toBeNull();
    duikerAnimal.massKg = 500;
    expect(world.resolveLiveHunt(a!.id, duikerAnimal.id, duikerAnimal.position!, world.now(), true)).toBeNull();
    duikerAnimal.massKg = 4.6;
    expect(world.resolveLiveHunt(a!.id, duikerAnimal.id, duikerAnimal.position!, world.now(), true)).not.toBeNull();
  }, 60_000);
});

describe('the 2A food web: prey sized for the leopard, small prey for the golden cat', () => {
  const leopard = CONGO.get('african_leopard')!, cat = CONGO.get('african_golden_cat')!;
  const prey = (id: string, over = {}) => [CONGO.get(id)!, congoAgent(id, over)] as const;
  it('a leopard takes red duikers, hogs, sitatunga and a buffalo calf, never a grown buffalo', () => {
    for (const id of ['bay_duiker', 'peters_duiker', 'red_river_hog', 'sitatunga']) expect(canHunt(leopard, ...prey(id)), id).toBe(true);
    expect(canHunt(leopard, ...prey('forest_buffalo'))).toBe(false);
    expect(canHunt(leopard, ...prey('forest_buffalo', { massKg: 60, lifeStage: 'juvenile' }))).toBe(true);
  });
  it('the golden cat takes blue duikers and young, never grown red duikers or hogs, and avoids leopards that hunt it', () => {
    expect(canHunt(cat, ...prey('blue_duiker'))).toBe(true);
    expect(canHunt(cat, ...prey('bay_duiker'))).toBe(false);
    expect(canHunt(cat, ...prey('bay_duiker', { massKg: 4.5, lifeStage: 'juvenile' }))).toBe(true);
    expect(canHunt(cat, ...prey('red_river_hog'))).toBe(false);
    expect(canHunt(cat, ...prey('red_river_hog', { massKg: 3, lifeStage: 'newborn' }))).toBe(true);
    expect(canHunt(leopard, ...prey('african_golden_cat'))).toBe(true);
    expect(cat.escape.avoids).toContain('african_leopard');
  });
  it('weights the leopard toward mid-sized prey (Lopé: hogs, red duikers), not blue duikers', () => {
    const w = leopard.hunting!.preyPreference!;
    expect(w.red_river_hog!).toBeGreaterThan(w.blue_duiker!);
    expect(w.bay_duiker!).toBeGreaterThan(w.blue_duiker!);
  });
});
