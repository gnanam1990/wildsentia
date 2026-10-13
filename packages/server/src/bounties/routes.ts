import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BountyStore, Bounty, Preset } from './store.js';
import { PRESETS, type BountyEngine } from './engine.js';
import type { BountyDiscovery } from './discovery.js';

/** Congo 1D: bounties' services, for the live API. */
export interface BountyDeps {
  store: BountyStore; engine: BountyEngine; discovery: BountyDiscovery;
  /** The operator's admin token; no admin routes without it. */
  adminToken: string | null;
  now(): number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = (s: string) => createHash('sha256').update(s).digest();
/** The live scope keeps each JSON body's raw text for signatures: the parsed object is under `json`. */
const bodyOf = (req: FastifyRequest): Record<string, unknown> => {
  const body = req.body as { json?: unknown } | undefined, json = body && 'json' in body ? body.json : body;
  return json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : {};
};

/** What anyone may know of a bounty: never the animal, its life or its owner (spec §6). */
export function publicBounty(b: Bounty, worldTime: number) {
  return { bountyId: b.bountyId, preset: b.preset, speciesId: b.targetSpeciesId, region: b.targetRegion, amountAtomic: b.amountAtomic.toString(),
    decimals: b.decimals, timeLeftWorldSeconds: Math.max(0, (b.deadlineWorldTime ?? worldTime) - worldTime), status: b.status, simulated: true as const };
}

/**
 * - Public: `GET /congo/bounties` (species, region, amount, time left) and, after settlement,
 *   `GET /congo/bounties/:id/record` (the outcome and its event slice, with its hash).
 * - Admin (Bearer token): the editor's presets, drafts, validation, publication, cancellation,
 *   resuming a held bounty, and the full list.
 */
export function installBountyRoutes(scope: FastifyInstance, deps: BountyDeps): void {
  const { store, engine } = deps;

  scope.get('/congo/bounties', async () => ({ simulated: true,
    bounties: (await store.active()).filter((b) => b.status === 'active').map((b) => publicBounty(b, deps.now())) }));

  scope.get<{ Params: { id: string } }>('/congo/bounties/:id/record', async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: 'not_found' });
    const b = await store.get(req.params.id);
    if (!b || b.status !== 'settled') return reply.code(404).send({ error: 'not_settled' });
    const record = await store.record(b.bountyId), settlement = await store.settlementOf(b.bountyId);
    return { simulated: true, bountyId: b.bountyId, outcome: b.outcome, targetAnimalId: b.targetAnimalId, winnerAnimalId: b.outcome === 'predator' ? b.winnerAnimalId : null,
      decidedWorldTime: b.decidedWorldTime, rulesHash: b.rulesHash, payout: settlement ? { wallet: settlement.payeeWallet, amountAtomic: settlement.amountAtomic.toString(),
        status: settlement.status } : null, entrants: (await store.entrants(b.bountyId)).length, record };
  });

  if (!deps.adminToken) return;
  const expected = hash(deps.adminToken);
  const admin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const given = req.headers.authorization?.match(/^Bearer ([^\s]{1,256})$/)?.[1] ?? '';
    if (timingSafeEqual(hash(given), expected)) return true;
    reply.code(401).send({ error: 'admin_only' });
    return false;
  };
  const view = (b: Bounty) => ({ ...publicBounty(b, deps.now()), targetAnimalId: b.targetAnimalId, targetLifeId: b.targetLifeId,
    targetOwnerWallet: b.targetOwnerWallet, windowWorldSeconds: b.windowWorldSeconds, deadlineWorldTime: b.deadlineWorldTime,
    eligiblePredators: b.eligiblePredators, rules: b.rules, rulesHash: b.rulesHash, validation: b.validation, outcome: b.outcome,
    winnerWallet: b.winnerWallet, winnerAnimalId: b.winnerAnimalId, cancelReason: b.cancelReason, holdReason: b.holdReason });

  scope.get('/congo/admin/bounties/presets', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    return { simulated: true, presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, amountAtomic: p.amountAtomic.toString(), decimals: 6,
      windowWorldSeconds: p.windowWorldSeconds })) };
  });
  scope.get('/congo/admin/bounties', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    return { bounties: (await store.list()).map(view) };
  });
  scope.post('/congo/admin/bounties', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const body = bodyOf(req);
    const amount = typeof body.amountAtomic === 'string' && /^[0-9]{1,16}$/.test(body.amountAtomic) ? BigInt(body.amountAtomic) : undefined;
    const window = typeof body.windowWorldSeconds === 'number' ? body.windowWorldSeconds : undefined;
    const result = await engine.draft({ targetAnimalId: String(body.targetAnimalId ?? ''), preset: String(body.preset ?? '') as Preset,
      ...(amount !== undefined ? { amountAtomic: amount } : {}), ...(window !== undefined ? { windowWorldSeconds: window } : {}) });
    return result.ok ? view(result.bounty) : reply.code(400).send({ error: result.reason });
  });
  scope.post<{ Params: { id: string } }>('/congo/admin/bounties/:id/validate', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const result = UUID.test(req.params.id) ? await engine.validate(req.params.id) : null;
    return result ?? reply.code(404).send({ error: 'not_found' });
  });
  scope.post<{ Params: { id: string } }>('/congo/admin/bounties/:id/publish', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: 'not_found' });
    const result = await engine.publish(req.params.id);
    if (result.ok) await deps.discovery.refresh();
    return result.ok ? view(result.bounty) : reply.code(409).send({ error: result.reason });
  });
  scope.post<{ Params: { id: string } }>('/congo/admin/bounties/:id/cancel', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const reason = String(bodyOf(req).reason ?? '').trim().slice(0, 500);
    if (!reason) return reply.code(400).send({ error: 'reason_required' });
    if (!UUID.test(req.params.id) || !(await store.cancel(req.params.id, reason))) return reply.code(409).send({ error: 'not_cancellable' });
    await deps.discovery.refresh();
    return { cancelled: true };
  });
  scope.post<{ Params: { id: string } }>('/congo/admin/bounties/:id/resume', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    return UUID.test(req.params.id) && await store.resume(req.params.id) ? { resumed: true } : reply.code(409).send({ error: 'not_held' });
  });
}
