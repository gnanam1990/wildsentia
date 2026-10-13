import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { regionOfPatch, CONGO_GRID } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { Gateway, type GatewaySocket } from '../src/gateway.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

class FakeSocket implements GatewaySocket {
  raw: string[] = [];
  bufferedAmount = 0;
  send(data: string | Buffer): void { this.raw.push(String(data)); }
  close(): void {}
  scenes(): Array<Record<string, unknown>> { return this.raw.map((r) => JSON.parse(r) as Record<string, unknown>).filter((m) => m.type === 'scene'); }
}

// Congo 1A.3: a 64-region world is served a region at a time. (A stand-in Congo host, as tests may build; the server refuses congo_v1.)
let host: SimHost;
beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive cascade');
  host = new SimHost({ pool: pool!, seed: 7, speciesDir, terrainProfile: 'congo_v1',
    initialAgents: { hare: 3_000, leopard: 10 }, minPopulation: {}, landscape: null });
  await host.boot();
  await host.advance(1);
}, 300_000);
afterAll(async () => { await host?.abort(); await pool?.end(); });

maybe('a world served by region', () => {
  it('slices the checkpoint by region', () => {
    const view = host.observation()!;
    expect(view.regionIds()).toHaveLength(64);
    const patches = view.regionPatches('r3_4');
    expect(patches).toHaveLength(400);
    expect(patches.every((p) => regionOfPatch(CONGO_GRID, p.id) === 'r3_4')).toBe(true);
    const animals = view.regionAnimals('r3_4');
    expect(animals.length).toBeGreaterThan(0);
    expect(animals.every((a) => regionOfPatch(CONGO_GRID, a.patchId) === 'r3_4')).toBe(true);
    expect(view.regionIds().reduce((n, id) => n + view.regionAnimals(id).length, 0)).toBe(view.livingAnimals().length);
  });

  it('answers /regions and /regions/:id, and refuses a bad or outside id', async () => {
    const app = buildApi({ host, pool: pool! });
    const list = await app.inject({ url: '/regions' });
    expect(list.json()).toMatchObject({ grid: { cols: 160, rows: 160, patchM: 300, regionPatches: 20 } });
    expect(list.json().regions).toHaveLength(64);
    const one = await app.inject({ url: '/regions/r3_4' });
    expect(one.statusCode).toBe(200);
    expect(one.json().patches).toHaveLength(400);
    expect((await app.inject({ url: '/regions/north' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/regions/r9_9' })).statusCode).toBe(404);
    await app.close();
  });

  it('sends a viewer only the regions around its view, and the new ones when it moves', () => {
    const gateway = new Gateway(host), socket = new FakeSocket();
    gateway.handle(socket);
    const first = socket.scenes()[0]!;
    expect(first.regions).toEqual(['r4_4']); // the centre (23,850 m) is patch 80, the first of region 4
    const env = first.environment as { patches: Array<{ id: number }> };
    expect(env.patches).toHaveLength(400);
    expect(Buffer.byteLength(socket.raw[0]!)).toBeLessThan(3_000_000);
    expect((first.animals as Array<{ patchId: number }>).every((a) => regionOfPatch(CONGO_GRID, a.patchId) === 'r4_4')).toBe(true);
    // Twelve kilometres east, looking 1 km around: region r5_3 (and any it reaches).
    gateway.receive(socket, { type: 'view', x: 35_850, z: 23_850, radius: 1_000 });
    gateway.broadcast();
    const moved = socket.scenes().at(-1)!;
    expect(moved.regions).toContain('r5_3');
    expect(moved.regions).not.toContain('r4_4');
    expect((moved.environment as { patches: unknown[] }).patches.length).toBe((moved.regions as unknown[]).length * 400);
    gateway.disconnect(socket);
  });
});
