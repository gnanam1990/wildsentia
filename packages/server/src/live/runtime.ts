import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Pool } from '../db/pool.js';
import { holderChain, holderConfig } from '../holder.js';
import type { RewardConfig } from '../rewards.js';
import type { SimHost } from '../simHost.js';
import { LiveLayer, TICK_HZ } from './liveLayer.js';
import { AgentStore, PlaceDropLedger } from './liveStore.js';
import type { HoldingGate, LiveRouteDeps } from './routes.js';
import { randomLandSpot, worldPort } from './worldPort.js';
import { WindowMax } from '../metrics.js';
import { isCongoProfile } from '@vana/shared';
import { OwnershipStore } from '../ownership/store.js';
import { SimulatedPurchaseAdapter, loadOwnershipConfig } from '../ownership/purchase.js';
import { LifeService } from '../ownership/lives.js';
import { ControlService } from '../ownership/control.js';
import type { OwnedDeps } from '../ownership/routes.js';
import { BountyStore } from '../bounties/store.js';
import { BountyEngine, DevSettlementAdapter } from '../bounties/engine.js';
import { BountyDiscovery, targetState } from '../bounties/discovery.js';
import type { BountyDeps } from '../bounties/routes.js';
import { EventStore } from '../db/eventStore.js';
import { ArcBountyStore } from '../arcBounties/store.js';
import { ArcBountyEngine } from '../arcBounties/engine.js';
import { viemBountyChain } from '../arcBounties/chain.js';
import { circleSigner } from '../arcBounties/circle.js';
import type { ArcBountyDeps } from '../arcBounties/routes.js';
import { Notifier, arcBountyAnnouncer, describeNotify, notifyConfig } from '../notify/notify.js';
import type { Hex } from 'viem';

/**
 * Starts and stops the live layer beside the SimHost (docs/2026-09-26-live-agents-design.md).
 * Off unless VANA_LIVE_AGENTS=1. Place drops need the reward ledger to be configured too.
 */
export interface LiveRuntime {
  routes: LiveRouteDeps;
  ledger: PlaceDropLedger | null;
  /** Restores saved possessions and starts the tick, refresh, save and broadcast timers. */
  start(broadcast: { live(state: ReturnType<LiveLayer['publicState']>, at: number): void; roster(state: ReturnType<LiveLayer['publicState']>): void }): Promise<void>;
  stop(): Promise<void>;
  spot(): { x: number; z: number } | null;
  /** How late the 10 Hz tick runs, for /metrics: a loaded server shows it here first. */
  tickLag: WindowMax;
}

/** A positive whole number from the environment; empty (as compose passes an unset one) means the default. */
export function positiveSetting(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < 1) throw new Error(`Invalid ${name}`);
  return Number(raw);
}

/**
 * The optional holding gate: VANA_AGENT_MIN_HOLDING_ATOMIC of the holder token (VANA_HOLDER_*)
 * to register an agent, and still held whenever it takes an animal. Off when unset.
 */
export function holdingGate(env: NodeJS.ProcessEnv): HoldingGate | undefined {
  const raw = env.VANA_AGENT_MIN_HOLDING_ATOMIC?.trim();
  if (!raw) return undefined;
  if (!/^[1-9][0-9]{0,39}$/.test(raw)) throw new Error('Invalid VANA_AGENT_MIN_HOLDING_ATOMIC');
  const holder = holderConfig(env);
  if (!holder) throw new Error('VANA_AGENT_MIN_HOLDING_ATOMIC needs the VANA_HOLDER_* token settings');
  const chain = holderChain(holder);
  return { minAtomic: BigInt(raw), tokenAddress: holder.tokenAddress, chainId: holder.chainId, balance: (wallet) => chain.balance(wallet) };
}

