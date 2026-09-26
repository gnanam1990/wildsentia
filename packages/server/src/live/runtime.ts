import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Pool } from '../db/pool.js';
import type { RewardConfig } from '../rewards.js';
import type { SimHost } from '../simHost.js';
import { LiveLayer, TICK_HZ } from './liveLayer.js';
import { AgentStore, PlaceDropLedger } from './liveStore.js';
import type { LiveRouteDeps } from './routes.js';
import { randomLandSpot, worldPort } from './worldPort.js';

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
}

/** A positive whole number from the environment; empty (as compose passes an unset one) means the default. */
export function positiveSetting(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < 1) throw new Error(`Invalid ${name}`);
  return Number(raw);
}

export function liveRuntime(host: SimHost, pool: Pool, rewards: RewardConfig | undefined, env: NodeJS.ProcessEnv): LiveRuntime | null {
  if (env.VANA_LIVE_AGENTS !== '1') return null;
  const store = new AgentStore(pool);
  const port = worldPort(() => host.world, () => host.worldId, {
    position: (id) => host.playedPosition(id),
    time: () => { const f = host.liveEncounterFrame(); return f ? f.startWorldTime + f.elapsedWorldSeconds : host.world.now(); },
  });
  const ledger = rewards ? new PlaceDropLedger(pool, rewards, () => host.worldId, store) : null;
  const live = new LiveLayer(port, ledger);
  const timers: NodeJS.Timeout[] = [];
  const save = async () => { const id = host.worldId; if (id) await store.savePossessions(id, live.avatars.values()); };
  const routes: LiveRouteDeps = {
    live, world: port, store, ledger,
    limits: { slots: positiveSetting(env, 'VANA_AGENT_SLOTS', 500), perNetworkPerDay: positiveSetting(env, 'VANA_AGENT_REGISTRATIONS_PER_NETWORK', 5) },
    networkSecret: env.VANA_LIVE_SECRET?.trim() || rewards?.adminToken || randomBytes(32).toString('hex'),
    clientScriptPath: fileURLToPath(new URL('../../agent-client/client.mjs', import.meta.url)),
  };
  return {
    routes, ledger,
    spot: () => randomLandSpot(host.world),
    async start(broadcast) {
      const id = host.worldId;
      const restored = new Set<string>();
      if (id) for (const saved of await store.loadPossessions(id)) if (live.restore(saved)) restored.add(saved.animalId);
      // An animal still marked as steered, with no saved possession, goes back to the wild.
      for (const animal of host.world.agents) if (animal.controller && !restored.has(animal.id)) host.world.release(animal.id);
      await ledger?.refresh().catch((e) => console.error('[live] drop refresh failed', e));
      let last = performance.now();
      timers.push(setInterval(() => {
        const now = performance.now();
        try { live.tick((now - last) / 1000); } catch (e) { console.error('[live] tick failed', e); }
        last = now;
      }, 1000 / TICK_HZ));
      timers.push(setInterval(() => { void ledger?.refresh().catch((e) => console.error('[live] drop refresh failed', e)); }, 3000));
      timers.push(setInterval(() => { void save().catch((e) => console.error('[live] save failed', e)); }, 10_000));
      timers.push(setInterval(() => { void store.reapInactive().catch(() => undefined); }, 6 * 3_600_000));
      // Four times a second, filtered per viewer by the gateway; the roster every two seconds.
      timers.push(setInterval(() => broadcast.live(live.publicState(), Date.now()), 250));
      let wasEmpty = true;
      timers.push(setInterval(() => {
        const empty = live.avatars.size === 0;
        if (empty && wasEmpty) return;
        wasEmpty = empty;
        broadcast.roster(live.publicState());
      }, 2000));
      console.log(`live agents: on (${routes.limits.slots} slots, drops ${ledger ? 'on' : 'off: rewards not configured'})`);
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      await save().catch((e) => console.error('[live] final save failed', e));
    },
  };
}
