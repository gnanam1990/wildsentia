import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { Gateway, type GatewaySocket } from '../src/gateway.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

class FakeSocket implements GatewaySocket {
  sent: Array<Record<string, unknown>> = [];
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void {}
  lastOfType(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

let host: SimHost;
let gateway: Gateway;

beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, follows, viewers cascade');
  host = new SimHost({
    pool: pool!, seed: 11, speciesDir,
    initialAgents: { sambar: 10 }, minPopulation: { sambar: 10 }, landscape: null,
  });
  await host.boot();
  await host.advance(12);
  gateway = new Gateway(host);
});

afterAll(async () => { gateway?.close(); await pool?.end(); });

maybe('Gateway', () => {
  it('sends a world snapshot on connect', () => {
    const socket = new FakeSocket();
    gateway.handle(socket);
    expect(socket.lastOfType('world')).toBeDefined();
    expect(socket.lastOfType('animals')).toBeDefined();
  });

  it('gives two sockets identical world state', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    gateway.handle(a);
    gateway.handle(b);
    expect(a.lastOfType('world')).toEqual(b.lastOfType('world'));
    expect(a.lastOfType('animals')).toEqual(b.lastOfType('animals'));
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
    expect(a.lastOfType('viewers')).toMatchObject({ actorId: id, count: 2 });

    gateway.receive(b, { type: 'unwatch' });
    expect(gateway.viewerCount(id)).toBe(1);
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

  it('broadcasts the same animals payload to every socket', () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    gateway.handle(a);
    gateway.handle(b);
    a.sent = []; b.sent = [];
    gateway.broadcast();
    expect(a.lastOfType('animals')).toEqual(b.lastOfType('animals'));
  });
});
