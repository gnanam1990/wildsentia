import { getAddress, isAddress, type Hex } from 'viem';
import type { SpeciesConfig } from '@vana/shared';
import type { Pool } from '../db/pool.js';
import { HERD_STRUCTURES } from '../live/fieldGuide.js';
import type { LiveLayer, WorldPort } from '../live/liveLayer.js';
import { viemChallengeChain, type ChallengeChain } from './chain.js';
import { ChainOps } from './chainOps.js';
import { ChallengeEngine } from './engine.js';
import { ChallengeIndexer } from './indexer.js';
import type { ChallengeRouteDeps } from './routes.js';
import { ChallengeSocialStore } from './social.js';
import { ChallengeStore } from './store.js';
import type { SpeciesCatalog } from './terms.js';

/**
 * Wildsentia Challenges beside the live layer. Off unless VANA_CHALLENGES=1, which needs live
 * agents (VANA_LIVE_AGENTS=1) and every VANA_CHALLENGES_* setting below; a partial setup is an error.
 */
export interface ChallengesConfig {
  rpcUrl: string; chainId: number; contract: Hex; usdc: Hex; evaluatorKey: Hex; fromBlock: number; adminToken: string;
  usdcDomain: { name: string; version: string }; explorerUrl: string | null;
  /** The WildsentiaAttempts contract; without it attempts are kept and hashed here but not written on chain. */
  attemptsContract: Hex | null;
  /** The public site (VANA_PUBLIC_ORIGIN), for links in challenge posts; without it posts carry no link. */
  siteUrl: string | null;
  /** The ERC-8004 registries (both or neither): players link identities, and attempts leave feedback (with a site URL). */
  identityRegistry: Hex | null;
  reputationRegistry: Hex | null;
}

const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1';

