import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SIM_VERSION, createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot, upgradeV5Snapshot, upgradeV7Snapshot, upgradeV8Snapshot, upgradeV16Snapshot, upgradeV17Snapshot, upgradeV18Snapshot, upgradeV19Snapshot, upgradeV20Snapshot, upgradeV21Snapshot, upgradeV22Snapshot, upgradeV23Snapshot, upgradeV24Snapshot, upgradeV25Snapshot, upgradeV26Snapshot, upgradeV27Snapshot, upgradeV28Snapshot, upgradeV29Snapshot, upgradeV30Snapshot, type Snapshot } from '../src/snapshot.js';
import { establishFloweringGuild } from '../src/fields/floweringGuild.js';
import { asLegacySnapshot } from './legacySnapshot.js';
import { navigate } from '../src/agents/navigation.js';
import { conceive } from '../src/agents/reproduction.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const options = { seed: 5, speciesDir, initialAgents: { sambar: 20 }, minPopulation: { sambar: 20 } };

/** Older snapshot fixtures retain their saved rules version. */
function legacySnapshot(snapshot: Snapshot, simVersion: string): Snapshot {
  return asLegacySnapshot(snapshot, simVersion);
}

function expectFishMigration(upgraded: Snapshot, old: Snapshot): void {
  const expected = structuredClone(old);
  expected.simVersion = SIM_VERSION;
  for (const patch of expected.microEcology?.patches ?? []) patch.lastFishSpawnYear =
    Math.floor(old.worldTime / (360 * 86_400)) + 1;
  establishFloweringGuild(expected.patches, old.worldTime, true);
  expect(upgraded).toEqual(expected);
}

