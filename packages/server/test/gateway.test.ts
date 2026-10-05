import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { Gateway, LIVE_BUSY_CLOSE_CODE, MAX_BUFFERED_BYTES, type GatewaySocket } from '../src/gateway.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

class FakeSocket implements GatewaySocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  closeCode: number | undefined;
  /** Bytes the viewer has not read yet; a test raises it to play a viewer that stopped reading. */
  bufferedAmount = 0;
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(code?: number): void { this.closed = true; this.closeCode = code; }
  lastOfType(type: string): Record<string, unknown> | undefined {
    for (const m of [...this.sent].reverse()) {
      if (m.type === type) return m;
      if (m.type !== 'scene') continue;
      if (type === 'world') return m.world as Record<string, unknown>;
      if (type === 'animals') return { animals: m.animals };
      if (type === 'encounters' && 'frame' in m) return { type: 'encounters', frame: m.frame };
    }
    return undefined;
  }
}

let host: SimHost;
let gateway: Gateway;

beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers cascade');
  host = new SimHost({
    pool: pool!, seed: 11, speciesDir,
    initialAgents: { sambar: 10 }, minPopulation: { sambar: 10 }, landscape: null,
  });
  await host.boot();
  await host.advance(12);
  gateway = new Gateway(host);
});

afterAll(async () => { gateway?.close(); await host?.abort(); await pool?.end(); });

