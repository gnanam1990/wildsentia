import { fileURLToPath } from 'node:url';
import { initialPosition, treeAnchorForPatch, treeAnchorGeometry } from '@vana/shared';
import { describe, expect, it } from 'vitest';
import { navigate } from '../src/agents/navigation.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';
import { createWorld } from '../src/world.js';
import { ISLAND_GRID } from '@vana/shared';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const options = { seed: 5, speciesDir, initialAgents: { langur: 1, squirrel: 1 }, minPopulation: {} };

function perchedSnapshot() {
  const snapshot = takeSnapshot(createWorld(options));
  const patch = snapshot.patches.find(patch => treeAnchorForPatch(ISLAND_GRID, patch))!;
  const anchor = treeAnchorForPatch(ISLAND_GRID, patch)!;
  const animal = snapshot.agents.find(agent => agent.speciesId === 'langur')!;
  animal.patchId = patch.id;
  animal.position = { x: anchor.x, z: anchor.z, heading: 0 };
  animal.altitudeM = 1.25;
  animal.locomotionMode = 'climb';
  animal.treeAnchorId = anchor.id;
  return { snapshot, patch, anchor, animal };
}

describe('optional authoritative vertical fields in snapshots', () => {
  it('preserves a coherent partial climb and stable canopy-loss remnant without inventing movement', () => {
    const { snapshot, patch, anchor, animal } = perchedSnapshot();
    const before = structuredClone(snapshot);
    const restored = restoreSnapshot(snapshot, options);
    expect(restored.agents.find(a => a.id === animal.id)).toEqual(animal);
    expect(snapshot).toEqual(before);
    patch.canopyCover = 0;
    expect(treeAnchorForPatch(ISLAND_GRID, patch)).toBeNull();
    const remnant = restoreSnapshot(snapshot, options);
    expect(remnant.agents.find(a => a.id === animal.id)?.treeAnchorId).toBe(anchor.id);
    expect(remnant.agents.find(a => a.id === animal.id)?.altitudeM).toBe(1.25);
    expect(treeAnchorGeometry(ISLAND_GRID, patch.id)?.id).toBe(anchor.id);
  });

  it('rejects malformed tree identity, position, species, height and mode without repairing them', () => {
    const { snapshot, patch, anchor, animal } = perchedSnapshot();
    const malformed = [
      { treeAnchorId: `tree-v1:${patch.id + 1}` },
      { treeAnchorId: undefined },
      { position: { ...animal.position!, x: anchor.x + .001 } },
      { position: initialPosition(ISLAND_GRID, 'wrong-patch', patch.neighbours[0]!) },
      { position: undefined },
      { speciesId: 'boar' },
      { altitudeM: undefined },
      { altitudeM: 0 },
      { altitudeM: 6.01 },
      { altitudeM: -1 },
      { altitudeM: Number.NaN },
      { altitudeM: Number.POSITIVE_INFINITY },
      { locomotionMode: undefined },
      { locomotionMode: 'ground' },
      { locomotionMode: 'flight' },
    ];
    for (const fields of malformed) {
      const broken = structuredClone(snapshot);
      Object.assign(broken.agents.find(a => a.id === animal.id)!, fields);
      const before = structuredClone(broken);
      expect(() => restoreSnapshot(broken, options), JSON.stringify(fields)).toThrow(/invalid vertical checkpoint/);
      expect(broken).toEqual(before);
    }
    const nonWooded = structuredClone(snapshot);
    nonWooded.patches[patch.id]!.habitat = 'rock';
    expect(() => restoreSnapshot(nonWooded, options)).toThrow(/invalid vertical checkpoint/);
    const deceased = structuredClone(snapshot);
    deceased.deceased.push({ ...deceased.agents.find(a => a.id === animal.id)!,
      id: 'deceased-malformed-climber', treeAnchorId: 'tree-v1:999' });
    expect(() => restoreSnapshot(deceased, options)).toThrow(/invalid vertical checkpoint/);
  });

  it('round-trips an island perch but refuses a coast cell with a syntactically valid anchor id', () => {
    const islandOptions = { ...options, seed: 1, terrainProfile: 'island_v1' as const,
      initialAgents: { langur: 1 } };
    const snapshot = takeSnapshot(createWorld(islandOptions));
    const wooded = snapshot.patches.find(patch => treeAnchorForPatch(ISLAND_GRID, patch))!;
    const anchor = treeAnchorForPatch(ISLAND_GRID, wooded)!;
    const animal = snapshot.agents[0]!;
    Object.assign(animal, { patchId: wooded.id, position: { x: anchor.x, z: anchor.z, heading: 0 },
      altitudeM: 2.5, locomotionMode: 'climb', treeAnchorId: anchor.id });
    expect(restoreSnapshot(snapshot, islandOptions).agents[0]).toEqual(animal);
    const coast = snapshot.patches.find(patch => patch.surface === 'coast')!;
    const falseAnchor = treeAnchorGeometry(ISLAND_GRID, coast.id)!;
    animal.patchId = coast.id;
    animal.position = { x: falseAnchor.x, z: falseAnchor.z, heading: 0 };
    animal.treeAnchorId = falseAnchor.id;
    expect(() => restoreSnapshot(snapshot, islandOptions)).toThrow(/invalid vertical checkpoint/);
  });

  it('accepts existing v0.23 ground checkpoints and real partial vulture flight without a tree anchor', () => {
    const ground = takeSnapshot(createWorld(options));
    expect(ground.agents.every(agent => agent.treeAnchorId === undefined)).toBe(true);
    expect(restoreSnapshot(ground, options).agents).toEqual(ground.agents);
    const flightOptions = { ...options, initialAgents: { vulture: 1 } };
    const flightWorld = createWorld(flightOptions), bird = flightWorld.agents[0]!;
    const destination = (bird.patchId + 24) % flightWorld.patches.length;
    const moved = navigate(ISLAND_GRID, bird, flightWorld.species.get('vulture')!, flightWorld.patches,
      destination, 'scavenge', 0, 5);
    expect(moved.trace.completed).toBe(false);
    expect(bird.locomotionMode).toBe('flight');
    expect(bird.altitudeM).toBeGreaterThan(0);
    const flight = takeSnapshot(flightWorld);
    expect(restoreSnapshot(flight, flightOptions).agents).toEqual(flight.agents);
    flight.agents[0]!.treeAnchorId = 'tree-v1:0';
    expect(() => restoreSnapshot(flight, flightOptions)).toThrow(/invalid vertical checkpoint/);
  });
});
