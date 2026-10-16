import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { patchCentre, type Agent } from '@vana/shared';
import { createWorld, type World } from '../src/world.js';
import { perceive, type WorldView } from '../src/agents/perception.js';

const CONGO_SPECIES = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const viewOf = (world: World): WorldView => ({ grid: world.grid, patches: world.patches,
  agentsInPatch: (id) => world.agents.filter((a) => a.alive && a.patchId === id), carcassesInPatch: () => [],
  speciesOf: (id) => world.species.get(id)!, groupPatch: () => null });

/** A buffalo `massKg` heavy with a leopard stalking it 20 m off. */
function stalked(massKg: number, lifeStage: Agent['lifeStage']) {
  const world = createWorld({ seed: 7, speciesDir: CONGO_SPECIES, terrainProfile: 'congo_v1',
    initialAgents: { forest_buffalo: 1, african_leopard: 1 }, minPopulation: {} });
  const patch = world.patches.find((p) => p.habitat === 'terra_firme')!, c = patchCentre(world.grid, patch.id);
  const buffalo = world.agents.find((a) => a.speciesId === 'forest_buffalo')!, leopard = world.agents.find((a) => a.speciesId === 'african_leopard')!;
  Object.assign(buffalo, { patchId: patch.id, position: { x: c.x, z: c.z, heading: 0 }, massKg, lifeStage });
  Object.assign(leopard, { patchId: patch.id, position: { x: c.x + 20, z: c.z, heading: 0 }, currentGoal: 'hunt', state: 'stalking' });
  return perceive(buffalo, world.species.get('forest_buffalo')!, viewOf(world));
}

// A 300 kg buffalo does not bolt from a 45 kg leopard that can take only its calves (maxPreyKg
// 120): it stays watchful. Its calf still runs (docs/2026-10-15-congo-species-behaviour-audit.md).
describe('fear knows what can take it', () => {
  it('leaves a grown buffalo watchful, not fleeing, near a stalking leopard', () => {
    const percept = stalked(300, 'adult');
    expect(percept.threat).not.toBeNull();
    expect(percept.threat!.fear).toBeLessThanOrEqual(0.3);
    expect(percept.dangerous.size).toBe(0);
  }, 120_000);

  it('sends its calf running', () => {
    const percept = stalked(60, 'juvenile');
    expect(percept.threat!.fear).toBeGreaterThan(0.5);
  }, 120_000);
});
