import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { patchCentre } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { SPECIES_DIR } from './helpers.js';

const CONGO_DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const options = { seed: 7, speciesDir: CONGO_DIR, terrainProfile: 'congo_v1' as const, minPopulation: {} };
const congo = () => createWorld({ ...options, initialAgents: { african_leopard: 6, blue_duiker: 40 } });

// Congo 1C: an owned animal is a sim animal that carries its asset; only its owner's side may steer it.
describe('owned animals', () => {
  it('are placed as adults on a patch their species can live on, with nothing public to mark them', () => {
    const world = congo();
    const patchId = world.safeSpawnPatches('blue_duiker', 300)[0]!;
    const duiker = world.spawnOwned('blue_duiker', patchId, 'asset-1');
    expect(duiker.assetId).toBe('asset-1');
    expect(duiker.patchId).toBe(patchId);
    expect(['adult', 'elder']).toContain(duiker.lifeStage);
    // No public event marks the spawn: after founding, any spawn would point bounty hunters at an owned animal.
    expect(world.log.all().some((e) => e.actors.includes(duiker.id))).toBe(false);
    expect(() => world.spawnOwned('blue_duiker', world.patches.find((p) => p.habitat === 'water' && p.deepWater)!.id, 'asset-2')).toThrow();
    expect(() => world.spawnOwned('tiger', patchId, 'asset-3')).toThrow();
  });
  it('are steered only with the owner flag, never queued for others, and skip the species cap', () => {
    const world = congo();
    const duiker = world.spawnOwned('blue_duiker', world.safeSpawnPatches('blue_duiker', 300)[0]!, 'asset-1');
    expect(world.possess(duiker.id, 'ag_stranger')).toBe('owned');
    expect(world.possessionCandidates('blue_duiker', 1000).some((a) => a.id === duiker.id)).toBe(false);
    // Fill the wild cap for duikers, then the owner still takes theirs.
    for (const a of world.possessionCandidates('blue_duiker', 1000)) world.possess(a.id, `ag_${a.id}`);
    expect(world.possess(duiker.id, 'owner:acct', { owner: true })).toBeNull();
    expect(world.animal(duiker.id)!.controller).toBe('owner:acct');
    // Whether another holder could take it, setting aside who holds it now.
    expect(world.possessionBlock(duiker.id, { owner: true })).toBe('already_controlled');
    expect(world.possessionBlock(duiker.id, { owner: true, ignoreController: true })).toBeNull();
    duiker.altitudeM = 3;
    expect(world.possessionBlock(duiker.id, { owner: true, ignoreController: true })).toBe('off_the_ground');
  });
  it('find safe spawn patches: habitat the species founds on, with no hunter of it nearby', () => {
    const world = congo();
    const safe = world.safeSpawnPatches('blue_duiker', 300);
    expect(safe.length).toBeGreaterThan(100);
    const leopards = world.agents.filter((a) => a.alive && a.speciesId === 'african_leopard');
    for (const id of safe.slice(0, 200)) {
      const c = patchCentre(world.grid, id), patch = world.patches[id]!;
      expect(patch.habitat).not.toBe('water');
      // Wherever in the patch the animal is placed (up to 0.4 of a patch from its centre on each axis), no hunter is within 300 m.
      for (const l of leopards) expect(Math.hypot(l.position!.x - c.x, l.position!.z - c.z)).toBeGreaterThan(300 + 300 * 0.4 * Math.SQRT2);
    }
  });
  it('keep their asset through a snapshot; an island world refuses owned animals', () => {
    const world = congo();
    const duiker = world.spawnOwned('blue_duiker', world.safeSpawnPatches('blue_duiker', 300)[0]!, 'asset-9');
    const back = restoreSnapshot(takeSnapshot(world), { ...options, initialAgents: {} });
    expect(back.animal(duiker.id)!.assetId).toBe('asset-9');
    const bad = takeSnapshot(world);
    bad.agents.find((a) => a.id === duiker.id)!.assetId = '';
    expect(() => restoreSnapshot(bad, { ...options, initialAgents: {} })).toThrow('invalid owned animal');
    const island = createWorld({ seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v1', initialAgents: {}, minPopulation: {} });
    expect(() => island.spawnOwned('chital', 210, 'x')).toThrow();
  });
  it('remember how they died, and can be returned to the wild', () => {
    const world = congo();
    const duiker = world.spawnOwned('blue_duiker', world.safeSpawnPatches('blue_duiker', 300)[0]!, 'asset-1');
    duiker.drives.hunger = 1.2;
    world.step(1);
    expect(world.animal(duiker.id)!.alive).toBe(false);
    expect(world.animal(duiker.id)!.ownedDeath).toEqual({ cause: 'starvation', killerId: null, at: world.animal(duiker.id)!.departedAt });
    const wild = world.agents.find((a) => a.alive && a.speciesId === 'blue_duiker' && !a.assetId)!;
    expect(wild.ownedDeath).toBeUndefined();
    const other = world.spawnOwned('blue_duiker', world.safeSpawnPatches('blue_duiker', 300)[0]!, 'asset-2');
    world.disown(other.id);
    expect(world.animal(other.id)!.assetId).toBeUndefined();
    expect(world.possessionBlock(other.id)).not.toBe('owned');
  });
});
