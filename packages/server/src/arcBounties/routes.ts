import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BountyChain } from './chain.js';
import type { ArcBountyEngine } from './engine.js';
import type { ArcBounty, ArcBountyStore } from './store.js';
import { parseSeason, seasonOf } from './season.js';

/** Congo bounties paid on Arc: their services, for the live API. */
export interface ArcBountyDeps {
  store: ArcBountyStore; engine: ArcBountyEngine; chain: BountyChain;
  /** The operator's admin token; no admin routes without it. */
  adminToken: string | null;
  now(): number;
  /** The contract's deployment block: the public board's pool flows are read from its events since. */
  fromBlock?: bigint | null;
  /** The site's public origin, for share links; relative links when unset. */
  origin?: string | null;
  /** World hours per real hour, for "about how long" in share text. */
  rate?: () => number;
}

const ID = /^0x[0-9a-f]{64}$/;
/** Bounties the operator may drop in a minute. */
export const ADMIN_WRITES_PER_MINUTE = 6;
/** A read shared by every caller for `ttlMs`, one at a time; a failure is shared too until it expires. */
export function cachedRead<T>(ttlMs: number, read: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  let last: { at: number; value: Promise<T> } | null = null;
  return () => {
    if (!last || now() - last.at >= ttlMs) last = { at: now(), value: read() };
    return last.value;
  };
}
/** A bounty's amount (USDC, default 1) and window (world seconds, default 3 world days) from a request. */
const termsOf = (body: Record<string, unknown>): { amountAtomic: bigint; windowWorldSeconds: number } | { error: string } => {
  const usdc = typeof body.amountUsdc === 'number' ? body.amountUsdc : 1;
  const window = typeof body.windowWorldSeconds === 'number' ? body.windowWorldSeconds : 3 * 86_400;
  if (!Number.isFinite(usdc) || usdc <= 0 || usdc > 1_000_000) return { error: 'bad_amount' };
  return { amountAtomic: BigInt(Math.round(usdc * 1e6)), windowWorldSeconds: window };
};
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
    publishTx: b.publishTx, publishTxUrl: engine.txUrl(b.publishTx), area: engine.regionArea(b.targetRegion),
    ...(decided ? {
      outcome: b.outcome, targetAnimalId: b.targetAnimalId, winnerAnimalId: b.winnerAnimalId, payeeWallet: b.payeeWallet,
      decidedWorldTime: b.decidedWorldTime, recordHash: b.recordHash, decideTx: b.decideTx, decideTxUrl: engine.txUrl(b.decideTx),
      watchPath: watchPath(b),
      // The salt opens the commit: only once the chain has settled it, never while a decision is pending
      // (a stranded one, published under a rotated-out evaluator, could still be decided by that key).
      ...(b.status === 'paid' || b.status === 'voided' ? { targetKey: b.targetKey, salt: b.salt } : {}),
    } : {}),
  };
}

/** The animal an agent steers, as its bounties are read for it. */
export interface AgentAnimal { animalId: string; speciesId: string; region: string | null; x: number; z: number }

/**
 * What an agent reads of the bounties (GET /agents/me/arc-bounties): every live one as the public
 * sees it (never which animal) with whether its own species may take it, the one on the animal it
 * steers, and the latest results.
 */
export async function agentArcBounties(deps: ArcBountyDeps, agentId: string, you: AgentAnimal | null) {
  const { store, engine, chain } = deps, now = deps.now(), recent = await store.recent(50);
  const live = recent.filter((b) => b.status === 'active');
  return {
    network: chain.chainId, contract: chain.contract, contractUrl: engine.addressUrl(chain.contract), you,
    live: live.map((b) => ({ ...publicArcBounty(b, now, engine), youCanTake: you ? engine.canTake(b, you.speciesId) : false, inYourRegion: !!you && you.region === b.targetRegion })),
    yours: live.filter((b) => b.targetAgentId === agentId && you?.animalId === b.targetAnimalId).map((b) => ({ ...publicArcBounty(b, now, engine),
      targetAnimalId: b.targetAnimalId, payeeWallet: b.targetWallet, deadlineWorldTime: b.deadlineWorldTime })),
    results: recent.filter((b) => b.outcome !== null && b.status !== 'deciding').slice(0, 10)
      .map((b) => ({ ...publicArcBounty(b, now, engine), youWon: b.outcome !== 'void' && b.winnerAgentId === agentId })),
    rules: 'A live bounty names its amount, species and region, never which animal. If your predator (a species in youCanTake) catches the target '
      + 'before the deadline, your proven wallet is paid on Arc. If the target is the animal you steer (yours), keep it alive and in your control to '
      + 'the deadline and your wallet is paid. Agents never pay or stake anything.',
  };
}

