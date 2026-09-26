import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Agent, WorldEvent } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { buildApi } from '../src/api.js';
import { testDatabaseUrl } from './testDatabase.js';
import { distinctEvents, Insights, outlookGoals, outlookState } from '../src/insights/insights.js';
import { typesafeConfig, typesafeDailyCalls, typesafeSystemOne, validAnswer, type Question, type SystemOne } from '../src/insights/typesafe.js';

const config = { apiKey: 'test-key', baseUrl: 'https://typesafe.example/v1', model: 'jev-latest', timeoutMs: 1000 };
const choice: Question = { type: 'choice', instructions: 'Which?', criteria: { rest: 'Rest', find_water: 'Drink' } };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('TypeSafe client', () => {
  it('is off without a key and reads the documented settings', () => {
    expect(typesafeConfig({})).toBeNull();
    expect(typesafeConfig({ TYPESAFE_AI_API_KEY: '  ' })).toBeNull();
    expect(typesafeConfig({ TYPESAFE_AI_API_KEY: 'k' })).toMatchObject({ baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest' });
    expect(typesafeConfig({ TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: 'jev-1.13' })).toMatchObject({ model: 'jev-1.13' });
    expect(() => typesafeConfig({ TYPESAFE_AI_API_KEY: 'k', TYPESAFE_BASE_URL: 'http://plain.example' })).toThrow();
  });

  it('reads the daily call budget, treating an empty compose value as unset', () => {
    expect(typesafeDailyCalls({})).toBe(1000);
    expect(typesafeDailyCalls({ TYPESAFE_DAILY_CALLS: '' })).toBe(1000);
    expect(typesafeDailyCalls({ TYPESAFE_DAILY_CALLS: '250' })).toBe(250);
    expect(() => typesafeDailyCalls({ TYPESAFE_DAILY_CALLS: 'lots' })).toThrow();
  });

  it('posts the System One request with a bearer key and returns checked answers', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply(200, {
      model: 'jev-1.13.0', answers: { next: { type: 'choice', choice: 'rest', probabilities: { rest: 0.7, find_water: 0.3 }, confidence: 0.6 } },
      usage: { input_tokens: 10, output_tokens: 2 } }));
    const result = await typesafeSystemOne(config, fetchImpl as typeof fetch)({ a: 1 }, { next: choice });
    expect(result).toEqual({ model: 'jev-1.13.0', answers: { next: { type: 'choice', choice: 'rest', probabilities: { rest: 0.7, find_water: 0.3 }, confidence: 0.6 } } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://typesafe.example/v1/systemone');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init!.body as string)).toEqual({ model: 'jev-latest', state: { a: 1 }, questions: { next: choice } });
  });

  it('retries once when rate limited, and never puts the key in an error', async () => {
    const pause = vi.fn(async () => undefined);
    const limited = vi.fn(async () => reply(429, { message: 'slow down', error_type: 'rate_limited' }));
    const error = await typesafeSystemOne(config, limited as unknown as typeof fetch, pause)({}, { next: choice }).catch((e: Error) => e);
    expect(limited).toHaveBeenCalledTimes(2); expect(pause).toHaveBeenCalledOnce();
    expect(String(error)).toContain('429'); expect(String(error)).not.toContain('test-key');
    const unauthorised = vi.fn(async () => reply(401, { message: 'bad key test-key', error_type: 'authentication_error' }));
    const denied = await typesafeSystemOne(config, unauthorised as unknown as typeof fetch, pause)({}, { next: choice }).catch((e: Error) => e);
    expect(unauthorised).toHaveBeenCalledOnce(); expect(String(denied)).not.toContain('test-key');
  });

  it('rejects answers that do not fit their question', async () => {
    expect(validAnswer(choice, { type: 'choice', choice: 'fly', probabilities: {}, confidence: 1 })).toBe(false);
    expect(validAnswer(choice, { type: 'choice', choice: 'rest', probabilities: { rest: 2 }, confidence: 1 })).toBe(false);
    const score: Question = { type: 'score', instructions: 'How?', criteria: ['low', 'high'] };
    expect(validAnswer(score, { type: 'score', score: 1, probabilities: { 0: 0, 1: 1 }, confidence: 1 })).toBe(true);
    expect(validAnswer(score, { type: 'score', score: 3, probabilities: {}, confidence: 1 })).toBe(false);
    expect(validAnswer({ type: 'noul', instructions: 'Yes?' }, { type: 'noul', noul: 0.9 })).toBe(true);
    const wrong = vi.fn(async () => reply(200, { model: 'm', answers: { next: { type: 'noul', noul: 1 } } }));
    await expect(typesafeSystemOne(config, wrong as unknown as typeof fetch)({}, { next: choice })).rejects.toThrow('did not match');
  });
});

const agent = (extra: Partial<Agent> = {}): Agent => ({
  id: 'tiger_0001', speciesId: 'tiger', sex: 'female', ageDays: 2000, lifeStage: 'adult', state: 'resting',
  currentGoal: 'rest', drives: { hunger: 0.8, thirst: 0.2, fatigue: 0.1, fear: 0 }, offspringIds: [], dependentOn: null,
  pregnantSince: null, patchId: 4, ...extra,
} as unknown as Agent);
const tiger = { displayName: 'Tiger', hunts: true, scavenges: true };
const deer = { displayName: 'Chital', hunts: false, scavenges: false };

describe('observer insights', () => {
  it('offers each animal only the goals open to it', () => {
    expect(outlookGoals(agent(), tiger)).toEqual(expect.arrayContaining(['hunt', 'scavenge', 'breed']));
    expect(outlookGoals(agent({ speciesId: 'chital' }), deer)).not.toContain('hunt');
    const calf = outlookGoals(agent({ lifeStage: 'juvenile', dependentOn: 'mother' }), deer);
    expect(calf).toContain('follow_parent'); expect(calf).not.toContain('breed');
    expect(outlookGoals(agent({ offspringIds: ['c'] }), deer)).toContain('care_for_young');
  });

  it('describes the animal from its saved state in viewer terms', () => {
    const state = outlookState(agent(), tiger, 3 * 3600, { habitat: 'shola', waterVolume: 0, grass: 100 });
    expect(state.animal).toMatchObject({ species: 'Tiger', needsPercent: { hunger: 80, thirst: 20 }, doingNow: 'resting' });
    expect(state.surroundings).toMatchObject({ timeOfDay: 'night', habitat: 'shola', surfaceWaterHere: false, grassHere: 'little' });
  });

  it('keeps one kind of moment once, newest first', () => {
    const e = (id: string, type: string, actors: string[]) => ({ id, type, outcome: 'success', actors, worldTime: 1 }) as unknown as WorldEvent;
    const picked = distinctEvents([e('1', 'scavenged', ['vulture_1', 'chital_2']), e('2', 'scavenged', ['vulture_9', 'chital_3']),
      e('3', 'hunt', ['tiger_1', 'sambar_1']), e('4', 'scavenged', ['jackal_1', 'sambar_1'])]);
    expect(picked.map((x) => x.id)).toEqual(['1', '3', '4']);
  });

  it('asks once per checkpoint, shares concurrent requests and stops at the daily budget', async () => {
    let calls = 0;
    const ask: SystemOne = async (_state, questions) => {
      calls++;
      const goals = Object.keys((questions.next as { criteria: Record<string, string> }).criteria);
      return { model: 'jev', answers: { next: { type: 'choice', choice: goals[0]!, confidence: 0.5,
        probabilities: Object.fromEntries(goals.map((g, i) => [g, i === 1 ? 0.6 : 0.4 / (goals.length - 1)])) } } };
    };
    const insights = new Insights(ask, 2);
    const [a, b] = await Promise.all([insights.outlook(agent(), tiger, 3600, undefined), insights.outlook(agent(), tiger, 3600, undefined)]);
    expect(calls).toBe(1); expect(a).toEqual(b);
    expect(a.ok && a.value.choices[0]).toMatchObject({ goal: 'find_water', probability: 0.6 });
    expect(a.ok && a.value.choices.map((c) => c.probability)).toEqual([...(a.ok ? a.value.choices.map((c) => c.probability) : [])].sort((x, y) => y - x));
    await insights.outlook(agent(), tiger, 7200, undefined);
    expect(calls).toBe(2);
    expect(await insights.outlook(agent(), tiger, 10_800, undefined)).toEqual({ ok: false, reason: 'budget_exhausted' });
    expect(await new Insights(null).outlook(agent(), tiger, 0, undefined)).toEqual({ ok: false, reason: 'not_configured' });
    const failing = new Insights(async () => { throw new Error('down'); });
    expect(await failing.outlook(agent(), tiger, 0, undefined)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('keeps only the moments scored notable or better, highest first', async () => {
    const events = ['scavenged', 'hunt', 'birth'].map((type, i) => ({ id: `ev${i}`, type, outcome: 'success',
      actors: [`${['vulture', 'tiger', 'chital'][i]}_1`], worldTime: 100 }) as unknown as WorldEvent);
    const scores = [0.3, 3.4, 2.6];
    const insights = new Insights(async (_state, questions) => ({ model: 'jev', answers: Object.fromEntries(Object.keys(questions)
      .map((id, i) => [id, { type: 'score', score: scores[i]!, probabilities: {}, confidence: 0.7 }])) }));
    const result = await insights.highlights(events, 100, 5, (id) => id);
    expect(result.ok && result.value.highlights.map((h) => h.event.id)).toEqual(['ev1', 'ev2']);
  });
});

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
let api: FastifyInstance, bare: FastifyInstance, host: SimHost;
const asked: unknown[] = [];

beforeAll(async () => {
  if (!url) return;
  await migrate(pool!);
  await pool!.query('truncate events, snapshots, human_motion, follows, viewers, tracks, animal_archive cascade');
  host = new SimHost({ pool: pool!, seed: 5, speciesDir, initialAgents: { sambar: 8 }, minPopulation: { sambar: 8 }, landscape: null });
  await host.boot();
  await host.advance(6);
  const insights = new Insights(async (state, questions) => {
    asked.push(state);
    return { model: 'jev-test', answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === 'choice'
      ? { type: 'choice', choice: Object.keys(q.criteria)[0]!, confidence: 0.5,
        probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 0.5 : 0.5 / (Object.keys(q.criteria).length - 1)])) }
      : { type: 'score', score: 2.5, probabilities: {}, confidence: 0.5 }])) };
  });
  api = buildApi({ host, pool: pool!, insights });
  bare = buildApi({ host, pool: pool! });
  await Promise.all([api.ready(), bare.ready()]);
});