describe('snapshots', () => {
  it('opts a real v0.30 world into the held-kill rule and steerable animals without rewriting its state', () => {
    const current = takeSnapshot(createWorld({ ...options, initialAgents: { boar: 3 }, minPopulation: {} }));
    const old = structuredClone(current); old.simVersion = 'sim_0.30.0';
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, { ...options, initialAgents: { boar: 3 }, minPopulation: {} })).toThrow(/version/);
    const upgraded = upgradeV30Snapshot(old);
    expect(upgraded).toEqual(current);
    expect(old).toEqual(before);
    expect(() => upgradeV30Snapshot(upgraded)).toThrow(/only sim_0.30.0/);
  });
  it('opts a real v0.29 world into off-centre water access without rewriting its state', () => {
    const current = takeSnapshot(createWorld({ ...options, initialAgents: { chital: 3 }, minPopulation: {} }));
    const old = structuredClone(current); old.simVersion = 'sim_0.29.0';
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, { ...options, initialAgents: { chital: 3 }, minPopulation: {} })).toThrow(/version/);
    const upgraded = upgradeV29Snapshot(old);
    expect(upgraded).toEqual(current);
    expect(old).toEqual(before);
    expect(() => upgradeV29Snapshot(upgraded)).toThrow(/only sim_0.29.0/);
  });
  it('opts a real v0.28 world into mate-response rules without rewriting its state', () => {
    const current = takeSnapshot(createWorld({ ...options, initialAgents: { dhole: 3 }, minPopulation: {} }));
    const old = structuredClone(current); old.simVersion = 'sim_0.28.0';
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, { ...options, initialAgents: { dhole: 3 }, minPopulation: {} })).toThrow(/version/);
    const upgraded = upgradeV28Snapshot(old);
    expect(upgraded).toEqual(current);
    expect(old).toEqual(before);
    expect(restoreSnapshot(upgraded, { ...options, initialAgents: { dhole: 3 }, minPopulation: {} }).agents)
      .toEqual(current.agents);
    expect(() => upgradeV28Snapshot(upgraded)).toThrow(/only sim_0.28.0/);
  });
  it('opts v0.27 into flowering without rewriting a live fish cohort or inventing a bloom', () => {
    const old = legacySnapshot(takeSnapshot(createWorld(options)), 'sim_0.27.0');
    const fish = old.microEcology!.patches.find(patch => patch.fishBiomassKg > 0)!;
    fish.fishBiomassKg -= 0.001;
    fish.fishCohort = { stage: 'eggs', biomassKg: 0.001,
      spawnedAt: 0, hatchAt: 2 * 3600, recruitAt: 22 * 86400 };
    fish.lastFishSpawnYear = 1;
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV27Snapshot(old);
    expect(upgraded.microEcology!.patches[fish.patchId]).toEqual(fish);
    expect(upgraded.patches.some(patch => patch.floweringGuild?.bloom)).toBe(false);
    expect(upgraded.patches.filter(patch => patch.floweringGuild).every(patch =>
      patch.floweringGuild!.lastBloomYear === 1)).toBe(true);
    expect(restoreSnapshot(upgraded, options).totalNutrients()).toBeCloseTo(createWorld(options).totalNutrients(), 7);
    expect(old).toEqual(before);
    const forged = structuredClone(old);
    forged.patches.find(patch => patch.habitat === 'water')!.floweringGuild =
      structuredClone(upgraded.patches.find(patch => patch.floweringGuild)!.floweringGuild!);
    expect(() => upgradeV27Snapshot(forged)).toThrow(/already established/);
  });
  it('requires explicit v0.26 fish recruitment upgrade with no retroactive egg cohort', () => {
    const old = legacySnapshot(takeSnapshot(createWorld(options)), 'sim_0.26.0');
    for (const patch of old.microEcology!.patches) delete (patch as Partial<typeof patch>).lastFishSpawnYear;
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV26Snapshot(old);
    expect(upgraded.simVersion).toBe(SIM_VERSION);
    expect(upgraded.microEcology!.patches.every(patch => patch.lastFishSpawnYear === 1
      && patch.fishCohort === undefined)).toBe(true);
    expect(restoreSnapshot(upgraded, options).totalNutrients())
      .toBeCloseTo(createWorld(options).totalNutrients(), 8);
    expect(old).toEqual(before);
    expect(() => upgradeV26Snapshot({ ...old, simVersion: 'sim_0.25.0' })).toThrow();
    const forged = structuredClone(old);
    forged.microEcology!.patches[0]!.fishCohort = { stage: 'eggs', biomassKg: 0.01,
      spawnedAt: 0, hatchAt: 7200, recruitAt: 72_000 };
    expect(() => upgradeV26Snapshot(forged)).toThrow(/future fish cohort/);
  });
  it('requires explicit v0.25 wound-rule upgrade without inventing a historic injury', () => {
    const old = legacySnapshot(takeSnapshot(createWorld(options)), 'sim_0.25.0');
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV25Snapshot(old);
    expectFishMigration(upgraded, old);
    expect(upgraded.agents.every(agent => agent.wound === undefined)).toBe(true);
    expect(restoreSnapshot(upgraded, options).agents).toEqual(old.agents);
    expect(old).toEqual(before);
    expect(() => upgradeV25Snapshot({ ...old, simVersion: 'sim_0.24.0' })).toThrow();
    const forged = structuredClone(old);
    forged.agents[0]!.wound = { kind: 'contact_injury', phase: 'open', sourceHuntEventId: 'hunt_fake',
      woundEventId: 'wound_fake', acquiredAt: 0, lastUpdatedAt: 0, severity: 0.3,
      recoveryRemainingHours: 10, infectionBudget: 1, mortalityBudget: 1 };
    expect(() => upgradeV25Snapshot(forged)).toThrow(/future rules/);
  });
  it('requires explicit v0.24 climb rule upgrade without putting a saved ground animal in a tree', () => {
    const config = { ...options, initialAgents: { langur: 2, squirrel: 2 }, minPopulation: {} };
    const old = legacySnapshot(takeSnapshot(createWorld(config)), 'sim_0.24.0');
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, config)).toThrow(/version/);
    const upgraded = upgradeV24Snapshot(old);
    expectFishMigration(upgraded, old);
    expect(restoreSnapshot(upgraded, config).agents).toEqual(old.agents);
    expect(old.agents.every(agent => agent.altitudeM === undefined && agent.treeAnchorId === undefined)).toBe(true);
    expect(old).toEqual(before);
    expect(() => upgradeV24Snapshot({ ...old, simVersion: 'sim_0.23.0' })).toThrow();
  });
  it('requires explicit v0.23 tiger-meat rule upgrade without granting food or moving a cub', () => {
    const config = { ...options, initialAgents: { tiger: 2 }, minPopulation: {} };
    const old = legacySnapshot(takeSnapshot(createWorld(config)), 'sim_0.23.0');
    old.agents[0]!.ageDays = 80;
    old.agents[0]!.dependentOn = old.agents[1]!.id;
    old.agents[0]!.drives.hunger = 0.8;
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, config)).toThrow(/version/);
    const upgraded = upgradeV23Snapshot(old);
    expectFishMigration(upgraded, old);
    expect(restoreSnapshot(upgraded, config).agents).toEqual(old.agents);
    expect(old).toEqual(before);
    expect(() => upgradeV23Snapshot({ ...old, simVersion: 'sim_0.22.0' })).toThrow();
  });
  it('requires explicit v0.22 tiger-water rule upgrade without giving a cub water or moving it', () => {
    const config = { ...options, initialAgents: { tiger: 2 }, minPopulation: {} };
    const old = legacySnapshot(takeSnapshot(createWorld(config)), 'sim_0.22.0');
    old.agents[0]!.ageDays = 80;
    old.agents[0]!.dependentOn = old.agents[1]!.id;
    old.agents[0]!.drives.thirst = 0.8;
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, config)).toThrow(/version/);
    const upgraded = upgradeV22Snapshot(old);
    expectFishMigration(upgraded, old);
    expect(restoreSnapshot(upgraded, config).agents).toEqual(old.agents);
    expect(old).toEqual(before);
    expect(() => upgradeV22Snapshot({ ...old, simVersion: 'sim_0.21.0' })).toThrow();
  });
  it('requires an explicit v0.21 upgrade and starts existing boar hydration clocks without credit', () => {
    const config = { ...options, initialAgents: { boar: 2 }, minPopulation: {} };
    const old = { ...legacySnapshot(takeSnapshot(createWorld(config)), 'sim_0.21.0'), worldTime: 7 * 86400 };
    const young = old.agents[0]!;
    young.bornAt = 0; young.ageDays = 7; young.dependentOn = old.agents[1]!.id;
    young.lastMaternalWaterAt = undefined;
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, config)).toThrow(/version/);
    const upgraded = upgradeV21Snapshot(old);
    expect(upgraded.simVersion).toBe(SIM_VERSION);
    expect(upgraded.agents[0]!.lastMaternalWaterAt).toBe(old.worldTime);
    expect(upgraded.agents[0]!.drives).toEqual(old.agents[0]!.drives);
    expect(upgraded.agents[1]).toEqual(old.agents[1]);
    expect(old).toEqual(before);
    expect(() => upgradeV21Snapshot({ ...old, simVersion: 'sim_0.20.0' })).toThrow();
  });
  it('rejects impossible saved maternal water-care times', () => {
    const config = { ...options, initialAgents: { boar: 1 }, minPopulation: {} };
    const snapshot = takeSnapshot(createWorld(config));
    snapshot.agents[0]!.lastMaternalWaterAt = snapshot.worldTime + 1;
    expect(() => restoreSnapshot(snapshot, config)).toThrow(/maternal water-care/);
    snapshot.agents[0]!.lastMaternalWaterAt = Number.NaN;
    expect(() => restoreSnapshot(snapshot, config)).toThrow(/maternal water-care/);
  });
  it('also starts boar care clocks at the upgrade boundary for pre-v0.21 saves', () => {
    const config = { ...options, initialAgents: { boar: 2 }, minPopulation: {} };
    const old = { ...legacySnapshot(takeSnapshot(createWorld(config)), 'sim_0.20.0'), worldTime: 5 * 86400 };
    old.agents[0]!.dependentOn = old.agents[1]!.id;
    old.agents[0]!.ageDays = 5;
    const before = structuredClone(old);
    const upgraded = upgradeV20Snapshot(old);
    expect(upgraded.agents[0]!.lastMaternalWaterAt).toBe(old.worldTime);
    expect(upgraded.agents[1]!.lastMaternalWaterAt).toBeUndefined();
    expect(upgraded.agents[0]!.drives).toEqual(old.agents[0]!.drives);
    expect(old).toEqual(before);
  });
  it('opts v0.20 saves into illness rules without inventing an episode or mutating the saved world', () => {
    const old = legacySnapshot(takeSnapshot(createWorld(options)), 'sim_0.20.0');
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV20Snapshot(old);
    expectFishMigration(upgraded, old);
    expect(upgraded.agents.every(a => a.illness === undefined)).toBe(true);
    expect(restoreSnapshot(upgraded, options).agents).toEqual(old.agents);
    expect(old).toEqual(before);
    expect(() => upgradeV20Snapshot({ ...old, simVersion: 'sim_0.19.0' })).toThrow();
  });
  it('rejects malformed persisted illness instead of silently curing or rerolling it', () => {
    const snapshot = takeSnapshot(createWorld(options));
    snapshot.agents[0]!.illness = { kind: 'carrion_infection', phase: 'active',
      sourceCarcassId: 'carcass_1', sourceMealEventId: 'meal_1', contractedEventId: 'contracted_1',
      onsetEventId: 'onset_1', acquiredAt: 0, incubationUntil: 1, lastUpdatedAt: 2,
      severity: 0.4, recoveryRemainingHours: 20, mortalityBudget: -1 };
    expect(() => restoreSnapshot(snapshot, options)).toThrow(/invalid illness/);
  });
  it('opts v0.19 island saves into basins without inventing water or losing displaced plants', () => {
    const island = { ...options, seed: 1, terrainProfile: 'island_v1' as const,
      initialAgents: {}, minPopulation: {} };
    const old = legacySnapshot(takeSnapshot(createWorld(island)), 'sim_0.19.0');
    const basinIds = old.patches.filter(p => p.surface === 'land' && p.habitat === 'water').map(p => p.id);
    expect(basinIds.length).toBe(2);
    for (const id of basinIds) {
      const patch = old.patches[id]!;
      patch.habitat = 'marsh'; patch.capacity = { grass: 3500, browse: 900 };
      patch.plant = { grass: 123, browse: 45 }; patch.waterVolume = 813;
      patch.soilNutrients = 701;
    }
    old.waterBudget!.initialL = old.patches.reduce((n, p) => n + p.waterVolume, 0);
    const saved = structuredClone(old);
    const beforeWater = old.patches.reduce((n, p) => n + p.waterVolume, 0);
    const beforeNutrients = old.patches.reduce((n, p) => n + p.soilNutrients + p.plant.grass + p.plant.browse, 0);
    expect(() => restoreSnapshot(old, island)).toThrow(/version/);
    const upgraded = upgradeV19Snapshot(old);
    expect(upgraded.simVersion).toBe(SIM_VERSION);
    expect(upgraded.patches.reduce((n, p) => n + p.waterVolume, 0)).toBeCloseTo(beforeWater, 9);
    expect(upgraded.patches.reduce((n, p) => n + p.soilNutrients + p.plant.grass + p.plant.browse
      + (p.floweringGuild?.vegetativeKg ?? 0), 0))
      .toBeCloseTo(beforeNutrients, 9);
    expect(upgraded.waterBudget).toEqual(old.waterBudget);
    for (const id of basinIds) {
      expect(upgraded.patches[id]!.habitat).toBe('water');
      expect(upgraded.patches[id]!.waterVolume).toBe(813);
      expect(upgraded.patches[id]!.soilNutrients).toBe(701 + 123 + 45);
    }
    expect(restoreSnapshot(upgraded, island).patches).toEqual(upgraded.patches);
    expect(old).toEqual(saved);
    expect(() => upgradeV19Snapshot({ ...old, simVersion: 'sim_0.18.0' })).toThrow();
  });
  it('upgrades v0.18 without inventing freshwater biomass or mutating the saved state', () => {
    const old = legacySnapshot(takeSnapshot(createWorld(options)), 'sim_0.18.0');
    for (const patch of old.microEcology!.patches)
      delete (patch as Partial<typeof patch>).aquaticProducerBiomassKg;
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV18Snapshot(old);
    expect(upgraded.simVersion).toBe(SIM_VERSION);
    expect(upgraded.microEcology!.patches.every(patch => patch.aquaticProducerBiomassKg === 0)).toBe(true);
    expect(restoreSnapshot(upgraded, options).microEcology).toEqual(upgraded.microEcology);
    expect(old).toEqual(before);
    expect(() => upgradeV18Snapshot({ ...old, simVersion: 'sim_0.17.0' })).toThrow();
  });
  it('also fills absent producer fields in direct v0.17 rules upgrades', () => {
    const old = legacySnapshot(takeSnapshot(createWorld(options)), 'sim_0.17.0');
    delete (old.microEcology!.patches[0]! as { aquaticProducerBiomassKg?: number }).aquaticProducerBiomassKg;
    const upgraded = upgradeV17Snapshot(old);
    expect(upgraded.microEcology!.patches[0]!.aquaticProducerBiomassKg).toBe(0);
    expect(old.microEcology!.patches[0]!.aquaticProducerBiomassKg).toBeUndefined();
    expect(() => restoreSnapshot({ ...upgraded, microEcology: old.microEcology }, options))
      .toThrow(/aquatic producer/);
  });
  it('requires an explicit, non-mutating v0.17 young-boar rules upgrade', () => {
    const configured = { ...options, communityProfile: 'household_v1' as const };
    const old = legacySnapshot(takeSnapshot(createWorld(configured)), 'sim_0.17.0');
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, configured)).toThrow(/version/);
    const upgraded = upgradeV17Snapshot(old);
    expectFishMigration(upgraded, old);
    expect(restoreSnapshot(upgraded, configured).community).toEqual(old.community);
    upgraded.agents[0]!.drives.hunger = 1;
    expect(old).toEqual(before);
    expect(() => upgradeV17Snapshot({ ...old, simVersion: 'sim_0.16.0' })).toThrow();
  });
  it('requires explicit v0.16 upgrade while preserving household tasks, stocks and recorded clock', () => {
    const configured = { ...options, communityProfile: 'household_v1' as const };
    const world = createWorld(configured); world.step(.1);
    const old = legacySnapshot(takeSnapshot(world), 'sim_0.16.0'), before = structuredClone(old);
    expect(() => restoreSnapshot(old, configured)).toThrow(/version/);
    const upgraded = upgradeV16Snapshot(old);
    expectFishMigration(upgraded, old);
    const restored = restoreSnapshot(upgraded, configured);
    expect(restored.community).toEqual(old.community); expect(restored.now()).toBe(old.worldTime);
    upgraded.community!.stores.waterL++;
    expect(old).toEqual(before);
    expect(() => upgradeV16Snapshot({ ...old, simVersion: 'sim_0.15.0' })).toThrow();
  });
  it('explicitly upgrades v0.8 and resumes a partially travelled route through JSON state', () => {
    const world = createWorld(options); const agent = world.agents[0]!;
    const destination = world.patches[agent.patchId]!.neighbours[0]!;
    const cfg = world.species.get(agent.speciesId)!;
    navigate(agent, cfg, world.patches, destination, 'wander', world.now(), 1);
    expect(agent.journey).toBeDefined();
    const snapshot = takeSnapshot(world);
    const old = legacySnapshot(snapshot, 'sim_0.8.0');
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV8Snapshot(old);
    expectFishMigration(upgraded, old);
    expect(old.simVersion).toBe('sim_0.8.0');
    expect(() => upgradeV8Snapshot({ ...old, simVersion: 'sim_0.7.0' })).toThrow();
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snapshot)), options);
    const a = navigate(agent, cfg, world.patches, destination, 'wander', 1, 10);
    const b = navigate(restored.agents[0]!, cfg, restored.patches, destination, 'wander', 1, 10);
    expect(b).toEqual(a); expect(restored.agents[0]).toEqual(agent);
  });
  it('requires an explicit v0.7 contact-rules upgrade without changing stored state', () => {
    const old = legacySnapshot(takeSnapshot(createWorld(options)), 'sim_0.7.0');
    const before = structuredClone(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV7Snapshot(old);
    expectFishMigration(upgraded, old);
    expect(restoreSnapshot(upgraded, options).agents).toEqual(old.agents);
    upgraded.agents[0]!.drives.hunger = 0.9;
    expect(old).toEqual(before);
    expect(() => upgradeV7Snapshot({ ...old, simVersion: 'sim_0.6.0' })).toThrow();
  });
  it('requires an explicit, non-mutating upgrade of the known previous rules version', () => {
    const old = legacySnapshot(takeSnapshot(createWorld(options)), 'sim_0.5.0');
    const before = JSON.stringify(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV5Snapshot(old);
    expect(upgraded.simVersion).toBe(SIM_VERSION);
    expect(restoreSnapshot(upgraded, options).agents).toEqual(old.agents);
    expect(JSON.stringify(old)).toBe(before);
    expect(() => upgradeV5Snapshot({ ...old, simVersion: 'sim_0.4.0' })).toThrow();
  });
  it('round-trips through JSON without losing state', () => {
    const w = createWorld(options);
    for (let h = 0; h < 240; h++) w.step(1);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(w))), options);

    expect(restored.now()).toBe(w.now());
    expect(restored.agents).toEqual(w.agents);
    expect(restored.patches).toEqual(w.patches);
    expect(restored.totalNutrients()).toBeCloseTo(w.totalNutrients(), 6);
  });

  it('continues from the restored state with identical results', () => {
    const w = createWorld(options);
    for (let h = 0; h < 100; h++) w.step(1);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(w))), options);

    const past = new Set(w.log.take().map((e) => e.id));
    for (let h = 0; h < 50; h++) { w.step(1); restored.step(1); }
    expect(restored.log.all()).toEqual(w.log.all());
    expect(restored.log.all().some((e) => past.has(e.id))).toBe(false);

    expect(restored.now()).toBe(w.now());
    expect(restored.agents.map((a) => [a.id, a.patchId, a.alive, a.drives.hunger]))
      .toEqual(w.agents.map((a) => [a.id, a.patchId, a.alive, a.drives.hunger]));
  });

  it('records the sim version so an incompatible snapshot is detectable', () => {
    const w = createWorld(options);
    expect(takeSnapshot(w).simVersion).toBe(SIM_VERSION);
    expect(() => restoreSnapshot({ ...takeSnapshot(w), simVersion: 'sim_9.9.9' }, options))
      .toThrow(/version/i);
  });

  it('preserves runtime population floors across restore', () => {
    const config = { ...options, initialAgents: { sambar: 1 }, minPopulation: { sambar: 1 } };
    const a = createWorld(config);
    const b = restoreSnapshot(takeSnapshot(a), config);
    a.agents[0]!.drives.hunger = 1;
    b.agents[0]!.drives.hunger = 1;
    a.step(1); b.step(1);
    expect(a.livingCount('sambar')).toBe(1);
    expect(b.livingCount('sambar')).toBe(1);
  });

  it('preserves the pregnancy father through restore and real world birth despite another target', () => {
    const config = { ...options, initialAgents: { tiger: 2, sambar: 1 }, minPopulation: {} };
    const w = createWorld(config);
    const [mother, father] = w.agents.filter((a) => a.speciesId === 'tiger');
    mother!.sex = 'female'; father!.sex = 'male';
    conceive(mother!, father!, -w.species.get('tiger')!.lifecycle.gestationDays * 86400);
    mother!.targetId = w.agents.find((a) => a.speciesId === 'sambar')!.id;
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(w))), config);
    restored.step(1);
    const children = restored.agents.filter((a) => a.motherId === mother!.id);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) expect(child.fatherId).toBe(father!.id);
  });

  it('preserves the nutrient ledger so conservation survives a restore', () => {
    const w = createWorld(options);
    for (let h = 0; h < 480; h++) w.step(1);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(w))), options);
    expect(restored.ledger).toEqual(w.ledger);
  });
});
