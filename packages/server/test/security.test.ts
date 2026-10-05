import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApi } from '../src/api.js';
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
