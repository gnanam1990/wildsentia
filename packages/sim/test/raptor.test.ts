import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONGO_GRID, type Agent } from '@vana/shared';
import { loadSpeciesDir } from '../src/config/loader.js';
import { buildGrid } from '../src/grid.js';
import { perceive, type WorldView } from '../src/agents/perception.js';
import { goalsFor } from '../src/agents/archetypes.js';
import { makeCarcass } from '../src/fields/decomposition.js';
import { createWorld } from '../src/world.js';

const CONGO = loadSpeciesDir(fileURLToPath(new URL('../../../config/species-congo', import.meta.url)));
const patches = buildGrid(7, 'congo_v1');

// A crowned eagle lifts its kill to a branch and feeds on it over days (Phase B research [25]).
// It is no scavenger: it returns to its own cached kill and to nothing else's.
describe('the crowned eagle, a raptor', () => {
  const eagle = { id: 'crowned_eagle_0001', speciesId: 'crowned_eagle', patchId: 12_880, alive: true, sex: 'female', ageDays: 3000,
    lifeStage: 'adult', dependentOn: null, offspringIds: [], massKg: 4, state: 'resting',
    drives: { hunger: 0.6, thirst: 0.1, fatigue: 0.1, fear: 0 }, traits: { sensoryAcuity: 0.5 } } as unknown as Agent;
  const view = (carcasses: ReturnType<typeof makeCarcass>[]): WorldView => ({ grid: CONGO_GRID, patches, worldTime: 100,
    agentsInPatch: (id) => (id === eagle.patchId ? [eagle] : []), carcassesInPatch: (id) => carcasses.filter((c) => c.patchId === id),
    speciesOf: (id) => CONGO.get(id)!, groupPatch: () => null });
  it('hunts, and returns to its own cached kill', () => {
    expect(goalsFor('raptor')).toEqual(expect.arrayContaining(['hunt', 'scavenge']));
    const own = { ...makeCarcass('c_own', 'blue_duiker_0002', 'blue_duiker', eagle.patchId, 0, 'predation', 'authoritative', 4.5), cachedBy: eagle.id };
    const other = makeCarcass('c_other', 'bay_duiker_0003', 'bay_duiker', eagle.patchId, 0, 'disease', 'authoritative', 20);
    const cfg = CONGO.get('crowned_eagle')!;
    expect(perceive(eagle, cfg, view([own, other])).carrion?.carcass.id).toBe('c_own');
    expect(perceive(eagle, cfg, view([other])).carrion).toBeNull();
  });

  it('carries every kill up into the canopy, swamp forest too, so one duiker feeds it for days', () => {
    const w = createWorld({ seed: 5, speciesDir: fileURLToPath(new URL('../../../config/species-congo', import.meta.url)), terrainProfile: 'congo_v1',
      initialAgents: { blue_duiker: 2500, water_chevrotain: 400, agile_mangabey: 400, crowned_eagle: 40 }, minPopulation: {}, retainEvents: 'all' });
    w.step(24 * 6);
    const kills = w.log.all().filter((e) => e.type === 'hunt' && e.outcome === 'success' && e.actors[0]!.startsWith('crowned_eagle_'));
    expect(kills.length).toBeGreaterThan(5);
    expect(kills.every((e) => e.conditions?.cachedInTree === 1)).toBe(true);
  }, 300_000);
});