maybe('Gateway', () => {
  it('sends a world snapshot on connect', () => {
    const socket = new FakeSocket();
    gateway.handle(socket);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ type: 'scene', protocol: 1, checkpointId: expect.any(String),
      environment: { patches: expect.any(Array), carcasses: expect.any(Array) } });
    expect(socket.lastOfType('world')).toBeDefined();
    expect(socket.lastOfType('animals')).toBeDefined();
    expect(socket.lastOfType('encounters')).toMatchObject({ frame: { startWorldTime: 39600, endWorldTime: 43200 } });
  });

  it('gives two sockets identical world state', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    gateway.handle(a);
    gateway.handle(b);
    expect(a.lastOfType('world')).toEqual(b.lastOfType('world'));
    expect(a.lastOfType('animals')).toEqual(b.lastOfType('animals'));
    expect((a.lastOfType('encounters')!.frame as { id: string }).id)
      .toEqual((b.lastOfType('encounters')!.frame as { id: string }).id);
  });

  it('streams body size, coat and family fields from the actual agent', () => {
    const socket = new FakeSocket();
    gateway.handle(socket);
    const payload = socket.lastOfType('animals') as { animals: Array<Record<string, unknown>> };
    const agent = host.world.agents[0]!;
    expect(payload.animals.find((a) => a.id === agent.id)).toMatchObject({
      lifeStage: agent.lifeStage, sex: agent.sex, coatVariant: agent.traits.coatVariant,
      sizeRatio: agent.massKg / host.world.species.get(agent.speciesId)!.body.adultMassKg,
      dependentOn: agent.dependentOn, groupId: agent.groupId ?? null,
      position: agent.position,
    });
  });

  it('counts viewers per animal and reports the count to watchers', () => {
    const id = host.world.agents[0]!.id;
    const a = new FakeSocket();
    const b = new FakeSocket();
    gateway.handle(a);
    gateway.handle(b);

    gateway.receive(a, { type: 'watch', actorId: id });
    expect(gateway.viewerCount(id)).toBe(1);

    gateway.receive(b, { type: 'watch', actorId: id });
    expect(gateway.viewerCount(id)).toBe(2);
    expect(b.lastOfType('viewers')).toMatchObject({ actorId: id, count: 2 });
    gateway.broadcast(); // Other watchers hear the new count with the next broadcast.
    expect(a.lastOfType('viewers')).toMatchObject({ actorId: id, count: 2 });

    gateway.receive(b, { type: 'unwatch' });
    expect(gateway.viewerCount(id)).toBe(1);
  });

  it('does not let one viewer switching follows make the server write to every other watcher', () => {
    // Security review 5 October 2026: each watch or unwatch sent the new count to all of an animal's watchers at once.
    const isolated = new Gateway(host), [popular, other] = host.world.agents;
    const watchers = Array.from({ length: 50 }, () => new FakeSocket());
    for (const w of watchers) { isolated.handle(w); isolated.receive(w, { type: 'watch', actorId: popular!.id }); w.sent = []; }
    const flipper = new FakeSocket(); isolated.handle(flipper);
    for (let i = 0; i < 100; i++) isolated.receive(flipper, { type: 'watch', actorId: (i % 2 ? other : popular)!.id });
    expect(watchers.reduce((n, w) => n + w.sent.length, 0)).toBe(0);
    isolated.broadcast();
    expect(watchers.every((w) => w.sent.filter((m) => m.type === 'viewers').length === 1)).toBe(true);
    isolated.close();
  });

  it('drops a viewer count when the socket disconnects', () => {
    const id = host.world.agents[1]!.id;
    const socket = new FakeSocket();
    gateway.handle(socket);
    gateway.receive(socket, { type: 'watch', actorId: id });
    expect(gateway.viewerCount(id)).toBe(1);
    gateway.disconnect(socket);
    expect(gateway.viewerCount(id)).toBe(0);
  });

  it('rejects any message that is not watch or unwatch', () => {
    const socket = new FakeSocket();
    gateway.handle(socket);
    gateway.receive(socket, { type: 'setHunger', actorId: 'x', value: 0 } as never);
    expect(socket.lastOfType('error')).toMatchObject({ message: expect.stringContaining('unsupported') });
  });

  it('coalesces follow switches, prioritizes only that viewer and does not mutate the world', () => {
    const gateway = new Gateway(host); // Isolate sessions from earlier viewer-count tests.
    const a = new FakeSocket(), b = new FakeSocket(); gateway.handle(a); gateway.handle(b);
    a.sent = []; b.sent = [];
    const before = JSON.stringify(host.world.agents);
    const spy = vi.spyOn(host, 'liveEncounterFrame');
    try {
      const [first, last] = host.world.agents;
      gateway.receive(a, { type: 'watch', actorId: first!.id });
      gateway.receive(a, { type: 'watch', actorId: last!.id });
      expect(a.lastOfType('encounters')).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
      gateway.broadcast();
      expect(spy).toHaveBeenCalledWith(last!.id);
      expect(spy).not.toHaveBeenCalledWith(first!.id);
      expect(a.lastOfType('encounters')).toBeDefined();
      expect(b.lastOfType('encounters')).toBeUndefined();
      expect(JSON.stringify(host.world.agents)).toBe(before);
      a.sent = [];
      gateway.receive(a, { type: 'watch', actorId: last!.id }); gateway.broadcast();
      expect(a.lastOfType('encounters')).toBeUndefined();
      gateway.receive(a, { type: 'unwatch' }); gateway.broadcast();
      expect(a.lastOfType('encounters')).toBeDefined();
      a.sent = []; gateway.broadcast(); expect(a.lastOfType('encounters')).toBeUndefined();
    } finally { spy.mockRestore(); gateway.disconnect(a); gateway.disconnect(b); }
  });

  it('sends immutable route geometry once per checkpoint, including to late joiners', async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    gateway.handle(a);
    gateway.handle(b);
    a.sent = []; b.sent = [];
    gateway.broadcast();
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
    expect(a.lastOfType('encounters')).toBeUndefined();
    expect(b.lastOfType('encounters')).toBeUndefined();
    await host.advance(1); gateway.broadcast();
    expect(a.sent.at(-1)).toHaveProperty('environment');
    const message = a.lastOfType('encounters');
    expect(message).toBeDefined(); expect(message).toEqual(b.lastOfType('encounters'));
    expect((message!.frame as { movements: unknown[] }).movements).toBeInstanceOf(Array);
    a.sent = []; b.sent = []; gateway.broadcast();
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
    expect(a.lastOfType('encounters')).toBeUndefined();
    const late = new FakeSocket(); gateway.handle(late);
    expect((late.lastOfType('encounters')!.frame as { id: string }).id).toBe((message!.frame as { id: string }).id);
    const expired = vi.spyOn(host, 'liveEncounterFrame').mockReturnValue(null);
    try {
      gateway.broadcast();
      expect(a.lastOfType('encounters')).toEqual({ type: 'encounters', frame: null });
      a.sent = []; gateway.broadcast(); expect(a.lastOfType('encounters')).toBeUndefined();
    } finally { expired.mockRestore(); }
  });

  it('sends only a tiny keepalive between unchanged checkpoints', () => {
    const isolated = new Gateway(host), socket = new FakeSocket();
    isolated.handle(socket);
    socket.sent = [];
    isolated.broadcast();
    expect(socket.sent).toEqual([]);
    const later = Date.now() + 31_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      isolated.broadcast();
      expect(socket.sent).toEqual([{ type: 'heartbeat', checkpointId: expect.any(String) }]);
      socket.sent = [];
      isolated.broadcast();
      expect(socket.sent).toEqual([]);
    } finally { clock.mockRestore(); isolated.disconnect(socket); isolated.close(); }
  });

  it('closes existing and new viewers when the saved world stops advancing', () => {
    const isolated = new Gateway(host), existing = new FakeSocket();
    isolated.handle(existing);
    const later = Date.now() + 16 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      isolated.broadcast();
      expect(existing.closed).toBe(true);
      const newcomer = new FakeSocket();
      isolated.handle(newcomer);
      expect(newcomer.closed).toBe(true);
      expect(newcomer.sent).toEqual([]);
      // "Try again later": the observer backs off instead of reconnecting every two seconds.
      expect(existing.closeCode).toBe(LIVE_BUSY_CLOSE_CODE);
      expect(newcomer.closeCode).toBe(LIVE_BUSY_CLOSE_CODE);
    } finally { clock.mockRestore(); isolated.close(); }
  });

  it('streams symptoms only from an active, saved illness episode', async () => {
    const agent = host.world.agents[0]!;
    const socket = new FakeSocket(); gateway.handle(socket);
    const find = () => (socket.lastOfType('animals') as { animals: Array<Record<string, unknown>> })
      .animals.find(a => a.id === agent.id)!;
    expect(find()).not.toHaveProperty('illnessStatus');
    const now = host.world.now();
    agent.illness = { kind: 'carrion_infection', phase: 'incubating',
      sourceCarcassId: 'carcass_fixture', sourceMealEventId: 'meal_fixture',
      contractedEventId: 'contracted_fixture', acquiredAt: now - 2,
      incubationUntil: now + 1, lastUpdatedAt: now,
      severity: 0.4, recoveryRemainingHours: 80, mortalityBudget: 2 };
    try {
      await host.snapshotNow(); gateway.broadcast();
      expect(find()).not.toHaveProperty('illnessStatus');
      agent.illness.phase = 'active'; agent.illness.onsetEventId = 'onset_fixture';
      agent.illness.incubationUntil = now - 1;
      await host.snapshotNow(); gateway.broadcast();
      expect(find().illnessStatus).toBe('symptomatic');
    } finally {
      delete agent.illness;
      await host.snapshotNow(); gateway.disconnect(socket);
    }
  });
  it('streams only the saved modelled wound phase, then removes it after healing', async () => {
    const agent = host.world.agents[0]!;
    const socket = new FakeSocket(); gateway.handle(socket);
    const find = () => (socket.lastOfType('animals') as { animals: Array<Record<string, unknown>> })
      .animals.find(a => a.id === agent.id)!;
    expect(find()).not.toHaveProperty('woundStatus');
    const now = host.world.now();
    agent.wound = { kind: 'contact_injury', phase: 'open', sourceHuntEventId: 'hunt_fixture',
      woundEventId: 'wounded_fixture', acquiredAt: now - 1, lastUpdatedAt: now,
      severity: 0.4, recoveryRemainingHours: 80, infectionBudget: 1, mortalityBudget: 1 };
    try {
      await host.snapshotNow(); gateway.broadcast();
      expect(find().woundStatus).toBe('open');
      agent.wound.phase = 'infected'; agent.wound.infectionEventId = 'infection_fixture';
      agent.wound.infectionBudget = 0;
      await host.snapshotNow(); gateway.broadcast();
      expect(find().woundStatus).toBe('infected');
      delete agent.wound;
      await host.snapshotNow(); gateway.broadcast();
      expect(find()).not.toHaveProperty('woundStatus');
    } finally {
      delete agent.wound;
      await host.snapshotNow(); gateway.disconnect(socket);
    }
  });
});

