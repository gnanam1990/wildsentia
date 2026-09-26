import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWorld } from '../src/world.js';
import { makeCarcass } from '../src/fields/decomposition.js';
import { heldByPredatorOf, perceive } from '../src/agents/perception.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

describe("a predator's kill (sim_0.31.0)", () => {
  function scene() {
    const world = createWorld({ seed: 2, speciesDir, terrainProfile: 'island_v1', initialAgents: { boar: 4, tiger: 1, vulture: 1 }, minPopulation: {} });
    const tiger = world.agents.find((a) => a.speciesId === 'tiger')!;
    const boar = world.agents.find((a) => a.speciesId === 'boar')!, vulture = world.agents.find((a) => a.speciesId === 'vulture')!;
    const carcass = makeCarcass('chital_x', 'chital', 40, boar.patchId, world.now(), world.log);
    carcass.position = { ...boar.position!, x: boar.position!.x + 2 };
    world.carcasses.push(carcass);
    for (const a of [tiger, vulture]) { a.patchId = boar.patchId; a.position = { ...boar.position!, x: boar.position!.x + 3 }; }
    boar.drives.hunger = 0.7;
    return { world, tiger, boar, vulture, carcass };
  }

  it('belongs to the predator once it has fed there within the hour', () => {
    const { world, tiger, boar, vulture, carcass } = scene();
    const view = world.__viewForTest();
    expect(heldByPredatorOf(carcass, 'boar', world.now(), view)).toBe(false);
    carcass.consumers.push({ agentId: tiger.id, at: world.now(), kg: 4 });
    expect(heldByPredatorOf(carcass, 'boar', world.now(), view)).toBe(true);
    expect(heldByPredatorOf(carcass, 'vulture', world.now(), view)).toBe(false); // Tigers do not hunt vultures.
    expect(heldByPredatorOf(carcass, 'boar', world.now() + 2 * 3600, view)).toBe(false); // Long gone.
    void boar; void vulture;
  });

  it("is not chosen by the predator's prey, even after the predator has left the patch", () => {
    const { world, tiger, boar, carcass } = scene();
    const base = world.__viewForTest();
    // The carcass index is rebuilt each step; show this one to perception directly.
    const view = { ...base, carcassesInPatch: (id: number) => (id === carcass.patchId ? [carcass] : base.carcassesInPatch(id)) };
    const cfg = world.species.get('boar')!;
    // Before the tiger eats, the boar would go for this carcass (the tiger is not yet indexed there).
    tiger.patchId = world.patches.find((p) => p.surface === 'land' && Math.abs(p.id - boar.patchId) > 40)!.id;
    expect(perceive(boar, cfg, view).carrion?.carcass.id).toBe(carcass.id);
    carcass.consumers.push({ agentId: tiger.id, at: world.now(), kg: 4 });
    expect(perceive(boar, cfg, view).carrion?.carcass.id).not.toBe(carcass.id);
  });
});