afterAll(async () => { await api?.close(); await bare?.close(); await host?.abort(); await pool?.end(); });

maybe('insight routes', () => {
  it('estimates a living animal\'s next hour from its checkpoint state', async () => {
    const id = (await api.inject('/animals')).json().animals[0].id as string;
    const res = await api.inject(`/insights/animals/${id}/outlook`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ available: true, model: 'jev-test', asOfWorldTime: host.checkpointTime });
    expect(body.choices.length).toBeGreaterThan(3);
    expect(body.notice).toContain('simulation decides');
    expect(JSON.stringify(asked.at(-1))).toContain('Sambar');
    expect((await api.inject('/insights/animals/nobody/outlook')).statusCode).toBe(404);
  });

  it('is plainly absent without a key', async () => {
    const id = (await api.inject('/animals')).json().animals[0].id as string;
    expect((await bare.inject(`/insights/animals/${id}/outlook`)).json()).toEqual({ available: false, reason: 'not_configured' });
    expect((await bare.inject('/insights/highlights')).json()).toEqual({ available: false, reason: 'not_configured' });
  });

  it('picks highlights from the latest recorded events', async () => {
    const res = await api.inject('/insights/highlights');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    for (const h of body.highlights) expect(h.score).toBeGreaterThanOrEqual(2);
  });
});