export function liveRuntime(host: SimHost, pool: Pool, rewards: RewardConfig | undefined, env: NodeJS.ProcessEnv): LiveRuntime | null {
  if (env.VANA_LIVE_AGENTS !== '1') return null;
  const store = new AgentStore(pool), agentStore = store;
  // Live changes to the world are checkpointed between hours: a hunt within a minute (so the
  // kill reaches the feed), anything else at most every quarter hour.
  let huntPending = false, changedAt = 0, checkpointedAt = Date.now();
  const inner = worldPort(() => host.world, () => host.worldId, {
    position: (id) => host.playedPosition(id),
    time: () => { const f = host.liveEncounterFrame(); return f ? f.startWorldTime + f.elapsedWorldSeconds : host.world.now(); },
    rate: () => host.worldHoursPerRealHour,
  }, () => host.busy);
  const port: typeof inner = { ...inner,
    resolveHunt: (...args) => { huntPending = true; changedAt = Date.now(); return inner.resolveHunt(...args); },
    act: (...args) => { changedAt = Date.now(); return inner.act(...args); },
    feed: (...args) => { changedAt = Date.now(); return inner.feed(...args); },
  };
  const ledger = rewards ? new PlaceDropLedger(pool, rewards, () => host.worldId, store) : null;
  const live = new LiveLayer(port, ledger);
  // Congo 1C: owned animals, who steers them, their lives and the simulated store.
  const owned: OwnedDeps | null = isCongoProfile(host.world.terrainProfile) ? (() => {
    const config = loadOwnershipConfig(env.VANA_OWNERSHIP_CONFIG ?? fileURLToPath(new URL('../../../../config/ownership-congo.json', import.meta.url)));
    const ownership = new OwnershipStore(pool, host.worldId ?? 'unknown');
    return { store: ownership, config, shop: new SimulatedPurchaseAdapter(ownership, config),
      animalOf: (id: string) => { const a = host.world.animal(id); return a?.alive ? { state: a.state, steered: live.avatars.byAnimal(id) !== undefined } : null; },
      lives: new LifeService(ownership, host, config, () => host.snapshotNow()),
      control: new ControlService(ownership, live, { assetOf: (id) => host.world.animal(id)?.assetId,
        block: (id) => host.world.possessionBlock(id, { owner: true, ignoreController: true }), exclusive: (work) => host.exclusive(work) }) };
  })() : null;
  // Congo 1D: bounties on owned animals, found by perception, settled in the SIMULATED ledger.
  // A bounty's record: the recorded events of its animals between two world times.
  const events = new EventStore(pool, host.world.grid);
  const eventsOf = async (ids: string[], from: number, to: number) => {
    const seen = new Map<string, { id: string; worldTime: number }>();
    for (const id of ids) for (const e of await events.byActorSince(id, from - 1, 500)) if (e.worldTime <= to) seen.set(e.id, e);
    for (const e of host.world.log.all()) if (e.worldTime >= from && e.worldTime <= to && e.actors.some((a) => ids.includes(a))) seen.set(e.id, e);
    return [...seen.values()].sort((a, b) => a.worldTime - b.worldTime || a.id.localeCompare(b.id));
  };
  // The hour being played (what viewers and live hunters see) trails the world's clock by up to an hour.
  const played = () => { const f = host.liveEncounterFrame(); return f ? f.startWorldTime + f.elapsedWorldSeconds : host.world.now(); };
  const bounties: BountyDeps | null = owned ? (() => {
    const store = new BountyStore(pool, host.worldId ?? 'unknown');
    const engine = new BountyEngine(store, owned.store, host, new DevSettlementAdapter(store), () => host.worldHoursPerRealHour, eventsOf, played);
    owned.bountyActive = async (lifeId) => (await store.activeOnLife(lifeId)) !== null;
    owned.lastBounty = (assetId) => store.lastDecidedOnAsset(assetId);
    return { store, engine, discovery: new BountyDiscovery(store, () => host.worldId ?? 'unknown'), adminToken: env.VANA_BOUNTY_ADMIN_TOKEN?.trim() || null,
      now: played };
  })() : null;
  // Congo free play: agents steer wild animals (VANA_CONGO_OPEN_PLAY=1), as on the island.
  const openPlay = !!owned && env.VANA_CONGO_OPEN_PLAY === '1';
  // Congo bounties paid in USDC on Arc (docs/2026-10-19-congo-arc-bounties-design.md).
  const arcBounties: ArcBountyDeps | null = owned && env.VANA_ARC_BOUNTIES === '1' ? (() => {
    const required = (name: string) => { const v = env[name]?.trim(); if (!v) throw new Error(`${name} is required with VANA_ARC_BOUNTIES=1`); return v; };
    const chainId = Number(required('VANA_ARC_BOUNTIES_CHAIN_ID'));
    // Whoever holds the admin token sees every live target: a guessable one is refused.
    const adminToken = env.VANA_ARC_BOUNTIES_ADMIN_TOKEN?.trim() || null;
    if (adminToken && adminToken.length < 32) throw new Error('VANA_ARC_BOUNTIES_ADMIN_TOKEN must be at least 32 characters');
    // The collusion check compares agents' network hashes: a secret that changed with every boot would split them.
    required('VANA_LIVE_SECRET');
    const capUsdc = env.VANA_ARC_BOUNTIES_DAILY_CAP_USDC?.trim();
    if (capUsdc !== undefined && capUsdc !== '' && !/^\d+(\.\d{1,6})?$/.test(capUsdc)) throw new Error('VANA_ARC_BOUNTIES_DAILY_CAP_USDC must be a USDC amount');
    // Arc Testnet only, until mainnet use is approved after the legal review.
    if (chainId !== 5042002 && env.VANA_ARC_BOUNTIES_MAINNET_APPROVED !== 'true') throw new Error('VANA_ARC_BOUNTIES_CHAIN_ID must be Arc Testnet (5042002)');
    // The evaluator's key: a Circle developer-controlled wallet (VANA_ARC_BOUNTIES_SIGNER=circle), so no
    // raw key sits in the environment, or a raw key (docs/2026-10-22-circle-evaluator.md).
    const where = { rpcUrl: required('VANA_ARC_BOUNTIES_RPC_URL'), chainId, contract: required('VANA_ARC_BOUNTIES_CONTRACT') as Hex };
    const signerKind = env.VANA_ARC_BOUNTIES_SIGNER?.trim() || 'key';
    if (signerKind !== 'key' && signerKind !== 'circle') throw new Error('VANA_ARC_BOUNTIES_SIGNER must be key or circle');
    const chain = signerKind === 'circle' ? (() => {
      const apiKey = required('VANA_CIRCLE_API_KEY');
      // Each Circle key works in one environment: a testnet key for Arc Testnet.
      if (chainId === 5042002 && !apiKey.startsWith('TEST_API_KEY:')) throw new Error('VANA_CIRCLE_API_KEY must be a testnet key (TEST_API_KEY:…) for Arc Testnet');
      const fee = env.VANA_CIRCLE_FEE_LEVEL?.trim();
      if (fee && fee !== 'LOW' && fee !== 'MEDIUM' && fee !== 'HIGH') throw new Error('VANA_CIRCLE_FEE_LEVEL must be LOW, MEDIUM or HIGH');
      return viemBountyChain({ ...where, signer: circleSigner({ apiKey, entitySecret: required('VANA_CIRCLE_ENTITY_SECRET'), walletId: required('VANA_CIRCLE_WALLET_ID'),
        walletAddress: required('VANA_CIRCLE_WALLET_ADDRESS'), ...(fee ? { feeLevel: fee as 'LOW' | 'MEDIUM' | 'HIGH' } : {}), ...(env.VANA_CIRCLE_BASE_URL?.trim() ? { baseUrl: env.VANA_CIRCLE_BASE_URL.trim() } : {}) }) });
    })() : viemBountyChain({ ...where, evaluatorKey: required('VANA_ARC_BOUNTIES_EVALUATOR_KEY') as Hex });
    const store = new ArcBountyStore(pool, host.worldId ?? 'unknown');
    // Alerts to Discord and Telegram when a bounty goes live and when it is decided (all optional).
    const alerts = notifyConfig(env);
    if (alerts) console.log(`arc bounty alerts: ${describeNotify(alerts)}`);
    const announce = alerts ? arcBountyAnnouncer(new Notifier(alerts), { origin: alerts.origin, rate: () => host.worldHoursPerRealHour, now: played,
      txUrl: (hash) => engine.txUrl(hash) }) : undefined;
    const engine: ArcBountyEngine = new ArcBountyEngine(store, chain, {
      world: () => host.world, played, rate: () => host.worldHoursPerRealHour,
      steered: () => [...live.avatars.values()].map((a) => ({ agentId: a.agentId, animalId: a.animalId, speciesId: a.speciesId, agentName: a.agentName })),
      steererOf: (id) => live.avatars.byAnimal(id)?.agentId ?? null,
      wallet: async (agentId) => { const a = await agentStore.byId(agentId); return a?.wallet && a.walletProven ? a.wallet : null; },
      network: (agentId) => agentStore.networkOf(agentId),
      // Testnet only: refused with a mainnet chain.
      sameNetworkOk: env.VANA_ARC_BOUNTIES_SAME_NETWORK_OK === '1' && chainId === 5042002,
      notify: (agentId, text) => live.notify(agentId, text), eventsOf,
      explorer: env.VANA_ARC_BOUNTIES_EXPLORER_URL?.trim() || null, ...(announce ? { announce } : {}),
      // Default: at most 10 USDC of bounties a day; "0" turns the cap off.
      dailyCapAtomic: capUsdc === '0' ? null : BigInt(Math.round(Number(capUsdc || '10') * 1e6)),
    });
    // Before anything is sent: is this key the contract's evaluator, and does USDC count 6 decimals?
    void engine.checkIdentity().then((id) => console.log(`arc bounties: ${id.ok ? `evaluator ${chain.evaluator} confirmed` : `publishing refused (${id.reason})`}`));
    const fromBlock = env.VANA_ARC_BOUNTIES_FROM_BLOCK?.trim();
    return { store, engine, chain, adminToken, now: played,
      // The public board reads the pool's flows from the contract's events since its deployment block.
      fromBlock: fromBlock && /^\d+$/.test(fromBlock) ? BigInt(fromBlock) : null, origin: env.VANA_PUBLIC_ORIGIN?.trim() || null,
      rate: () => host.worldHoursPerRealHour };
  })() : null;
  live.onHunt = (hunt) => {
    if (bounties && hunt.killed) void bounties.engine.adjudicate().catch((e) => console.error('[bounty] adjudicate failed', e));
    if (arcBounties && hunt.killed) void arcBounties.engine.onHunt(hunt).catch((e) => console.error('[arc-bounty] kill failed', e));
  };
  live.onEnded = (life) => {
    void store.recordLife(life).catch((e) => console.error('[live] life record failed', e));
    if (owned) {
      void owned.control.ended(life).catch((e) => console.error('[owned] lease end failed', e));
      if (life.how === 'died' || life.how === 'caught') void owned.lives.reconcile().catch((e) => console.error('[owned] reconcile failed', e));
    }
  };
  const timers: NodeJS.Timeout[] = [];
  const tickLag = new WindowMax();
  const save = async () => { const id = host.worldId; if (id) await store.savePossessions(id, live.avatars.values()); };
  const holding = holdingGate(env);
  const routes: LiveRouteDeps = {
    live, world: port, store, ledger, ...(holding ? { holding } : {}), ...(owned ? { owned } : {}), ...(bounties ? { bounties } : {}),
    ...(arcBounties ? { arcBounties } : {}), ...(openPlay ? { openPlay } : {}),
    limits: { slots: positiveSetting(env, 'VANA_AGENT_SLOTS', 500), perNetworkPerDay: positiveSetting(env, 'VANA_AGENT_REGISTRATIONS_PER_NETWORK', 5) },
    networkSecret: env.VANA_LIVE_SECRET?.trim() || rewards?.adminToken || randomBytes(32).toString('hex'),
    clientScriptPath: fileURLToPath(new URL('../../agent-client/client.mjs', import.meta.url)),
  };
  return {
    routes, ledger, tickLag,
    spot: () => randomLandSpot(host.world),
    async start(broadcast) {
      const id = host.worldId;
      const restored = new Set<string>();
      // Between steps, never inside one: the host may already be stepping when the live layer starts.
      // An owned animal's life is settled first (the world may have rolled back past a death or a
      // spawn), and its possession comes back only for the holder of its open lease.
      const leases = owned ? await (async () => { await owned.lives.reconcile(); return owned.store.openLeases(); })() : [];
      const leased = new Map(leases.map((l) => [l.animalId, l.holderId]));
      await host.exclusive(async () => {
        if (id) for (const saved of await store.loadPossessions(id)) {
          const isOwned = host.world.animal(saved.animalId)?.assetId !== undefined;
          // On Congo only owned animals are steered, and only by their lease's holder (unless play is free).
          if (owned && !openPlay && (!isOwned || leased.get(saved.animalId) !== saved.agentId)) continue;
          if (live.restore(saved, isOwned)) restored.add(saved.animalId);
        }
        // An animal still marked as steered, with no saved possession, goes back to the wild.
        for (const animal of host.world.agents) if (animal.controller && !restored.has(animal.id)) host.world.release(animal.id);
      });
      // A lease whose possession did not come back (saved every 10 s) ends: no holder without control.
      if (owned) for (const lease of leases) if (!restored.has(lease.animalId)) await owned.store.endLeaseOf(lease.lifeId, lease.holderId, 'restart');
      await ledger?.refresh().catch((e) => console.error('[live] drop refresh failed', e));
      let last = performance.now(), held = false;
      timers.push(setInterval(() => {
        const now = performance.now();
        // While the world steps nothing may move it: the tick holds, and the next one catches up.
        // The held time is the step's, not event-loop lag, so it is not recorded as lag.
        if (host.busy) { held = true; return; }
        if (!held) tickLag.record(Math.max(0, (now - last) / 1000 - 1 / TICK_HZ));
        held = false;
        try { live.tick((now - last) / 1000); } catch (e) { console.error('[live] tick failed', e); }
        last = now;
      }, 1000 / TICK_HZ));
      timers.push(setInterval(() => { void ledger?.refresh().catch((e) => console.error('[live] drop refresh failed', e)); }, 3000));
      timers.push(setInterval(() => { void save().catch((e) => console.error('[live] save failed', e)); }, 10_000));
      timers.push(setInterval(() => {
        const now = Date.now();
        const due = huntPending ? now - checkpointedAt > 60_000 : changedAt > checkpointedAt && now - checkpointedAt > 15 * 60_000;
        if (!due || !host.isWriterActive) return;
        huntPending = false; checkpointedAt = now;
        void host.snapshotNow().catch((e) => console.error('[live] checkpoint failed', e));
      }, 10_000));
      timers.push(setInterval(() => { void store.reapInactive().catch(() => undefined); }, 6 * 3_600_000));
      // Owned lives follow their animals: deaths in the hourly step end their lives within seconds.
      if (owned) timers.push(setInterval(() => { void owned.lives.reconcile().catch((e) => console.error('[owned] reconcile failed', e)); }, 10_000));
      if (bounties) {
        // A payout decided before a stop is recorded now; then deaths and deadlines are checked every 10 s.
        await bounties.engine.settlePending().catch((e) => console.error('[bounty] settle failed', e));
        await bounties.discovery.refresh(bounties.now()).catch(() => undefined);
        timers.push(setInterval(() => { void bounties.engine.adjudicate().catch((e) => console.error('[bounty] adjudicate failed', e)); }, 10_000));
        // Every two seconds: the active bounties, and where each target is and what it is doing, for
        // the track log its clues come from.
        const doing = (id: string) => {
          const animal = host.world.animal(id);
          const at = live.positionOf(id) ?? animal?.position;
          if (!animal || !at) return null;
          return { x: at.x, z: at.z, state: targetState(animal, live.wild.get(id), live.avatars.byAnimal(id)) };
        };
        timers.push(setInterval(() => {
          void bounties.discovery.refresh(bounties.now()).then(() => bounties.discovery.sample(doing, bounties.now())).catch(() => undefined);
        }, 2000));
      }
      if (arcBounties) {
        // What a stop left unconfirmed is checked against the chain; then deaths and deadlines every 10 s.
        await arcBounties.engine.processPending().catch((e) => console.error('[arc-bounty] pending failed', e));
        timers.push(setInterval(() => { void arcBounties.engine.adjudicate().catch((e) => console.error('[arc-bounty] adjudicate failed', e)); }, 10_000));
        timers.push(setInterval(() => { void arcBounties.engine.processPending().catch((e) => console.error('[arc-bounty] pending failed', e)); }, 30_000));
        console.log(`arc bounties: on (contract ${arcBounties.chain.contract}, evaluator ${arcBounties.chain.evaluator}, chain ${arcBounties.chain.chainId})`);
      }
      // Four times a second, filtered per viewer by the gateway; the roster every two seconds.
      timers.push(setInterval(() => broadcast.live(live.publicState(), Date.now()), 250));
      let wasEmpty = true;
      timers.push(setInterval(() => {
        const empty = live.avatars.size === 0;
        if (empty && wasEmpty) return;
        wasEmpty = empty;
        broadcast.roster(live.publicState());
      }, 2000));
      console.log(`live agents: on (${routes.limits.slots} slots, drops ${ledger ? 'on' : 'off: rewards not configured'}, holding gate ${holding ? 'on' : 'off'})`);
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      await save().catch((e) => console.error('[live] final save failed', e));
    },
  };
}
