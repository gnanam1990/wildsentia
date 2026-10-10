import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApi } from '../src/api.js';
import { ConnectionCaps, GENERAL_LIMIT_DEFAULTS, NetworkRateLimit, WindowRateLimit, generalLimits } from '../src/limits.js';
import { forwardedClient } from '../src/network.js';
import type { Pool } from '../src/db/pool.js';
import type { SimHost } from '../src/simHost.js';

/**
 * Workstream D: the general limits the security review left open ("public reads and /live
 * connections have no general limit"). No database or world is needed: the host has no
 * checkpoint, so observation routes answer 503, which is still not a 429.
 */

const host = { worldId: null, rewardSubject: () => null, observation: () => null, isWriterActive: true,
  lastError: null, hasFreshCheckpoint: true, checkpointTime: 0 } as unknown as SimHost;
const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;

describe('WindowRateLimit', () => {
  it('allows the per-minute count in each window, per network', () => {
    const limit = new WindowRateLimit(3);
    expect([1, 2, 3, 4].map(() => limit.take('a', 0))).toEqual([true, true, true, false]);
    expect(limit.take('b', 0)).toBe(true);
    expect(limit.take('a', 60_000)).toBe(true);
  });

  it('never refuses a newcomer because the table is full, so the owner cannot be locked out', () => {
    const limit = new WindowRateLimit(120, 100);
    for (let i = 0; i < 100; i++) limit.take(`net-${i}`, 0);
    expect(limit.take('owner', 1000)).toBe(true);
    expect(limit.size).toBeLessThanOrEqual(100);
  });
});

describe('NetworkRateLimit', () => {
  it('allows a burst of a quarter minute, then refills at the per-minute rate', () => {
    const limit = new NetworkRateLimit(60); // One a second, bursts of 15.
    for (let i = 0; i < 15; i++) expect(limit.take('a', 0).ok).toBe(true);
    expect(limit.take('a', 0)).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(limit.take('b', 0).ok).toBe(true);
    expect(limit.take('a', 999).ok).toBe(false);
    expect(limit.take('a', 2_000).ok).toBe(true);
  });

  it('stays bounded, forgetting visitors whose buckets are full before anyone mid-burst', () => {
    const limit = new NetworkRateLimit(60, 3);
    limit.take('busy', 0); limit.take('idle1', 0); limit.take('idle2', 0);
    for (let i = 0; i < 14; i++) limit.take('busy', 0);
    // After 2 s the idle ones have refilled; "busy" (empty) has only two tokens back.
    expect(limit.take('new', 2_000).ok).toBe(true);
    expect(limit.size).toBeLessThanOrEqual(3);
    expect(limit.take('busy', 2_000).ok).toBe(true);
    expect(limit.take('busy', 2_000).ok).toBe(true);
    expect(limit.take('busy', 2_000).ok).toBe(false);
  });
});

describe('ConnectionCaps', () => {
  it('caps connections per network and in total, and gives places back', () => {
    const caps = new ConnectionCaps(3, 2);
    expect(caps.admit('a')).toBe('ok');
    expect(caps.admit('a')).toBe('ok');
    expect(caps.admit('a')).toBe('network');
    expect(caps.admit('b')).toBe('ok');
    expect(caps.admit('c')).toBe('total');
    caps.release('a');
    expect(caps.admit('c')).toBe('ok');
    expect(caps.total).toBe(3);
    caps.release('nobody');
    expect(caps.total).toBe(3);
  });
  it('treats 0 as no cap', () => {
    const caps = new ConnectionCaps(0, 0);
    for (let i = 0; i < 500; i++) expect(caps.admit('a')).toBe('ok');
  });
});

