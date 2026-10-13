import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentRecord } from '../live/liveStore.js';
import type { OwnershipStore } from './store.js';
import type { OwnershipConfig, PurchaseAdapter } from './purchase.js';
import type { LifeService } from './lives.js';
import type { ControlService } from './control.js';

/** Congo 1C: everything that owns, spawns and hands over animals. */
export interface OwnedDeps {
  store: OwnershipStore; shop: PurchaseAdapter; lives: LifeService; control: ControlService; config: OwnershipConfig;
  /** Congo 1D: whether a bounty is active on a life (shown only to its owner). */
  bountyActive?: (lifeId: string) => Promise<boolean>;
  /** Congo 1D: an asset's last decided bounty and its payout (shown only to its owner). */
  lastBounty?: (assetId: string) => Promise<{ outcome: string; role: string; payout: { status: string } | null; paidToOwner: boolean } | null>;
  /** Congo 1E: an alive animal's state now, and whether anyone is steering it. */
  animalOf?: (animalId: string) => { state: string; steered: boolean } | null;
}
type Person = (req: FastifyRequest, reply: FastifyReply) => Promise<{ agent: AgentRecord; json: Record<string, unknown> } | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT = /^ag_[0-9a-f]{16}$/;

/** HTTP status for each refusal. */
const STATUS: Record<string, number> = { no_wallet: 403, not_owner: 404, unknown_species: 400, bad_key: 400 };

/**
 * The owner's routes (spec §3-§4, §7 player pages), for a signed-in person:
 * - `GET /congo/store` quotes (public), `POST /congo/store/buy` buys (SIMULATED);
 * - `GET /congo/assets` lists their animals with each one's current life and controller;
 * - `POST /congo/assets/:id/spawn | agents | sell`.
 * Steering itself is `/play/possess {animalId}` (the owner) and `/agents/me/possess` (an agent).
 */
export function installOwnershipRoutes(scope: FastifyInstance, owned: OwnedDeps, person: Person): void {
  const { store, shop, lives, control, config } = owned;
  const ownerOf = async (agent: AgentRecord) => store.accountOfAgent(agent.id);

  scope.get('/congo/store', async () => ({
    simulated: true, token: config.token, decimals: config.decimals, pricingVersion: config.pricingVersion,
    maxAlivePerOwner: config.maxAlivePerOwner, quotes: Object.keys(config.prices).map((id) => shop.quote(id)),
  }));

  scope.post('/congo/store/buy', async (req, reply) => {
    const ctx = await person(req, reply); if (!ctx) return reply;
    const account = await ownerOf(ctx.agent);
    if (!account) return reply.code(403).send({ error: 'no_account' });
    const speciesId = typeof ctx.json.speciesId === 'string' ? ctx.json.speciesId : '';
    const key = typeof ctx.json.idempotencyKey === 'string' ? ctx.json.idempotencyKey : '';
    const result = await shop.buy({ accountId: account.accountId, wallet: account.wallet }, speciesId, key);
    if (!result.ok) return reply.code(STATUS[result.reason] ?? 409).send({ error: result.reason });
    return { simulated: true, replayed: result.replayed, assetId: result.asset.assetId, speciesId: result.asset.speciesId,
      priceAtomic: result.purchase.priceAtomic.toString(), feeAtomic: result.purchase.feeAtomic.toString(), decimals: result.purchase.decimals,
      pricingVersion: result.purchase.pricingVersion };
  });

  scope.get('/congo/assets', async (req, reply) => {
    const ctx = await person(req, reply); if (!ctx) return reply;
    const account = await ownerOf(ctx.agent);
    if (!account) return { assets: [], simulated: true };
    const assets = await store.assetsOf(account.accountId);
    return { simulated: true, maxAlivePerOwner: config.maxAlivePerOwner, assets: await Promise.all(assets.map(async (a) => {
      const life = (await store.livesOf(a.assetId)).at(-1) ?? null, lease = life ? await store.openLeaseOf(life.lifeId) : null;
      return { assetId: a.assetId, speciesId: a.speciesId, status: a.status, pricingVersion: a.pricingVersion,
        agents: await store.grantsOf(a.assetId),
        animal: life?.status === 'alive' && life.animalId && owned.animalOf ? owned.animalOf(life.animalId) : null,
        bounty: owned.lastBounty ? await owned.lastBounty(a.assetId) : null,
        life: life ? { lifeId: life.lifeId, animalId: life.animalId, status: life.status, spawnedAt: life.spawnedAt, diedAt: life.diedAt,
          deathCause: life.deathCause, killerAnimalId: life.killerAnimalId, cooldownUntil: life.cooldownUntil,
          controller: lease ? { kind: lease.holderKind, id: lease.holderId } : null,
          bountyActive: life.status === 'alive' && owned.bountyActive ? await owned.bountyActive(life.lifeId) : false } : null };
    })) };
  });

  scope.post<{ Params: { id: string } }>('/congo/assets/:id/spawn', async (req, reply) => {
    const ctx = await person(req, reply); if (!ctx) return reply;
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: 'not_owner' });
    const account = await ownerOf(ctx.agent);
    if (!account) return reply.code(403).send({ error: 'no_account' });
    const result = await lives.spawn(account.accountId, req.params.id);
    if (!result.ok) return reply.code(STATUS[result.reason] ?? 409).send({ error: result.reason });
    return { lifeId: result.lifeId, animalId: result.animalId, patchId: result.patchId };
  });

  scope.post<{ Params: { id: string } }>('/congo/assets/:id/agents', async (req, reply) => {
    const ctx = await person(req, reply); if (!ctx) return reply;
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: 'not_owner' });
    const account = await ownerOf(ctx.agent), asset = await store.asset(req.params.id);
    if (!account || !asset || asset.ownerAccountId !== account.accountId) return reply.code(404).send({ error: 'not_owner' });
    if (asset.status === 'retired') return reply.code(409).send({ error: 'not_active' });
    const agentId = typeof ctx.json.agentId === 'string' ? ctx.json.agentId : '';
    if (!AGENT.test(agentId)) return reply.code(400).send({ error: 'bad_agent' });
    if (ctx.json.grant === false) return { revoked: await control.revoke(account.accountId, asset.assetId, agentId) };
    const agent = await store.agentKind(agentId);
    if (agent !== 'agent') return reply.code(404).send({ error: 'unknown_agent' });
    return { granted: await store.grant(asset.assetId, agentId) };
  });

  scope.post<{ Params: { id: string } }>('/congo/assets/:id/sell', async (req, reply) => {
    const ctx = await person(req, reply); if (!ctx) return reply;
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: 'not_owner' });
    const account = await ownerOf(ctx.agent);
    if (!account) return reply.code(403).send({ error: 'no_account' });
    const key = typeof ctx.json.idempotencyKey === 'string' ? ctx.json.idempotencyKey : '';
    const result = await shop.sell({ accountId: account.accountId, wallet: account.wallet }, req.params.id, key);
    if (!result.ok) return reply.code(STATUS[result.reason] ?? 409).send({ error: result.reason });
    return { simulated: true, sold: req.params.id, priceAtomic: result.purchase.priceAtomic.toString(), feeAtomic: result.purchase.feeAtomic.toString() };
  });
}
