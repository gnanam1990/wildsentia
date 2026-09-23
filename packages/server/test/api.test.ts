import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

let api: FastifyInstance;

beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, follows, viewers cascade');
  const host = new SimHost({
    pool: pool!, seed: 3, speciesDir,
    initialAgents: { sambar: 12 }, minPopulation: { sambar: 12 }, landscape: null,
  });
  await host.boot();
  await host.advance(24);
  api = buildApi({ host, pool: pool! });
  await api.ready();
});

afterAll(async () => { await api?.close(); await pool?.end(); });

maybe('read API', () => {
  it('reports health', async () => {
    const res = await api.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('describes the world clock and season', async () => {
    const body = (await api.inject({ method: 'GET', url: '/world' })).json();
    expect(body.worldTime).toBeGreaterThan(0);
    expect(['monsoon', 'transition', 'dry', 'wet']).toContain(body.season);
    expect(body.population.sambar).toBe(12);
    expect(typeof body.formatted).toBe('string');
  });

  it('lists living animals', async () => {
    const body = (await api.inject({ method: 'GET', url: '/animals' })).json();
    expect(body.animals).toHaveLength(12);
    expect(body.animals[0]).toHaveProperty('currentGoal');
    expect(body.animals[0]).toHaveProperty('drives');
  });

  it('gives a passport read entirely from live state and the event log', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const id = list.animals[0].id;
    const res = await api.inject({ method: 'GET', url: `/animals/${id}/passport` });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p).toMatchObject({ id, speciesId: 'sambar', alive: true });
    expect(['male', 'female']).toContain(p.sex);
    expect(typeof p.ageDays).toBe('number');
    expect(typeof p.lifeStage).toBe('string');
    expect(p.thought.text.length).toBeGreaterThan(0);
    expect(p.thought.basis.length).toBeGreaterThan(0);
    expect(p.lineage).toHaveProperty('mother');
    expect(Array.isArray(p.lineage.offspring)).toBe(true);
    expect(p.skills.map((s: { skill: string }) => s.skill)).toContain('water_locations');
    expect(p.death).toBeNull();
    for (const entry of p.timeline) expect(typeof entry.id).toBe('string');
  });

  it('recaps what happened to an animal since a moment, every line tied to an event', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const id = list.animals[0].id;
    const res = await api.inject({ method: 'GET', url: `/animals/${id}/recap?since=0` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.since).toBe(0);
    expect(body.until).toBeGreaterThan(0);
    for (const line of body.lines) {
      expect(typeof line.eventId).toBe('string');
      expect(typeof line.text).toBe('string');
    }
  });

  it('refuses a recap without a starting point', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const res = await api.inject({ method: 'GET', url: `/animals/${list.animals[0].id}/recap` });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a passport for an animal that never existed', async () => {
    const res = await api.inject({ method: 'GET', url: '/animals/nobody_0000/passport' });
    expect(res.statusCode).toBe(404);
  });

  it('streams what a thought bubble needs with every animal', async () => {
    const body = (await api.inject({ method: 'GET', url: '/animals' })).json();
    expect(body.animals[0]).toHaveProperty('alternativeGoal');
    expect(body.animals[0]).toHaveProperty('goalScore');
    expect(body.animals[0]).toHaveProperty('dependent');
  });

  it('returns one animal with its live state', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const id = list.animals[0].id;
    const body = (await api.inject({ method: 'GET', url: `/animals/${id}` })).json();
    expect(body.id).toBe(id);
    expect(body.drives).toHaveProperty('hunger');
  });

  it('404s for an unknown animal', async () => {
    expect((await api.inject({ method: 'GET', url: '/animals/nope' })).statusCode).toBe(404);
  });

  it('returns an animal timeline from the event log', async () => {
    const list = (await api.inject({ method: 'GET', url: '/animals' })).json();
    const id = list.animals[0].id;
    const body = (await api.inject({ method: 'GET', url: `/animals/${id}/events` })).json();
    expect(Array.isArray(body.events)).toBe(true);
    for (const e of body.events) expect(e.actors).toContain(id);
  });

  it('exposes no route that mutates the world', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await api.inject({ method, url: '/world' })).statusCode).toBe(404);
    }
  });
});
