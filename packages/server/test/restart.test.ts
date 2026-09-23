import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EventStore } from '../src/db/eventStore.js';
import { SimHost } from '../src/simHost.js';
import { Gateway, type GatewaySocket } from '../src/gateway.js';

const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

const opts = () => ({
  pool: pool!, seed: 42, speciesDir, snapshotEveryWorldHours: 12,
  initialAgents: { sambar: 30 }, minPopulation: { sambar: 30 }, landscape: null,
});

class FakeSocket implements GatewaySocket {
  sent: Array<Record<string, unknown>> = [];
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void {}
  lastOfType(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

afterAll(async () => { await pool?.end(); });

maybe('M2 gate', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, follows, viewers cascade');
  });

  it('two clients see identical state and history survives a restart', async () => {
    const first = new SimHost(opts());
    await first.boot();
    await first.advance(72);
    const eventsBefore = await new EventStore(pool!).total();
    const timeBefore = first.world.now();
    await first.stop();

    expect(eventsBefore).toBeGreaterThan(0);

    const second = new SimHost(opts());
    const boot = await second.boot();
    expect(boot.restoredFrom).toBe(timeBefore);

    const eventsAfter = await new EventStore(pool!).total();
    expect(eventsAfter).toBeGreaterThanOrEqual(eventsBefore - boot.rolledBackEvents);

    const gateway = new Gateway(second);
    const a = new FakeSocket();
    const b = new FakeSocket();
    gateway.handle(a);
    gateway.handle(b);
    expect(a.lastOfType('world')).toEqual(b.lastOfType('world'));
    expect(a.lastOfType('animals')).toEqual(b.lastOfType('animals'));

    expect(second.world.agents.map((x) => x.id)).toEqual(first.world.agents.map((x) => x.id));
    gateway.close();
  });
});