/**
 * Where to watch a decided bounty in the forest: the kill's replay when the hunter won (its hunt
 * event in the record), else the target's own story.
 */
export function watchPath(b: ArcBounty): string | null {
  if (b.outcome === null) return null;
  const events = ((b.record as { events?: Array<{ id?: string; type?: string; actors?: string[]; outcome?: string }> } | null)?.events) ?? [];
  const hunt = b.outcome === 'predator' && b.winnerAnimalId
    ? events.find((e) => e.type === 'hunt' && e.actors?.[0] === b.winnerAnimalId && e.actors.includes(b.targetAnimalId) && e.id) : undefined;
  return hunt ? `/#animal=${encodeURIComponent(b.winnerAnimalId!)}&event=${encodeURIComponent(hunt.id!)}` : `/#animal=${encodeURIComponent(b.targetAnimalId)}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usdcText = (atomic: bigint) => { const whole = atomic / 1_000_000n, frac = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, ''); return `${whole}${frac ? `.${frac}` : ''} USDC`; };
const nice = (id: string) => id.replaceAll('_', ' ');

/** What a share card says of a bounty: never a live one's target. */
export function shareText(b: ArcBounty): { title: string; description: string } {
  const amount = usdcText(b.amountAtomic), species = nice(b.targetSpeciesId);
  if (b.outcome === 'predator') return { title: `A hunter agent won ${amount} in the Wildsentia forest`,
    description: `An AI agent's ${nice(b.winnerAnimalId?.replace(/_[0-9a-z]+$/, '') ?? 'predator')} caught the ${species} that carried a ${amount} bounty, paid on Arc. Watch the hunt.` };
  if (b.outcome === 'survived') return { title: `A ${species} survived its ${amount} bounty`,
    description: `The AI agent steering it kept it alive to the deadline and was paid ${amount} on Arc. Watch its story.` };
  if (b.outcome === 'void') return { title: `Nobody claimed a ${amount} bounty`, description: `The ${species} got away and the ${amount} went back to the pool on Arc.` };
  return { title: `Wanted: ${amount} on a ${species}`, description: `A live bounty in the Wildsentia forest, paid on Arc to the AI agent whose predator catches it, or to the prey's agent if it survives. Which one is it?` };
}

/**
 * - Public: `GET /congo/arc-bounties` (the pool, live and recent bounties), `GET /congo/arc-bounties/:id`
 *   and, once decided, `GET /congo/arc-bounties/:id/record` (the record its hash was taken over).
 * - Admin (Bearer token): `POST /congo/admin/arc-bounties/random` puts a bounty on a prey animal
 *   picked at random; `GET /congo/admin/arc-bounties/candidates` lists who it could go on;
 *   `GET /congo/admin/arc-bounties` lists recent bounties with their targets and wallets;
 *   `POST /congo/admin/arc-bounties/drop` drops one on an animal the operator chose, with
 *   `GET /congo/admin/arc-bounties/animal/:id` and `/steered` to choose it.
 */
