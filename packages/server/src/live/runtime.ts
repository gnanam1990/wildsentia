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
  const store = new AgentStore(pool);
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
      lives: new LifeService(ownership, host, config, () => host.snapshotNow()),
      control: new ControlService(ownership, live, { assetOf: (id) => host.world.animal(id)?.assetId,
        block: (id) => host.world.possessionBlock(id, { owner: true, ignoreController: true }), exclusive: (work) => host.exclusive(work) }) };
  })() : null;
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
    live, world: port, store, ledger, ...(holding ? { holding } : {}), ...(owned ? { owned } : {}),
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
          // On Congo only owned animals are steered, and only by their lease's holder.
          if (owned && (!isOwned || leased.get(saved.animalId) !== saved.agentId)) continue;
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
