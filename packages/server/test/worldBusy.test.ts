import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createWorld, type World } from '@vana/sim';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { WorldBusyError, worldPort } from '../src/live/worldPort.js';
import { AgentStore, type AgentRecord } from '../src/live/liveStore.js';
import { installLiveAgents } from '../src/live/routes.js';
import { testDatabaseUrl } from './testDatabase.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const island = () => createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { chital: 10, tiger: 1 }, minPopulation: {} });

// Congo plan 1A.3: while the host is stepping (in slices), nothing may change the world.
describe('a world held while it steps', () => {
  it('refuses every mutation through the port, and changes nothing', () => {
    const world = island(); let busy = true;
    const port = worldPort(() => world, () => 'w1', undefined, () => busy);
    const chital = world.agents.find((a) => a.speciesId === 'chital')!, before = JSON.stringify(world.agents);
    for (const act of [
      () => port.possess(chital.id, { kind: 'agent', id: 'a1', name: 'a' } as never),
      () => port.release(chital.id),
      () => port.place(chital.id, { x: 0, z: 0, heading: 0 }),
      () => port.act(chital.id, 'rest', 60),
      () => port.feed(chital.id, 60),
      () => port.resolveHunt('x', chital.id, 0, 0, true),
      () => port.placeWild(chital.id, { x: 0, z: 0, heading: 0 }),
    ]) expect(act).toThrow(WorldBusyError);
    expect(JSON.stringify(world.agents)).toBe(before);
    busy = false;
    expect(() => port.release(chital.id)).not.toThrow();
  });
});

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });
const ORIGIN = 'https://wildsentia.test';

maybe('commands while the world steps', () => {
  let app: FastifyInstance, world: World, human: AgentRecord, busy: boolean, portBusy: boolean;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate live_possessions, live_agents cascade');
    world = island(); busy = false; portBusy = false;
    const port = worldPort(() => world, () => 'w1', undefined, () => busy || portBusy);
    const agents = new AgentStore(pool!);
    human = await agents.ensureHuman({ xUserId: '556', handle: 'ravi', networkHash: 'n' });
    app = Fastify();
    installLiveAgents(app, { live: new LiveLayer(port, null), world: port, store: agents, ledger: null, limits: { slots: 5, perNetworkPerDay: 5 },
      networkSecret: 's', clientScriptPath: fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url)), busy: () => busy,
      humans: { origin: ORIGIN, account: async () => ({ agentId: human.id, xAccountDays: 400 }) } });
    await app.ready();
  });
  const send = (method: 'GET' | 'POST', path: string, body?: object) => app.inject({ method, url: path,
    headers: { cookie: 'ws_session=good', origin: ORIGIN, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });

  it('answers commands with world_busy while the world steps, and takes them after', async () => {
    busy = true;
    const refused = await send('POST', '/play/possess', { speciesId: 'chital' });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: 'world_busy', retryAfterMs: 250 });
    expect(refused.headers['retry-after']).toBe('1');
    expect(world.agents.some((a) => a.controller)).toBe(false);
    expect((await send('GET', '/play/observe')).statusCode).toBe(200);
    busy = false;
    expect((await send('POST', '/play/possess', { speciesId: 'chital' })).statusCode).toBe(200);
  });

  it('answers world_busy, not a server error, when a step begins after the check', async () => {
    portBusy = true; // the route's check passed; the world was taken by a step before the command reached it
    const raced = await send('POST', '/play/possess', { speciesId: 'chital' });
    expect(raced.statusCode).toBe(503);
    expect(raced.json()).toMatchObject({ error: 'world_busy' });
    expect(world.agents.some((a) => a.controller)).toBe(false);
  });
});
