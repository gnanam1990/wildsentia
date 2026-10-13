import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWorld } from '@vana/sim';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';

// Congo 1B: an agent's hunt follows the same prey rule as every other hunt.
describe('an agent hunting under the prey rule', () => {
  it('may not hunt prey above its weight or a diver under water', () => {
    const world = createWorld({ seed: 7, speciesDir: fileURLToPath(new URL('../../../config/species-congo', import.meta.url)),
      terrainProfile: 'congo_v1', initialAgents: { african_leopard: 2, blue_duiker: 30, water_chevrotain: 5 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w1');
    const live = new LiveLayer(port, null);
    const leopard = world.agents.find((a) => a.speciesId === 'african_leopard' && a.lifeStage === 'adult')!;
    expect(live.possess('a1', 'Ana', { animalId: leopard.id }).ok).toBe(true);
    const avatar = live.avatars.get('a1')!;
    const near = (id: string) => { const a = world.animal(id)!; a.position = { x: avatar.x + 5, z: avatar.z, heading: 0 }; a.patchId = leopard.patchId; };
    const duiker = world.agents.find((a) => a.speciesId === 'blue_duiker')!, chevrotain = world.agents.find((a) => a.speciesId === 'water_chevrotain')!;
    near(duiker.id); near(chevrotain.id);
    duiker.massKg = 500;
    expect(live.hunt('a1', duiker.id)).toBe('incompatible_prey');
    chevrotain.locomotionMode = 'submerged'; chevrotain.submergedUntil = world.now() + 240;
    expect(live.hunt('a1', chevrotain.id)).toBe('incompatible_prey');
    duiker.massKg = 4.6;
    expect(live.hunt('a1', duiker.id)).toBeNull();
  }, 60_000);
});
