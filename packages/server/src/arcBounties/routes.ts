import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BountyChain } from './chain.js';
import type { ArcBountyEngine } from './engine.js';
import type { ArcBounty, ArcBountyStore } from './store.js';

/** Congo bounties paid on Arc: their services, for the live API. */
export interface ArcBountyDeps {
  store: ArcBountyStore; engine: ArcBountyEngine; chain: BountyChain;
  /** The operator's admin token; no admin routes without it. */
  adminToken: string | null;
  now(): number;
}

const ID = /^0x[0-9a-f]{64}$/;
const hash = (s: string) => createHash('sha256').update(s).digest();
const bodyOf = (req: FastifyRequest): Record<string, unknown> => {
  const body = req.body as { json?: unknown } | undefined, json = body && 'json' in body ? body.json : body;
  return json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : {};
};

/**
 * What anyone may know of a bounty. While it lasts: its species, region, amount and time left,
 * never the animal or its agent. Once decided: the target, the outcome, who was paid, and the
 * transactions and record hash anyone can check on chain.
 */
export function publicArcBounty(b: ArcBounty, worldTime: number, engine: ArcBountyEngine) {
  const decided = b.outcome !== null;
  return {
    bountyId: b.bountyId, status: b.status, speciesId: b.targetSpeciesId, region: b.targetRegion,
    amountAtomic: b.amountAtomic.toString(), decimals: 6,
    timeLeftWorldSeconds: b.status === 'active' ? Math.max(0, Math.round(b.deadlineWorldTime - worldTime)) : 0,
    expiresAt: b.expiresAt.toISOString(), rulesHash: b.rulesHash,
    publishTx: b.publishTx, publishTxUrl: engine.txUrl(b.publishTx),
    ...(decided ? {
      outcome: b.outcome, targetAnimalId: b.targetAnimalId, winnerAnimalId: b.winnerAnimalId, payeeWallet: b.payeeWallet,
      decidedWorldTime: b.decidedWorldTime, recordHash: b.recordHash, decideTx: b.decideTx, decideTxUrl: engine.txUrl(b.decideTx),
      targetKey: b.targetKey, salt: b.salt,
    } : {}),
  };
}

/**
 * - Public: `GET /congo/arc-bounties` (the pool, live and recent bounties), `GET /congo/arc-bounties/:id`
 *   and, once decided, `GET /congo/arc-bounties/:id/record` (the record its hash was taken over).
 * - Admin (Bearer token): `POST /congo/admin/arc-bounties/random` puts a bounty on a prey animal
 *   picked at random; `GET /congo/admin/arc-bounties/candidates` lists who it could go on;
 *   `GET /congo/admin/arc-bounties` lists recent bounties with their targets and wallets.
 */
export function installArcBountyRoutes(scope: FastifyInstance, deps: ArcBountyDeps): void {
  const { store, engine, chain } = deps;

  scope.get('/congo/arc-bounties', async () => {
    const [pool, recent] = await Promise.all([chain.pool().catch(() => null), store.recent(50)]);
    return { network: chain.chainId, contract: chain.contract, poolAtomic: pool?.toString() ?? null, decimals: 6,
      bounties: recent.filter((b) => b.status !== 'failed').map((b) => publicArcBounty(b, deps.now(), engine)) };
  });

  scope.get<{ Params: { id: string } }>('/congo/arc-bounties/:id', async (req, reply) => {
    const b = ID.test(req.params.id) ? await store.get(req.params.id) : null;
    if (!b || b.status === 'failed') return reply.code(404).send({ error: 'not_found' });
    return publicArcBounty(b, deps.now(), engine);
  });

  scope.get<{ Params: { id: string } }>('/congo/arc-bounties/:id/record', async (req, reply) => {
    const b = ID.test(req.params.id) ? await store.get(req.params.id) : null;
    if (!b || b.outcome === null) return reply.code(404).send({ error: 'not_decided' });
    return { bountyId: b.bountyId, recordHash: b.recordHash, record: b.record };
  });

  if (!deps.adminToken) return;
  const expected = hash(deps.adminToken);
  const admin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const given = req.headers.authorization?.match(/^Bearer ([^\s]{1,256})$/)?.[1] ?? '';
    if (timingSafeEqual(hash(given), expected)) return true;
    reply.code(401).send({ error: 'admin_only' });
    return false;
  };

  /** Every recent bounty with its target and the agents' wallets, for the operator's panel. */
  scope.get('/congo/admin/arc-bounties', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const [pool, limits, recent] = await Promise.all([chain.pool().catch(() => null), chain.limits().catch(() => null), store.recent(100)]);
    return { network: chain.chainId, contract: chain.contract, evaluator: chain.evaluator, poolAtomic: pool?.toString() ?? null,
      limits: limits ? { minAtomic: limits.min.toString(), maxAtomic: limits.max.toString() } : null, decimals: 6,
      bounties: recent.map((b) => ({ ...publicArcBounty(b, deps.now(), engine), targetAnimalId: b.targetAnimalId, targetAgentId: b.targetAgentId,
        targetWallet: b.targetWallet, winnerAgentId: b.winnerAgentId, winnerAnimalId: b.winnerAnimalId, payeeWallet: b.payeeWallet,
        windowWorldSeconds: b.windowWorldSeconds, error: b.error })) };
  });

  scope.get('/congo/admin/arc-bounties/candidates', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    return { candidates: (await engine.candidates(false)).map((c) => ({ animalId: c.animalId, speciesId: c.speciesId, agentId: c.agentId,
      eligiblePredators: c.eligible })), withHunter: (await engine.candidates(true)).length };
  });

  scope.post('/congo/admin/arc-bounties/random', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const body = bodyOf(req);
    const usdc = typeof body.amountUsdc === 'number' ? body.amountUsdc : 1;
    const window = typeof body.windowWorldSeconds === 'number' ? body.windowWorldSeconds : 3 * 86_400;
    if (!Number.isFinite(usdc) || usdc <= 0 || usdc > 1_000_000) return reply.code(400).send({ error: 'bad_amount' });
    const result = await engine.publishRandom({ amountAtomic: BigInt(Math.round(usdc * 1e6)), windowWorldSeconds: window,
      requireHunter: body.requireHunter !== false });
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    return { ...publicArcBounty(result.bounty, deps.now(), engine), targetAnimalId: result.bounty.targetAnimalId, targetAgentId: result.bounty.targetAgentId,
      error: result.bounty.error };
  });
}
