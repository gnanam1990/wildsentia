import { describe, expect, it } from 'vitest';
import { NUTRIENT_PER_KG_BIOMASS } from '@vana/shared';
import { SIM_VERSION, createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot, upgradeV36Snapshot, type Snapshot } from '../src/snapshot.js';
import { SPECIES_DIR, speciesOf } from './helpers.js';

const island = (agents: Record<string, number>) => ({ seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v1' as const,
  initialAgents: agents, minPopulation: {} });

/** A saved sim_0.36.0 world: no rooting food, no body condition, no leopards. */
function asV36(snapshot: Snapshot): Snapshot {
  const old = structuredClone(snapshot);
  old.simVersion = 'sim_0.36.0';
  for (const patch of old.patches) if (patch.rooting) { patch.soilNutrients += patch.rooting.kg * NUTRIENT_PER_KG_BIOMASS; delete patch.rooting; }
  for (const agent of [...old.agents, ...old.deceased]) delete agent.condition;
  return old;
}
const total = (s: Snapshot) => s.patches.reduce((sum, p) => sum + p.soilNutrients
  + (p.plant.grass + p.plant.browse + (p.rooting?.kg ?? 0)) * NUTRIENT_PER_KG_BIOMASS, 0);

describe('sim_0.37.0 upgrade of a saved sim_0.36.0 world', () => {
  it('is refused without the explicit upgrade and never rewrites the old checkpoint', () => {
    const options = island({ boar: 4, tiger: 2 });
    const old = asV36(takeSnapshot(createWorld(options)));
    const before = JSON.stringify(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    upgradeV36Snapshot(old);
    expect(JSON.stringify(old)).toBe(before);
    expect(() => upgradeV36Snapshot({ ...old, simVersion: 'sim_0.35.0' })).toThrow(/only sim_0.36.0/);
  });

  it('gives each land patch its rooting food out of its own soil, keeps every animal, and schedules a leopard pair', () => {
    const options = island({ boar: 4, dhole: 4, tiger: 2 });
    const old = asV36(takeSnapshot(createWorld(options)));
    const upgraded = upgradeV36Snapshot(old);
    expect(upgraded.simVersion).toBe(SIM_VERSION);
    expect(upgraded.agents).toEqual(old.agents);
    expect(upgraded.patches.some(p => p.rooting)).toBe(true);
    expect(total(upgraded)).toBeCloseTo(total(old), 6);
    expect(upgraded.pendingArrivals).toEqual([{ speciesId: 'leopard', sex: 'male', trigger: 'rules_upgrade' },
      { speciesId: 'leopard', sex: 'female', trigger: 'rules_upgrade' }]);
  });

  it('brings the pair ashore at the next day boundary as recorded, ledgered arrivals', () => {
    const options = island({ boar: 4, tiger: 2 });
    const world = restoreSnapshot(upgradeV36Snapshot(asV36(takeSnapshot(createWorld(options)))), options);
    const nutrients = world.totalNutrients(), imported = world.ledger.imported;
    // A checkpoint before the arrival keeps the schedule.
    expect(takeSnapshot(world).pendingArrivals?.length).toBe(2);
    world.step(24);
    const cats = world.agents.filter(a => a.speciesId === 'leopard');
    expect(cats.map(a => a.sex).sort()).toEqual(['female', 'male']);
    const arrivals = world.log.all().filter(e => e.type === 'immigration');
    expect(arrivals.map(e => e.conditions.species)).toEqual(['leopard', 'leopard']);
    for (const e of arrivals) {
      expect(e.conditions).toMatchObject({ route: 'island_crossing', trigger: 'rules_upgrade' });
      expect(e.position).toBeDefined();
      expect(e.worldTime).toBe(86400);
    }
    const mass = cats.reduce((kg, a) => kg + a.massKg, 0);
    expect(mass).toBe(speciesOf('leopard').body.massBySexKg!.male + speciesOf('leopard').body.massBySexKg!.female);
    expect(world.ledger.imported - imported).toBeCloseTo(mass * NUTRIENT_PER_KG_BIOMASS, 9);
    expect(world.totalNutrients()).toBeCloseTo(nutrients, 3);
    expect(takeSnapshot(world).pendingArrivals).toBeUndefined();
  });

  it('schedules nothing for a mainland world or an island that already has leopards, and rejects a bad schedule', () => {
    const mainland = { seed: 3, speciesDir: SPECIES_DIR, initialAgents: { boar: 2 }, minPopulation: {} };
    expect(upgradeV36Snapshot(asV36(takeSnapshot(createWorld(mainland)))).pendingArrivals).toBeUndefined();
    const withCats = island({ leopard: 2 });
    expect(upgradeV36Snapshot(asV36(takeSnapshot(createWorld(withCats)))).pendingArrivals).toBeUndefined();
    const options = island({ boar: 2 });
    const bad = upgradeV36Snapshot(asV36(takeSnapshot(createWorld(options))));
    bad.pendingArrivals = [{ speciesId: 'dragon', sex: 'male', trigger: 'rules_upgrade' }];
    expect(() => restoreSnapshot(bad, options)).toThrow(/pending arrival/);
    expect(() => restoreSnapshot({ ...bad, pendingArrivals: [{ speciesId: 'leopard', sex: 'male', trigger: 'x' }] }, mainland))
      .toThrow();
  });
});
