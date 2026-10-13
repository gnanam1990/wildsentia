import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { landWalkable, patchCentre } from '@vana/shared';
import { createWorld, type World } from '@vana/sim';
import { LiveLayer, type CommandRecord, type HuntOutcome } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { ISLAND_GRID } from '@vana/shared';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

function setup(random: () => number) {
  const world: World = createWorld({ seed: 6, speciesDir, terrainProfile: 'island_v1',
    initialAgents: { tiger: 2, chital: 12 }, minPopulation: {} });
  const open = world.patches.find((p) => landWalkable(p) && p.neighbours.every((n) => landWalkable(world.patches[n])))!;
  const centre = patchCentre(ISLAND_GRID, open.id);
  let now = 5_000_000;
  const live = new LiveLayer(worldPort(() => world, () => 'w'), null, () => now, random);
  const hunts: HuntOutcome[] = [], commands: CommandRecord[] = [];
  live.onHunt = (h) => hunts.push(h);
  live.onCommand = (c) => commands.push(c);
  const put = (id: string, dx: number) => {
    const a = world.animal(id)!;
    a.patchId = open.id; a.position = { x: centre.x + dx, z: centre.z, heading: 0 };
  };
  const run = (seconds: number) => { for (let i = 0; i < seconds * 10; i++) { now += 100; live.tick(0.1); } };
  const adult = (species: string) => world.agents.find((a) => a.alive && a.speciesId === species && a.lifeStage === 'adult'
    && a.dependentOn === null && !world.agents.some((c) => c.alive && c.dependentOn === a.id))!;
  return { world, live, put, run, adult, hunts, commands, centre };
}

describe('live layer hooks for challenges', () => {
  it('reports a kill with the agent that steered the predator', () => {
    const { live, put, run, adult, hunts } = setup(() => 0); // Every catch kills.
    const tiger = adult('tiger'), chital = adult('chital');
    put(tiger.id, 0); put(chital.id, 30);
    live.possess('ag_t', 'Stripe', { animalId: tiger.id });
    live.hunt('ag_t', chital.id);
    run(60);
    expect(hunts).toHaveLength(1);
    expect(hunts[0]).toMatchObject({ predatorId: tiger.id, preyId: chital.id, predatorAgentId: 'ag_t', preyAgentId: null, killed: true });
  });

  it('reports an escape with the agent that steered the prey', () => {
    const { live, put, run, adult, hunts } = setup(() => 0.999); // Every catch fails.
    const tiger = adult('tiger'), chital = adult('chital');
    put(tiger.id, 0); put(chital.id, 30);
    live.possess('ag_t', 'Stripe', { animalId: tiger.id });
    live.possess('ag_c', 'Doe', { animalId: chital.id });
    live.hunt('ag_t', chital.id);
    run(60);
    expect(hunts.length).toBeGreaterThanOrEqual(1);
    expect(hunts[0]).toMatchObject({ predatorAgentId: 'ag_t', preyAgentId: 'ag_c', killed: false });
  });

  it('records each accepted command, and not a refused one', () => {
    const { live, adult, commands, put, centre } = setup(() => 0);
    const chital = adult('chital');
    put(chital.id, 0);
    live.possess('ag_c', 'Doe', { animalId: chital.id });
    expect(live.act('ag_c', 'graze')).toBeNull();
    expect(live.act('ag_c', 'feed')).toBe('does_not_eat_meat');
    expect(live.moveTo('ag_c', [{ x: centre.x + 5, z: centre.z }], 'trot')).toBeNull();
    expect(live.stop('ag_c')).toBeNull();
    expect(live.release('ag_c')).toBe(true);
    expect(commands.map((c) => c.command)).toEqual(['act', 'move', 'stop', 'release']);
    expect(commands[0]).toMatchObject({ agentId: 'ag_c', args: { action: 'graze' } });
    expect(commands[1]!.args).toEqual({ points: [{ x: centre.x + 5, z: centre.z }], gait: 'trot' });
  });
});