maybe('live agents over the gateway', () => {
  const state = (xs: number[]) => ({ drops: [{ id: 'd1' }], avatars: xs.map((x, i) => ({ agentId: `ag_${i}`, name: `A${i}`,
    animalId: `chital_${i}`, speciesId: 'chital', x, z: 0, moving: i % 2 === 0, gait: 'walk', action: 'graze' })) });

  it('sends each viewer only the agents near its camera, plus the one it follows', () => {
    const near = new FakeSocket(), far = new FakeSocket(), blind = new FakeSocket();
    for (const s of [near, far, blind]) gateway.handle(s);
    gateway.receive(near, { type: 'view', x: 0, z: 0, radius: 300 });
    gateway.receive(far, { type: 'view', x: 5000, z: 0, radius: 9999 }); // Clamped to 1,500 m.
    gateway.receive(far, { type: 'watch', actorId: 'chital_0' });
    gateway.broadcastLive(state([10, 250, 1000, 4000]) as never, 1);
    const ids = (s: FakeSocket) => ((s.lastOfType('live')?.avatars ?? []) as Array<{ agentId: string }>).map((a) => a.agentId);
    expect(ids(near)).toEqual(['ag_0', 'ag_1']);
    expect(ids(far)).toEqual(['ag_0', 'ag_3']); // Followed, and within 1,500 m of x=5000.
    expect(ids(blind)).toEqual([]); // No view yet: drops only.
    expect(blind.lastOfType('live')?.drops).toEqual([{ id: 'd1' }]);
    gateway.receive(near, { type: 'view', x: Number.NaN, z: 0, radius: 300 }); // Ignored, not an error.
    expect(near.lastOfType('error')).toBeUndefined();
  });

  it('sends nothing to a viewer with nothing live, once it has said so', () => {
    const idle = new FakeSocket();
    gateway.handle(idle);
    gateway.broadcastLive({ avatars: [], drops: [] }, 1);
    expect(idle.lastOfType('live')).toBeUndefined();
  });

  it('cuts off a viewer that stops reading instead of queueing for it without limit', () => {
    // Security review 5 October 2026: nothing bounded what the server held for a viewer that never read.
    const isolated = new Gateway(host), slow = new FakeSocket(), reader = new FakeSocket();
    isolated.handle(slow); isolated.handle(reader);
    isolated.receive(slow, { type: 'watch', actorId: 'chital_0' });
    const before = slow.sent.length;
    slow.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    isolated.broadcastLive(state([10]) as never, 1);
    isolated.broadcastRoster(state([10]) as never);
    isolated.receive(slow, { type: 'watch', actorId: 'chital_1' });
    expect(slow.closed).toBe(true);
    expect(slow.sent).toHaveLength(before);
    expect(isolated.viewerCount('chital_0') + isolated.viewerCount('chital_1')).toBe(0);
    expect(reader.lastOfType('live-roster')).toBeDefined();
    isolated.close();
  });

  it('cuts off a real connection whose reader has stopped, once its queue passes the limit', async () => {
    const server = createServer(), isolated = new Gateway(host);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    isolated.attach(server);
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/live`);
    try {
      await new Promise<void>((resolve) => client.once('message', () => resolve()));
      let live = 0;
      client.on('message', () => { live++; });
      const closed = new Promise<boolean>((resolve) => { client.once('close', () => resolve(true)); setTimeout(() => resolve(false), 10_000); });
      const socket = (client as unknown as { _socket: { pause(): void; resume(): void } })._socket;
      socket.pause(); // The viewer stops reading.
      const noise = randomBytes(768 * 1024).toString('base64'); // About 1 MB that does not compress away.
      for (let i = 0; i < 60; i++) {
        isolated.broadcastLive({ avatars: [], drops: [{ id: `d${i}`, noise }] }, i);
        await new Promise((r) => setTimeout(r, 5));
      }
      socket.resume(); // Reading again: a viewer that was kept gets all sixty, one that was cut off does not.
      expect(await closed).toBe(true);
      expect(live).toBeLessThan(60);
    } finally { client.terminate(); isolated.close(); await new Promise((r) => server.close(r)); }
  });

  it('refuses /live connections past the per-network and total caps with "try again later"', async () => {
    // Workstream D: nothing capped connections, and each new one is sent the whole ~1 MB scene.
    const server = createServer(), capped = new Gateway(host, { maxConnections: 3, maxPerNetwork: 2, trustedProxyHops: 1 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    capped.attach(server);
    const port = (server.address() as AddressInfo).port, sockets: WebSocket[] = [];
    // Each client says which visitor it is the way Caddy would, by appending to X-Forwarded-For.
    const connect = (forwardedFor: string) => new Promise<'scene' | { code: number; reason: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { 'x-forwarded-for': forwardedFor } });
      sockets.push(ws);
      ws.once('message', (data) => resolve(JSON.parse(String(data)).type === 'scene' ? 'scene' : { code: -1, reason: String(data) }));
      ws.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
    });
    try {
      expect(await connect('198.51.100.1')).toBe('scene');
      expect(await connect('198.51.100.1')).toBe('scene');
      expect(await connect('198.51.100.1')).toEqual({ code: LIVE_BUSY_CLOSE_CODE, reason: 'busy_network' });
      // A forged leftmost entry does not make a visitor someone else.
      expect(await connect('203.0.113.50, 198.51.100.1')).toEqual({ code: LIVE_BUSY_CLOSE_CODE, reason: 'busy_network' });
      expect(await connect('198.51.100.2')).toBe('scene');
      expect(await connect('198.51.100.3')).toEqual({ code: LIVE_BUSY_CLOSE_CODE, reason: 'busy' });
      expect(capped.connectionCount).toBe(3);
      // A place freed is a place offered again.
      sockets[0]!.close();
      await vi.waitFor(() => expect(capped.connectionCount).toBe(2));
      expect(await connect('198.51.100.3')).toBe('scene');
    } finally {
      for (const ws of sockets) ws.terminate();
      capped.close(); await new Promise((r) => server.close(r));
    }
  });

  it('tells every viewer who is playing, in brief', () => {
    const viewer = new FakeSocket();
    gateway.handle(viewer);
    gateway.broadcastRoster(state([10, 4000]) as never);
    expect(viewer.lastOfType('live-roster')).toEqual({ type: 'live-roster', agents: [
      { agentId: 'ag_0', name: 'A0', animalId: 'chital_0', speciesId: 'chital', x: 10, z: 0, activity: 'walk' },
      { agentId: 'ag_1', name: 'A1', animalId: 'chital_1', speciesId: 'chital', x: 4000, z: 0, activity: 'graze' }] });
  });
});