export function challengesConfig(env: NodeJS.ProcessEnv): ChallengesConfig | undefined {
  if (env.VANA_CHALLENGES !== '1') {
    if (env.VANA_CHALLENGES && env.VANA_CHALLENGES !== '0') throw new Error('Invalid VANA_CHALLENGES');
    return undefined;
  }
  if (env.VANA_LIVE_AGENTS !== '1') throw new Error('VANA_CHALLENGES needs VANA_LIVE_AGENTS=1');
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`VANA_CHALLENGES needs ${name}`);
    return v;
  };
  const rpc = new URL(need('VANA_CHALLENGES_RPC_URL'));
  if (!['https:', 'http:'].includes(rpc.protocol) || (rpc.protocol === 'http:' && !loopback(rpc.hostname)) || rpc.username || rpc.password)
    throw new Error('Invalid VANA_CHALLENGES_RPC_URL');
  const chainId = Number(need('VANA_CHALLENGES_CHAIN_ID'));
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Invalid VANA_CHALLENGES_CHAIN_ID');
  const address = (name: string): Hex => {
    const v = need(name);
    if (!isAddress(v) || /^0x0{40}$/i.test(v)) throw new Error(`Invalid ${name}`);
    return getAddress(v);
  };
  const key = need('VANA_CHALLENGES_EVALUATOR_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Invalid VANA_CHALLENGES_EVALUATOR_KEY');
  const fromBlock = Number(need('VANA_CHALLENGES_FROM_BLOCK'));
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) throw new Error('Invalid VANA_CHALLENGES_FROM_BLOCK');
  const adminToken = need('VANA_CHALLENGES_ADMIN_TOKEN');
  if (adminToken.length < 32 || adminToken.length > 256 || /\s/.test(adminToken)) throw new Error('Invalid VANA_CHALLENGES_ADMIN_TOKEN');
  const attempts = env.VANA_CHALLENGES_ATTEMPTS_CONTRACT?.trim() ? address('VANA_CHALLENGES_ATTEMPTS_CONTRACT') : null;
  const hasIdentity = !!env.VANA_CHALLENGES_IDENTITY_REGISTRY?.trim(), hasReputation = !!env.VANA_CHALLENGES_REPUTATION_REGISTRY?.trim();
  if (hasIdentity !== hasReputation) throw new Error('Set both VANA_CHALLENGES_IDENTITY_REGISTRY and VANA_CHALLENGES_REPUTATION_REGISTRY, or neither');
  const identityRegistry = hasIdentity ? address('VANA_CHALLENGES_IDENTITY_REGISTRY') : null;
  const reputationRegistry = hasReputation ? address('VANA_CHALLENGES_REPUTATION_REGISTRY') : null;
  const site = env.VANA_PUBLIC_ORIGIN?.trim();
  if (hasReputation && !site) throw new Error('The ERC-8004 registries need VANA_PUBLIC_ORIGIN: feedback points at the attempt records on the site');
  let siteUrl: string | null = null;
  if (site) {
    let u: URL;
    try { u = new URL(site); } catch { throw new Error('Invalid VANA_PUBLIC_ORIGIN'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Invalid VANA_PUBLIC_ORIGIN');
    siteUrl = u.origin;
  }
  const explorer = env.VANA_CHALLENGES_EXPLORER_URL?.trim();
  if (explorer && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(explorer)) throw new Error('Invalid VANA_CHALLENGES_EXPLORER_URL');
  return {
    rpcUrl: rpc.href, chainId, contract: address('VANA_CHALLENGES_CONTRACT'), usdc: address('VANA_CHALLENGES_USDC'),
    evaluatorKey: key as Hex, fromBlock, adminToken,
    usdcDomain: { name: need('VANA_CHALLENGES_USDC_DOMAIN_NAME'), version: need('VANA_CHALLENGES_USDC_DOMAIN_VERSION') },
    explorerUrl: explorer ? explorer.replace(/\/$/, '') : null, attemptsContract: attempts, siteUrl, identityRegistry, reputationRegistry,
  };
}

export interface ChallengesRuntime {
  routes: ChallengeRouteDeps;
  /** X post drafts about challenges, for the owner's review on the social admin page. */
  social: ChallengeSocialStore;
  /** ERC-8004 identity owners, for the live routes' identity link; null when the registries are not set. */
  identity: { owner(agentId: bigint): Promise<Hex | null> } | null;
  agent: { accept: ChallengeEngine['accept']; progressOf: ChallengeEngine['progressOf']; waitingOf: ChallengeEngine['waitingOf'];
    leave: ChallengeEngine['leave'] };
  start(): Promise<void>;
  stop(): void;
}

/** A setting that is wrong, not a chain that is unreachable: the server must not start with it. */
class ChallengesConfigError extends Error {}

export function challengesRuntime(config: ChallengesConfig,
  deps: { pool: Pool; live: LiveLayer; world: WorldPort; species: () => readonly SpeciesConfig[]; worldHoursPerRealHour?: number },
  chain: ChallengeChain = viemChallengeChain(config), options: { retryMs?: number } = {}): ChallengesRuntime {
  const store = new ChallengeStore(deps.pool);
  const engine = new ChallengeEngine(store, deps.live, deps.world, Date.now, { recordOnChain: config.attemptsContract !== null,
    ...(deps.worldHoursPerRealHour ? { worldHoursPerRealHour: deps.worldHoursPerRealHour } : {}),
    // Feedback points at the attempt's public record, so it needs the site's address.
    ...(config.reputationRegistry && config.siteUrl ? { feedback: { siteUrl: config.siteUrl } } : {}) });
  const ops = new ChainOps(store, chain);
  const indexer = new ChallengeIndexer(store, chain, config.fromBlock);
  const configOf = (id: string) => deps.species().find((s) => s.id === id);
  const catalog: SpeciesCatalog = { ids: () => deps.species().map((s) => s.id), preyOf: (id) => deps.world.species(id)?.preferredPrey ?? [],
    displayName: (id) => deps.world.species(id)?.displayName ?? id,
    social: (id) => HERD_STRUCTURES.has(configOf(id)?.social.structure ?? 'solitary'),
    onLand: (x, z) => deps.world.patchAt(x, z)?.land === true };
  // Limits come from the contract when it starts; until then nothing can be drafted.
  const drafts = { chainId: config.chainId, contract: config.contract, usdc: config.usdc, usdcDomain: config.usdcDomain,
    minPrizeAtomic: 1n, maxPrizeAtomic: 0n, ...(deps.worldHoursPerRealHour ? { worldHoursPerRealHour: deps.worldHoursPerRealHour } : {}) };
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, what: string, fn: () => Promise<unknown>) => {
    let running = false;
    timers.push(setInterval(() => {
      if (running) return;
      running = true;
      void fn().catch((e) => console.error(`[challenges] ${what} failed`, (e as Error).message)).finally(() => { running = false; });
    }, ms));
  };
  const social = new ChallengeSocialStore(deps.pool, catalog, config.siteUrl ?? null, chain.evaluator);
  let stopped = false;
  const begin = async (): Promise<void> => {
    // Fail closed: the key must be the evaluator the contract appoints, or new prizes could never be paid.
    const appointed = await chain.appointedEvaluator();
    if (appointed.toLowerCase() !== chain.evaluator.toLowerCase())
      throw new ChallengesConfigError(`VANA_CHALLENGES_EVALUATOR_KEY is not the contract's evaluator (${appointed})`);
    // One database serves one contract: ids are the contract's own.
    const others = await store.otherContracts(config.contract);
    if (others.length) throw new ChallengesConfigError(`The database holds challenges of another contract (${others[0]}); use a fresh database`);
    // Challenges recorded under an evaluator that is not ours can never be paid by us: they refund.
    const foreign = await store.unrecogniseOtherEvaluators(config.contract, chain.evaluator);
    if (foreign) console.error(`[challenges] ${foreign} open challenges belong to another evaluator; they will refund`);
    if (config.attemptsContract) {
      const recorder = await chain.attemptsRecorder();
      if (recorder.toLowerCase() !== chain.evaluator.toLowerCase())
        throw new ChallengesConfigError(`VANA_CHALLENGES_EVALUATOR_KEY is not the attempts contract's recorder (${recorder})`);
    }
    const limits = await chain.prizeLimits();
    await engine.restore();
    if (stopped) return;
    drafts.minPrizeAtomic = limits.min; drafts.maxPrizeAtomic = limits.max;
    // Hooks join the live runtime's own (the leaderboard keeps its onEnded).
    const ended = deps.live.onEnded;
    deps.live.onEnded = (life) => { ended?.(life); engine.onEnded(life); };
    deps.live.onHunt = (hunt) => engine.onHunt(hunt);
    deps.live.onCommand = (record) => engine.onCommand(record);
    deps.live.holdFreed = (speciesId, since) => engine.holdsFreed(speciesId, since);
    every(1000, 'tick', () => engine.tick());
    every(5000, 'indexer', () => indexer.pollOnce());
    every(3000, 'chain operations', () => ops.processOnce());
    every(30_000, 'sweep', () => engine.sweep());
    every(5000, 'attempt records', () => engine.recordAttempts());
    every(30_000, 'challenge posts', () => social.sweep());
    console.log(`challenges: on (contract ${config.contract}, chain ${config.chainId}, evaluator ${chain.evaluator}, `
      + `attempts ${config.attemptsContract ?? 'kept off chain'})`);
  };
  return {
    social,
    identity: config.identityRegistry ? { owner: (agentId) => chain.identityOwner(agentId) } : null,
    routes: { store, catalog, drafts, adminToken: config.adminToken, explorerUrl: config.explorerUrl },
    agent: { accept: (player, id) => engine.accept(player, id), progressOf: (agentId) => engine.progressOf(agentId),
      waitingOf: (agentId) => engine.waitingOf(agentId), leave: (agentId) => engine.leave(agentId) },
    async start() {
      // A wrong key or database refuses to start (the operator must see it). An unreachable chain
      // must not take the forest down with it: challenges stay paused and startup is tried again.
      try { await begin(); return; }
      catch (error) { if (error instanceof ChallengesConfigError) throw error; console.error(`[challenges] could not reach the chain at startup (${(error as Error).message}); retrying, challenges stay paused`); }
      let trying = false;
      const retry = setInterval(() => {
        if (trying) return;
        trying = true;
        begin().then(() => clearInterval(retry), (error: Error) => {
          if (error instanceof ChallengesConfigError) clearInterval(retry);
          console.error(`[challenges] ${error instanceof ChallengesConfigError ? 'refused to start' : 'could not reach the chain'}: ${error.message}`);
        }).finally(() => { trying = false; });
      }, options.retryMs ?? 30_000);
      timers.push(retry);
    },
    stop() { stopped = true; for (const t of timers) clearInterval(t); },
  };
}
