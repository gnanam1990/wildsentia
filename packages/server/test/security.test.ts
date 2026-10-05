import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApi } from '../src/api.js';
import { networkKey } from '../src/network.js';
import type { Pool } from '../src/db/pool.js';
import type { SimHost } from '../src/simHost.js';

/**
 * Regression tests from the 5 October 2026 security review (docs/2026-10-05-security-review.md).
 * None needs a database or a world: the host and pool are stand-ins, and a pool that is reached
 * at all fails the way an unreachable database would.
 */

const adminToken = 'security-review-fixture-'.repeat(2);
const host = { worldId: null, rewardSubject: () => null, observation: () => null } as unknown as SimHost;
const failingPool = {
  query: async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:5432 (database vana)'); },
  connect: async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:5432 (database vana)'); },
} as unknown as Pool;

let app: FastifyInstance;
beforeAll(async () => {
  app = buildApi({ host, pool: failingPool, rewards: { adminToken, network: 'base', claimPolicy: 'first_valid' },
    social: { adminToken } });
  await app.ready();
});
afterAll(async () => { await app?.close(); });

describe('route guards', () => {
  it('guard the route a request is dispatched to, however its path is spelled', async () => {
    // The router decodes %61 to "a"; a guard that matched only the raw URL let these through unauthenticated.
    for (const url of ['/admin/rewards/page?kind=drops&cursor=x', '/%61dmin/rewards/page?kind=drops&cursor=x',
      '/admin/%72ewards/page?kind=drops&cursor=x', '/%61%64%6d%69%6e/rewards/page?kind=drops&cursor=x']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toEqual({ error: 'admin_auth_required' });
    }
    for (const url of ['/admin/social/candidates?cursor=!', '/%61dmin/social/candidates?cursor=!', '/admin/%73ocial/candidates?cursor=!']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toEqual({ error: 'social_admin_auth_required' });
    }
    // Public routes keep their same-origin rule and rate limit under any spelling too.
    for (const url of ['/rewards/session', '/%72ewards/session', '/holder/challenge', '/%68older/challenge']) {
      const res = await app.inject({ method: 'POST', url, payload: {}, headers: { 'sec-fetch-site': 'cross-site' } });
      expect(res.statusCode, url).toBe(403);
    }
  });
});

describe('per-visitor limits', () => {
  it('count one IPv6 /64 as one visitor, so a host cannot rotate addresses past them', async () => {
    // A machine is normally given a whole /64; counting single addresses gave it 2^64 fresh allowances.
    const statuses: number[] = [];
    for (let i = 1; i <= 121; i++) {
      const res = await app.inject({ url: '/admin/rewards', remoteAddress: `2001:db8:7:1::${i.toString(16)}`,
        headers: { authorization: 'Bearer wrong-key' } });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 120).every((s) => s === 401)).toBe(true);
    expect(statuses[120]).toBe(429);
    // A different /64 is a different visitor.
    expect((await app.inject({ url: '/admin/rewards', remoteAddress: '2001:db8:7:2::1', headers: { authorization: 'Bearer wrong-key' } })).statusCode).toBe(401);
  });
  it('reduce an address to the network it stands for', () => {
    expect(networkKey('203.0.113.9')).toBe('203.0.113.9');
    expect(networkKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(networkKey('2001:db8:7:1::1')).toBe('2001:db8:7:1::/64');
    expect(networkKey('2001:0DB8:0007:0001:ffff:1:2:3')).toBe('2001:db8:7:1::/64');
    expect(networkKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(networkKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(networkKey('::1')).toBe('0:0:0:0::/64');
  });
});

describe('error responses', () => {
  it('never send an unexpected failure\'s message, which can name hosts, tables or constraints', async () => {
    const res = await app.inject({ method: 'POST', url: '/rewards/session', payload: {} });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    expect(res.body).not.toContain('10.1.2.3');
    expect(res.body).not.toContain('ECONNREFUSED');
  });
  it('still explain a client mistake', async () => {
    const res = await app.inject({ method: 'POST', url: '/rewards/session', headers: { 'content-type': 'application/json' }, payload: '{"x":' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });
});