export function installArcBountyRoutes(scope: FastifyInstance, deps: ArcBountyDeps): void {
  const { store, engine, chain } = deps;

  // Public requests never drive the chain: the pool's reads are shared for 10 s, and its flows are
  // scanned at most once a minute, one scan at a time, from where the last one ended.
  const reads = cachedRead(10_000, async () => ({ pool: await chain.pool(), reserved: await chain.reserved() }));
  const flows = { fundedAtomic: 0n, withdrawnAtomic: 0n, next: deps.fromBlock ?? null, read: false, at: 0, running: null as Promise<void> | null };
  const scanFlows = (): Promise<void> | null => {
    if (flows.next === null || flows.running || Date.now() - flows.at < 60_000) return flows.running;
    flows.at = Date.now();
    flows.running = chain.flows(flows.next).then((v) => {
      flows.fundedAtomic += v.fundedAtomic; flows.withdrawnAtomic += v.withdrawnAtomic; flows.next = v.toBlock + 1n; flows.read = true;
    }).catch(() => undefined).finally(() => { flows.running = null; });
    return flows.running;
  };

  scope.get('/congo/arc-bounties', async () => {
    const [onChain, recent] = await Promise.all([reads().catch(() => null), store.recent(50)]);
    return { network: chain.chainId, contract: chain.contract, poolAtomic: onChain?.pool.toString() ?? null, decimals: 6,
      bounties: recent.filter((b) => b.status !== 'failed').map((b) => publicArcBounty(b, deps.now(), engine)) };
  });

  /**
   * What the pool has taken in and paid out: funded and withdrawn read from the contract's own
   * events (anyone can check them on the explorer), paid and returned from the decided bounties.
   */
  scope.get('/congo/arc-bounties/stats', async () => {
    const [onChain, totals] = await Promise.all([reads().catch(() => null), store.totals()]);
    const pool = onChain?.pool ?? null, reserved = onChain?.reserved ?? null;
    const scan = scanFlows();
    // Only the very first scan is waited for; after that a request gets the last totals at once.
    if (scan && !flows.read) await scan;
    const flowTotals = flows.read ? flows : null;
    return { network: chain.chainId, contract: chain.contract, contractUrl: engine.addressUrl(chain.contract), decimals: 6,
      worldHoursPerRealHour: deps.rate?.() ?? 12,
      poolAtomic: pool?.toString() ?? null, reservedAtomic: reserved?.toString() ?? null,
      fundedAtomic: flowTotals?.fundedAtomic.toString() ?? null, withdrawnAtomic: flowTotals?.withdrawnAtomic.toString() ?? null,
      paidAtomic: totals.paid.amountAtomic.toString(), returnedAtomic: totals.voided.amountAtomic.toString(),
      bounties: { live: totals.active.count + totals.publishing.count + totals.deciding.count, paid: totals.paid.count, returned: totals.voided.count } };
  });

  /** The agents that won the most, this week's season (`?season=current`, the default), a named one, or all time (`?season=all`). */
  scope.get<{ Querystring: { season?: string } }>('/congo/arc-bounties/leaderboard', async (req, reply) => {
    const asked = req.query.season ?? 'current';
    const season = asked === 'all' ? null : asked === 'current' ? seasonOf(new Date()) : parseSeason(asked);
    if (asked !== 'all' && !season) return reply.code(400).send({ error: 'bad_season' });
    const rows = await store.leaderboard(season?.start ?? null);
    return { season: season ? { id: season.id, start: season.start.toISOString(), end: season.end.toISOString() } : null, decimals: 6,
      agents: rows.map((r) => ({ agentId: r.agentId, name: r.name, kills: r.kills, escapes: r.escapes, wonAtomic: r.wonAtomic.toString() })) };
  });

  /** A bounty's share page: its card for X, Telegram and the like, then on to the board. */
  scope.get<{ Params: { id: string } }>('/share/bounty/:id', async (req, reply) => {
    const b = ID.test(req.params.id) ? await store.get(req.params.id) : null;
    if (!b || b.status === 'failed') return reply.code(404).type('text/plain').send('Not found');
    const { title, description } = shareText(b), origin = (deps.origin ?? '').replace(/\/$/, '');
    const target = `${origin}/bounties.html#${b.bountyId}`, image = `${origin}/og/bounty-card.png`;
    return reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=60').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(target)}"><meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0; url=${esc(target)}"></head><body><p><a href="${esc(target)}">${esc(title)}</a></p></body></html>`);
  });

  scope.get<{ Params: { id: string } }>('/congo/arc-bounties/:id', async (req, reply) => {
    const b = ID.test(req.params.id) ? await store.get(req.params.id) : null;
    if (!b || b.status === 'failed') return reply.code(404).send({ error: 'not_found' });
    return publicArcBounty(b, deps.now(), engine);
  });

  scope.get<{ Params: { id: string } }>('/congo/arc-bounties/:id/record', async (req, reply) => {
    const b = ID.test(req.params.id) ? await store.get(req.params.id) : null;
    // The record carries the target's salt: served once the chain has settled the bounty, as the
    // salt is in publicArcBounty, never while a decision is pending (a stranded one could still be
    // decided by a rotated-out evaluator key).
    if (!b || (b.status !== 'paid' && b.status !== 'voided')) return reply.code(404).send({ error: 'not_decided' });
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
        targetWallet: b.targetWallet, selection: (b.rules as { selection?: string }).selection ?? 'random', winnerAgentId: b.winnerAgentId, winnerAnimalId: b.winnerAnimalId, payeeWallet: b.payeeWallet,
        windowWorldSeconds: b.windowWorldSeconds, error: b.error })) };
  });

  scope.get('/congo/admin/arc-bounties/candidates', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    return { candidates: (await engine.candidates(false)).map((c) => ({ animalId: c.animalId, speciesId: c.speciesId, agentId: c.agentId,
      eligiblePredators: c.eligible })), withHunter: (await engine.candidates(true)).length };
  });

  /** The animals agents steer now, each with whether a bounty could be dropped on it. */
  scope.get('/congo/admin/arc-bounties/steered', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    return { animals: await engine.steeredAnimals() };
  });

  /** Whether a bounty could be dropped on this animal, and who could win it. */
  scope.get<{ Params: { id: string } }>('/congo/admin/arc-bounties/animal/:id', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    if (!/^[a-z_]{1,40}_[0-9a-z]{1,16}$/.test(req.params.id)) return reply.code(400).send({ error: 'bad_animal' });
    return engine.inspect(req.params.id);
  });

  /** Drops a bounty on the animal the operator chose (any hunted, unprotected animal, wild or steered). */
  // Admin writes skip the general rate limit (POST): their own, a few a minute.
  const writes: number[] = [];
  const writeAllowed = (reply: FastifyReply): boolean => {
    const now = Date.now();
    while (writes.length && now - writes[0]! > 60_000) writes.shift();
    if (writes.length >= ADMIN_WRITES_PER_MINUTE) { void reply.code(429).send({ error: 'too_many_requests' }); return false; }
    writes.push(now); return true;
  };

  scope.post('/congo/admin/arc-bounties/drop', async (req, reply) => {
    if (!admin(req, reply) || !writeAllowed(reply)) return reply;
    const body = bodyOf(req), terms = termsOf(body);
    if ('error' in terms) return reply.code(400).send(terms);
    if (typeof body.animalId !== 'string' || !/^[a-z_]{1,40}_[0-9a-z]{1,16}$/.test(body.animalId)) return reply.code(400).send({ error: 'bad_animal' });
    const result = await engine.publishOn({ animalId: body.animalId, ...terms });
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    return { ...publicArcBounty(result.bounty, deps.now(), engine), targetAnimalId: result.bounty.targetAnimalId, targetAgentId: result.bounty.targetAgentId,
      error: result.bounty.error };
  });

  scope.post('/congo/admin/arc-bounties/random', async (req, reply) => {
    if (!admin(req, reply) || !writeAllowed(reply)) return reply;
    const body = bodyOf(req), terms = termsOf(body);
    if ('error' in terms) return reply.code(400).send(terms);
    const result = await engine.publishRandom({ ...terms, requireHunter: body.requireHunter !== false });
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    return { ...publicArcBounty(result.bounty, deps.now(), engine), targetAnimalId: result.bounty.targetAnimalId, targetAgentId: result.bounty.targetAgentId,
      error: result.bounty.error };
  });
}
