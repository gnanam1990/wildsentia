import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { SceneUpdates, type SceneUpdate } from '../../client/src/sceneUpdates.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SnapshotStore } from '../src/db/snapshotStore.js';
import { SimHost } from './trackedHost.js';
import { buildApi } from '../src/api.js';
import { Gateway, type GatewaySocket } from '../src/gateway.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl(), pool = url ? createPool(url) : null;
const maybe = url ? describe : describe.skip;
const options = () => ({ pool: pool!, seed: 44, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: { sambar: 2 }, minPopulation: {}, landscape: null, snapshotEveryWorldHours: 12 });
class Socket implements GatewaySocket {
  messages: Array<Record<string, any>> = [];
  closed = false;
  send(data: string) { this.messages.push(JSON.parse(data)); }
  close() { this.closed = true; }
  last(type: string): Record<string, any> | undefined {
    for (const m of [...this.messages].reverse()) {
      if (m.type === type) return m;
      if (m.type !== 'scene') continue;
      if (type === 'world') return m.world;
      if (type === 'animals') return { worldTime: m.world.worldTime, animals: m.animals };
      if (type === 'encounters' && 'frame' in m) return { type: 'encounters', frame: m.frame };
    }
    return undefined;
  }
}
afterAll(async () => { await pool?.end(); });
maybe('durable live observer publication', () => {
  beforeEach(async () => {
    await migrate(pool!); await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, narrations cascade');
  });

  it('keeps HTTP, existing sockets and late joins on the saved world through birth/death and abort/restart', async () => {
    const host = new SimHost(options()); await host.boot();
    const [mother, dying] = host.world.agents;
    mother!.sex = 'female'; mother!.pregnantSince = -host.world.species.get('sambar')!.lifecycle.gestationDays * 86400;
    mother!.drives = { hunger: 0, thirst: 0, fatigue: 1, fear: 0 }; dying!.drives.hunger = 1;
    await host.snapshotNow();
    const api = buildApi({ host, pool: pool! }), gateway = new Gateway(host), socket = new Socket();
    const paths = ['/world', '/animals', `/animals/${dying!.id}`, '/patches', '/carcasses'];
    const read = async (app: typeof api) => Promise.all(paths.map(async (path) => (await app.inject(path)).json()));
    try {
      const initial = await read(api); gateway.handle(socket);
      const initialWorld = socket.last('world'), initialAnimals = socket.last('animals');
      await host.advance(1);
      const newborn = host.world.agents.find((a) => a.motherId === mother!.id)!;
      expect(newborn).toBeDefined(); expect(dying!.alive).toBe(false);
      expect(host.world.carcasses.length).toBeGreaterThan(0);
      expect(host.world.patches).not.toEqual(host.observation()!.patches());
      expect(await read(api)).toEqual(initial);
      expect((await api.inject(`/animals/${newborn.id}`)).statusCode).toBe(404);
      gateway.broadcast(); expect(socket.last('world')).toEqual(initialWorld); expect(socket.last('animals')).toEqual(initialAnimals);
      const late = new Socket(); gateway.handle(late);
      expect(late.last('world')).toEqual(initialWorld); expect(late.last('animals')).toEqual(initialAnimals);
      expect(late.last('encounters')).toEqual({ type: 'encounters', frame: null });
      await host.abort(); gateway.broadcast(); expect(socket.closed).toBe(true); expect(late.closed).toBe(true);
      const restored = new SimHost(options()); await restored.boot();
      const restoredApi = buildApi({ host: restored, pool: pool! });
      try {
        expect(await read(restoredApi)).toEqual(initial);
        const joined = new Socket(); new Gateway(restored).handle(joined);
        expect(joined.last('world')).toEqual(initialWorld); expect(joined.last('animals')).toEqual(initialAnimals);
        await restored.advance(1); await restored.snapshotNow();
        const saved = await read(restoredApi);
        expect(saved[0]).toMatchObject({ worldTime: 3600, source: 'checkpoint', totalNutrients: restored.world.totalNutrients() });
        expect(saved[1].animals.some((a: { id: string }) => a.id === newborn.id)).toBe(true);
        expect(saved[1].animals.some((a: { id: string }) => a.id === dying!.id)).toBe(false);
        expect(saved[2].alive).toBe(false); expect(saved[4].carcasses.length).toBeGreaterThan(0);
        const committed = new Socket(); new Gateway(restored).handle(committed);
        expect(committed.last('world')!.worldTime).toBe(3600);
        expect(committed.last('animals')!.animals.map((a: { id: string }) => a.id)).toEqual(saved[1].animals.map((a: { id: string }) => a.id));
        expect(committed.last('encounters')!.frame.endWorldTime).toBe(3600);
      } finally { await restoredApi.close(); }
    } finally { await api.close(); }
  });

  it('does not publish an in-flight or failed checkpoint and releases the complete view after successful retry', async () => {
    const host = new SimHost(options()); await host.boot(); await host.advance(1);
    const api = buildApi({ host, pool: pool! }), gateway = new Gateway(host), socket = new Socket(); gateway.handle(socket);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(SnapshotStore.prototype, 'save').mockImplementationOnce(async () => {
      enter(); await gate; throw new Error('injected save failure');
    });
    const saving = host.snapshotNow(); const failure = expect(saving).rejects.toThrow('injected save failure');
    try {
      await entered;
      expect((await api.inject('/world')).json().worldTime).toBe(0);
      gateway.broadcast(); expect(socket.last('world')!.worldTime).toBe(0);
      expect(socket.last('encounters')!.frame).toBeNull();
      release(); await failure;
      expect((await api.inject('/world')).json().worldTime).toBe(0);
      expect(host.observation()!.worldTime).toBe(0);
      spy.mockRestore(); await host.snapshotNow(); gateway.broadcast();
      expect((await api.inject('/world')).json().worldTime).toBe(3600);
      expect(socket.last('world')!.worldTime).toBe(3600); expect(socket.last('animals')!.worldTime).toBe(3600);
      expect(socket.last('encounters')!.frame.endWorldTime).toBe(3600);
    } finally { release(); await failure; spy.mockRestore(); await api.close(); }
  });

  it('detaches population, animals, terrain and carcasses without leaking private snapshot internals', async () => {
    const host = new SimHost(options()); await host.boot();
    const view = host.observation()!, original = view.patches(), population = view.summary().population;
    view.patches()[0]!.soilNutrients = -1; view.summary().population.sambar = 900;
    view.livingAnimals()[0]!.drives.hunger = 99;
    expect(view.patches()).toEqual(original); expect(view.summary().population).toEqual(population);
    expect(view.livingAnimals()[0]!.drives.hunger).not.toBe(99);
    host.world.agents[0]!.drives.hunger = 1;
    await host.advance(1); await host.snapshotNow();
    expect(view.worldTime).toBe(0); expect(view.patches()).toEqual(original);
    expect(host.observation()!.worldTime).toBe(3600);
    const corpse = host.observation()!.carcasses()[0]!;
    expect(corpse).toBeDefined(); corpse.biomass.muscle = -99;
    expect(host.observation()!.carcasses()[0]!.biomass.muscle).not.toBe(-99);
    const api = buildApi({ host, pool: pool! });
    try {
      const world = (await api.inject('/world')).json();
      expect(world).not.toHaveProperty('rngState'); expect(world).not.toHaveProperty('seed');
    } finally { await api.close(); }
  });

  it('fails every live read and socket closed when the writer is unhealthy', async () => {
    const host = new SimHost(options()); await host.boot(); const api = buildApi({ host, pool: pool! });
    const gateway = new Gateway(host), socket = new Socket(); gateway.handle(socket); socket.messages = [];
    host.lastError = 'private diagnostics';
    try {
      for (const path of ['/world', '/animals', `/animals/${host.world.agents[0]!.id}`, '/patches', '/carcasses']) {
        const response = await api.inject(path); expect(response.statusCode).toBe(503);
        expect(response.headers['cache-control']).toBe('no-store'); expect(response.body).not.toContain('private');
      }
      gateway.broadcast(); expect(socket.closed).toBe(true); expect(socket.messages).toEqual([]);
      const late = new Socket(); gateway.handle(late); expect(late.closed).toBe(true); expect(late.messages).toEqual([]);
    } finally { host.lastError = null; await api.close(); }
  });

  it('serves the same committed clock and animals over real loopback HTTP and WebSocket transports', async () => {
    const host = new SimHost(options()); await host.boot();
    const api = buildApi({ host, pool: pool! }), gateway = new Gateway(host);
    gateway.attach(api.server);
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const socket = new WebSocket(`${address.replace('http:', 'ws:')}/live`);
    const messages: Array<Record<string, any>> = [];
    const rendered: SceneUpdate[] = [], accepted: boolean[] = [];
    const client = new SceneUpdates({ prepare: async () => true,
      commit: (update: SceneUpdate) => { rendered.push(update); }, discard: () => {}, status: () => {} });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()); messages.push(message);
      accepted.push(client.receive(message, performance.now()));
    });
    try {
      await once(socket, 'open');
      await vi.waitFor(() => expect(messages.length).toBe(1));
      expect(messages[0]).toMatchObject({ type: 'scene', protocol: 1, world: { worldTime: 0, source: 'checkpoint' },
        environment: { patches: expect.any(Array), carcasses: [] } });
      await vi.waitFor(() => expect(rendered).toHaveLength(1));
      await host.advance(1); messages.length = 0; gateway.broadcast();
      expect(messages).toEqual([]);
      expect(rendered).toHaveLength(1);
      expect((await (await fetch(`${address}/world`)).json() as { worldTime: number }).worldTime).toBe(0);
      await host.snapshotNow(); messages.length = 0; gateway.broadcast();
      await vi.waitFor(() => expect(messages.length).toBe(1));
      expect(messages[0]!.world.worldTime).toBe(3600);
      expect(messages[0]!.frame.endWorldTime).toBe(3600);
      expect(messages[0]).toHaveProperty('environment');
      await vi.waitFor(() => expect(rendered).toHaveLength(2));
      expect(rendered[1]!.world.worldTime).toBe(3600);
      expect(rendered[1]!.frame?.endWorldTime).toBe(3600);
      expect(rendered[1]!.environment.patches).toHaveLength(host.world.patches.length);
      expect(accepted).toEqual([true, true]);
      const httpAnimals = await (await fetch(`${address}/animals`)).json() as { animals: Array<{ id: string }> };
      expect(messages[0]!.animals.map((a: { id: string }) => a.id)).toEqual(httpAnimals.animals.map((a) => a.id));
      host.lastError = 'injected'; const closed = once(socket, 'close'); gateway.broadcast(); await closed;
      expect((await fetch(`${address}/world`)).status).toBe(503);
    } finally {
      host.lastError = null;
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, 'close'); socket.terminate(); await closed;
      }
      gateway.close(); await api.close();
    }
  });
});
