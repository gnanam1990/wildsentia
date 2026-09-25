import { describe, expect, it } from 'vitest';
import { initialPosition, isMovementTrace, landWalkable, movementAt, positionInPatch,
  treeAnchorForPatch, treeAnchorGeometry, type Agent } from '@vana/shared';
import { advanceTreeVertical, TREE_VERTICAL_SPEED_MPS, validateVerticalCheckpoint } from '../src/agents/arboreal.js';
import { navigate, planRoute } from '../src/agents/navigation.js';
import { buildGrid } from '../src/grid.js';
import { makeAgent, speciesOf } from './helpers.js';

function fixture(species: 'langur' | 'squirrel' | 'boar' = 'langur') {
  const patch = buildGrid(1)[210]!;
  patch.habitat = 'shola'; patch.canopyCover = 0.8;
  const anchor = treeAnchorForPatch(patch)!;
  const agent = makeAgent(species, { id: `${species}-tree-test`, patchId: patch.id,
    position: { x: anchor.x, z: anchor.z, heading: 0.4 } });
  return { patch, anchor, agent };
}

describe('pure arboreal vertical segment', () => {
  it.each(['langur', 'squirrel'] as const)('%s ascends on its exact trunk with time and no planar teleport', (species) => {
    const { patch, anchor, agent } = fixture(species);
    const before = structuredClone(agent.position);
    const travel = advanceTreeVertical(agent, patch, 'ascend', 'flee', 3600, 3600);
    expect(TREE_VERTICAL_SPEED_MPS).toBe(0.25); // Explicit policy, not a wildlife measurement.
    expect(travel).toMatchObject({ seconds: 24, distanceM: 6, unreachable: false });
    expect(travel.trace.completed).toBe(true);
    expect(travel.trace.samples.map((s) => [s.seconds, s.altitudeM])).toEqual([[0, 0], [24, 6]]);
    expect(isMovementTrace(travel.trace)).toBe(true);
    expect(movementAt(travel.trace, 12).altitudeM).toBe(3);
    expect(agent.position).toEqual(before);
    expect(agent.patchId).toBe(patch.id);
    expect(agent.altitudeM).toBe(6);
    expect(agent.locomotionMode).toBe('climb');
    expect(agent.treeAnchorId).toBe(anchor.id);
  });

  it('persists partial ascent and resumes after JSON restore with no free height or time', () => {
    const { patch, agent, anchor } = fixture();
    const first = advanceTreeVertical(agent, patch, 'ascend', 'flee', 3600, 5);
    expect(first.trace.completed).toBe(false);
    expect(first.trace.samples.map((s) => [s.seconds, s.altitudeM])).toEqual([[0, 0], [5, 1.25]]);
    expect(isMovementTrace(first.trace)).toBe(true);
    const restored = JSON.parse(JSON.stringify(agent)) as Agent;
    expect(restored.treeAnchorId).toBe(anchor.id);
    const second = advanceTreeVertical(restored, patch, 'ascend', 'flee', 7200, 19);
    expect(second.trace.samples.map((s) => [s.seconds, s.altitudeM])).toEqual([[0, 1.25], [19, 6]]);
    expect(second.trace.completed).toBe(true);
    expect(isMovementTrace(second.trace)).toBe(true);
    expect(restored.position).toEqual(agent.position);
    expect(restored.altitudeM).toBe(6);
    expect(first.seconds + second.seconds).toBe(24);
  });

  it('can spend real time descending a stable remnant after canopy loss, then clears anchor state', () => {
    const { patch, agent } = fixture();
    advanceTreeVertical(agent, patch, 'ascend', 'flee', 0, 24);
    patch.canopyCover = 0;
    expect(treeAnchorForPatch(patch)).toBeNull();
    expect(treeAnchorGeometry(patch.id)?.id).toBe(agent.treeAnchorId);
    const first = advanceTreeVertical(agent, patch, 'descend', 'find_water', 3600, 12);
    expect(first.trace.completed).toBe(false);
    expect(first.trace.samples.map((s) => [s.seconds, s.altitudeM])).toEqual([[0, 6], [12, 3]]);
    const restored = JSON.parse(JSON.stringify(agent)) as Agent;
    const second = advanceTreeVertical(restored, patch, 'descend', 'find_water', 7200, 12);
    expect(second.trace.completed).toBe(true);
    expect(second.trace.samples.map((s) => [s.seconds, s.altitudeM])).toEqual([[0, 3], [12, 0]]);
    expect(isMovementTrace(second.trace)).toBe(true);
    expect(restored.position).toEqual(agent.position);
    expect(restored.altitudeM).toBeUndefined();
    expect(restored.locomotionMode).toBeUndefined();
    expect(restored.treeAnchorId).toBeUndefined();
    expect(advanceTreeVertical(restored, patch, 'ascend', 'flee', 10_800, 3600).unreachable).toBe(true);
  });

  it('uses no progress or mutation on zero time, unsupported species, missing canopy or off-trunk position', () => {
    const { patch, agent } = fixture();
    const before = structuredClone(agent);
    const zero = advanceTreeVertical(agent, patch, 'ascend', 'flee', 0, 0);
    expect(zero.trace.samples).toHaveLength(1);
    expect(zero.trace.completed).toBe(false);
    expect(agent).toEqual(before);
    agent.position!.x += 0.01;
    expect(advanceTreeVertical(agent, patch, 'ascend', 'flee', 0, 3600).unreachable).toBe(true);
    expect(agent.altitudeM).toBeUndefined();
    const boar = fixture('boar');
    expect(advanceTreeVertical(boar.agent, boar.patch, 'ascend', 'flee', 0, 3600).unreachable).toBe(true);
    patch.canopyCover = 0;
    agent.position = before.position;
    expect(advanceTreeVertical(agent, patch, 'ascend', 'flee', 0, 3600).unreachable).toBe(true);
  });

  it('can reverse a partial climb only along the same trunk, and a top no-op adds no seconds', () => {
    const { patch, agent } = fixture();
    advanceTreeVertical(agent, patch, 'ascend', 'flee', 0, 8);
    expect(agent.altitudeM).toBe(2);
    const reverse = advanceTreeVertical(agent, patch, 'descend', 'find_water', 3600, 4);
    expect(reverse.trace.samples.map((s) => [s.seconds, s.altitudeM])).toEqual([[0, 2], [4, 1]]);
    expect(agent.treeAnchorId).toBe(treeAnchorGeometry(patch.id)!.id);
    const resume = advanceTreeVertical(agent, patch, 'ascend', 'flee', 7200, 20);
    expect(resume.trace.completed).toBe(true);
    expect(resume.seconds).toBe(20);
    const before = structuredClone(agent);
    const top = advanceTreeVertical(agent, patch, 'ascend', 'flee', 10_800, 3600);
    expect(top.trace.completed).toBe(true);
    expect(top.trace.samples).toHaveLength(1);
    expect(top.seconds).toBe(0);
    expect(agent).toEqual(before);
  });

  it('rejects inconsistent saved state or invalid time without modifying the animal', () => {
    const { patch, agent } = fixture();
    const malformed: Array<Partial<Agent>> = [
      { altitudeM: Number.NaN }, { altitudeM: 6.01 },
      { altitudeM: 1, locomotionMode: 'climb', treeAnchorId: 'tree-v1:211' },
      { altitudeM: 1, locomotionMode: 'flight', treeAnchorId: treeAnchorGeometry(patch.id)!.id },
      { treeAnchorId: treeAnchorGeometry(patch.id)!.id },
    ];
    for (const fields of malformed) {
      const copy = { ...agent, ...fields };
      const before = structuredClone(copy);
      expect(() => advanceTreeVertical(copy, patch, 'descend', 'rest', 0, 30)).toThrow();
      expect(copy).toEqual(before);
    }
    expect(() => advanceTreeVertical(agent, patch, 'ascend', 'flee', 0.5, 30)).toThrow();
    expect(() => advanceTreeVertical(agent, patch, 'ascend', 'flee', 0, 3601)).toThrow();
    expect(agent.altitudeM).toBeUndefined();
  });

  it('can route to every eligible exact trunk on seeded mainland and island grids, then spend climb time', () => {
    for (const profile of ['mainland', 'island_v1'] as const) for (const seed of [1, 2, 3, 42]) {
      const patches = buildGrid(seed, profile);
      const eligible = patches.flatMap(patch => {
        const anchor = treeAnchorForPatch(patch);
        return anchor ? [{ patch, anchor }] : [];
      });
      expect(eligible.length).toBeGreaterThan(0);
      for (const { patch, anchor } of eligible) {
        expect(positionInPatch({ ...anchor, heading: 0 }, patch.id)).toBe(true);
        const nearby = patch.neighbours.find(id => landWalkable(patches[id]));
        const startId = nearby ?? patch.id;
        for (const species of ['langur', 'squirrel'] as const) {
          const id = `${species}-anchor-${profile}-${seed}-${patch.id}`;
          const animal = makeAgent(species, { id, patchId: startId, position: initialPosition(id, startId),
            drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 0 } });
          const endpoint = { x: anchor.x, z: anchor.z, heading: 0 };
          const route = planRoute(animal, patch.id, patches, speciesOf(species), endpoint);
          expect(route).not.toBeNull();
          const ground = navigate(animal, speciesOf(species), patches, patch.id, 'flee', 0, 3600, false, endpoint);
          expect(ground.unreachable).toBe(false);
          expect(ground.trace.completed).toBe(true);
          expect(ground.seconds).toBeGreaterThan(0);
          expect(ground.seconds).toBeLessThanOrEqual(3600);
          expect(animal.patchId).toBe(patch.id);
          expect(Math.hypot(animal.position!.x - endpoint.x, animal.position!.z - endpoint.z)).toBeLessThan(1e-6);
          const lastGround = ground.trace.samples.at(-1)!.position;
          expect(Math.hypot(lastGround.x - endpoint.x, lastGround.z - endpoint.z)).toBeLessThan(1e-6);
          const groundContact = structuredClone(animal.position);
          const ascent = advanceTreeVertical(animal, patch, 'ascend', 'flee', 3600, 4);
          expect(ascent).toMatchObject({ seconds: 4, distanceM: 1, unreachable: false });
          expect(animal.position).toEqual(groundContact);
          expect(animal.treeAnchorId).toBe(anchor.id);
          expect(() => validateVerticalCheckpoint(animal, patch)).not.toThrow();
          const descent = advanceTreeVertical(animal, patch, 'descend', 'rest', 7200, 4);
          expect(descent.trace.completed).toBe(true);
          expect(animal.treeAnchorId).toBeUndefined();
        }
      }
    }
  }, 30000);
});
