import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { createWorld } from '@vana/sim';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { installLiveAgents } from '../src/live/routes.js';

// Congo 1B: an agent in the Congo forest is told about the Congo, not the island.
describe('the agent guide in the Congo forest', () => {
  it('names the Congo species and the Congo season, never the island roster', async () => {
    const world = createWorld({ seed: 7, speciesDir: fileURLToPath(new URL('../../../config/species-congo', import.meta.url)),
      terrainProfile: 'congo_v1', initialAgents: { blue_duiker: 4 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w1');
    const app = Fastify();
    installLiveAgents(app, { live: new LiveLayer(port, null), world: port, store: { count: async () => 0 } as never, ledger: null,
      limits: { slots: 5, perNetworkPerDay: 5 }, networkSecret: 's', clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)) });
    const text = (await app.inject({ url: '/agents/guide.txt' })).body;
    expect(text).toMatch(/blue duiker/); expect(text).toMatch(/water chevrotain/); expect(text).toMatch(/African leopard/);
    expect(text).not.toMatch(/chital|sambar|tiger|dhole|langur/);
    const info = (await app.inject({ url: '/agents/info' })).json();
    expect(info.world.season).toBe('monsoon'); expect(info.world.formatted).toContain('-monsoon-');
    await app.close();
  });
});