describe('generalLimits', () => {
  it('has generous defaults, takes overrides, and refuses nonsense at startup', () => {
    expect(generalLimits({})).toEqual(GENERAL_LIMIT_DEFAULTS);
    expect(generalLimits({ VANA_PUBLIC_READS_PER_MINUTE: '', VANA_LIVE_MAX_CONNECTIONS: ' ' })).toEqual(GENERAL_LIMIT_DEFAULTS);
    expect(generalLimits({ VANA_PUBLIC_READS_PER_MINUTE: '0', VANA_LIVE_MAX_CONNECTIONS: '5000', VANA_LIVE_MAX_CONNECTIONS_PER_NETWORK: '7' }))
      .toEqual({ publicReadsPerMinute: 0, liveMaxConnections: 5000, liveMaxPerNetwork: 7 });
    for (const bad of ['-1', '1.5', 'lots', '99999999'])
      expect(() => generalLimits({ VANA_LIVE_MAX_CONNECTIONS_PER_NETWORK: bad })).toThrow(/VANA_LIVE_MAX_CONNECTIONS_PER_NETWORK/);
    // Normal observers: well under one read a second and one socket each.
    expect(GENERAL_LIMIT_DEFAULTS.publicReadsPerMinute).toBeGreaterThanOrEqual(600);
    expect(GENERAL_LIMIT_DEFAULTS.liveMaxPerNetwork).toBeGreaterThanOrEqual(50);
  });
});

describe('forwardedClient', () => {
  it('picks the same visitor address as Fastify does for the same trusted hops', async () => {
    const cases: Array<[string, string | undefined]> = [
      ['10.0.0.2', undefined], ['10.0.0.2', '203.0.113.9'], ['10.0.0.2', '1.1.1.1, 203.0.113.9'],
      ['10.0.0.2', ' 1.1.1.1 ,  2.2.2.2 , 203.0.113.9 '], ['10.0.0.2', ''], ['::ffff:10.0.0.2', '2001:db8::5'],
    ];
    for (const hops of [0, 1, 2]) {
      const app = Fastify({ trustProxy: hops > 0 ? (_a: string, hop: number) => hop < hops : false });
      app.get('/ip', async (req) => req.ip);
      for (const [remote, xff] of cases) {
        const res = await app.inject({ url: '/ip', remoteAddress: remote, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
        expect(forwardedClient(remote, xff, hops), `${hops} ${remote} ${xff}`).toBe(res.body);
      }
      await app.close();
    }
  });
});

describe('public read limit', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApi({ host, pool, trustedProxyHops: 1, limits: { publicReadsPerMinute: 40 } }); // Bursts of 10.
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  const read = (url: string, visitor: string) => app.inject({ url, remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': visitor } });

  it('turns away one visitor network past its allowance with 429 and Retry-After, and nobody else', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await read(i % 2 ? '/world' : '/animals', '198.51.100.7')).statusCode);
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    const refused = await read('/world', '198.51.100.7');
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: 'rate_limited' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Another visitor behind the same proxy is counted separately.
    expect((await read('/world', '198.51.100.8')).statusCode).not.toBe(429);
  });

  it('counts an IPv6 /64 as one visitor and counts unknown paths too', async () => {
    for (let i = 1; i <= 10; i++) await read(`/no-such-route-${i}`, `2001:db8:9:1::${i}`);
    expect((await read('/world', '2001:db8:9:1::ff')).statusCode).toBe(429);
  });

  it('never limits health checks', async () => {
    for (let i = 0; i < 30; i++) expect((await read('/health', '198.51.100.9')).statusCode).not.toBe(429);
  });

  it('can be turned off', async () => {
    const open = buildApi({ host, pool, limits: { publicReadsPerMinute: 0 } });
    await open.ready();
    for (let i = 0; i < 50; i++) expect((await open.inject({ url: '/world' })).statusCode).not.toBe(429);
    await open.close();
  });

  it('is on by default with the generous default', async () => {
    const defaults = buildApi({ host, pool });
    await defaults.ready();
    const statuses: number[] = [];
    for (let i = 0; i < GENERAL_LIMIT_DEFAULTS.publicReadsPerMinute / 4 + 1; i++) statuses.push((await defaults.inject({ url: '/world' })).statusCode);
    expect(statuses.at(-2)).not.toBe(429);
    expect(statuses.at(-1)).toBe(429);
    await defaults.close();
  });
});
