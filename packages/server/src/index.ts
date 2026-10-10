import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPool } from './db/pool.js';
import { SimHost } from './simHost.js';
import { buildApi, trustedProxyHops } from './api.js';
import { Narrator } from './narration/narrator.js';
import { claudeRephraser } from './narration/claude.js';
import { Insights } from './insights/insights.js';
import { liveRuntime, type LiveRuntime } from './live/runtime.js';
import { accountsConfig } from './accounts/config.js';
import { accountsRuntime } from './accounts/runtime.js';
import { challengesConfig, challengesRuntime, type ChallengesRuntime } from './challenges/runtime.js';
import { typesafeConfig, typesafeDailyCalls, typesafeSystemOne } from './insights/typesafe.js';
import { Gateway } from './gateway.js';
import { rewardConfig } from './rewards.js';
import { socialConfig } from './socialOutbox.js';
import { holderConfig } from './holder.js';
import { generalLimits } from './limits.js';
import { newHttpStats, renderMetrics, serveMetrics } from './metrics.js';

export async function startServer(): Promise<{ close(): Promise<void> }> {
  const databaseUrl = process.env.DATABASE_URL;
  const rewards = rewardConfig(process.env);
  const social = socialConfig(process.env);
  const holder = holderConfig(process.env);
  trustedProxyHops(process.env); // Fail at startup, not at the first request.
  const limits = generalLimits(process.env);
  const metricsPort = metricsListen(process.env);
  if (metricsPort && metricsPort.port === Number(process.env.PORT ?? 8080)) throw new Error('VANA_METRICS_PORT must differ from PORT');
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const port = Number(process.env.PORT ?? 8080);
  const seed = Number(process.env.WORLD_SEED ?? 1);
  const speciesDir =
    process.env.SPECIES_DIR ?? fileURLToPath(new URL('../../../config/species', import.meta.url));
  const terrainProfile = process.env.VANA_TERRAIN_PROFILE ?? 'mainland';
  if (terrainProfile !== 'mainland' && terrainProfile !== 'island_v1' && terrainProfile !== 'island_v2') throw new Error('invalid VANA_TERRAIN_PROFILE');
  const communityProfile = process.env.VANA_COMMUNITY_PROFILE ?? 'none';
  if (communityProfile !== 'none' && communityProfile !== 'household_v1') throw new Error('invalid VANA_COMMUNITY_PROFILE');

  const pool = createPool(databaseUrl);

  // Live default is 12x real time: one world hour every five real minutes. Simulation routes
  // use species speeds in world seconds; client endpoint interpolation is still approximate.
  const worldHoursPerRealHour = Number(process.env.WORLD_HOURS_PER_REAL_HOUR ?? 12);

  const host = new SimHost({ pool, seed, speciesDir, worldHoursPerRealHour, terrainProfile, communityProfile,
    allowV14Upgrade: process.env.VANA_ALLOW_V14_UPGRADE === '1',
    allowV15Upgrade: process.env.VANA_ALLOW_V15_UPGRADE === '1',
    allowV16Upgrade: process.env.VANA_ALLOW_V16_UPGRADE === '1',
    allowV17Upgrade: process.env.VANA_ALLOW_V17_UPGRADE === '1',
    allowV18Upgrade: process.env.VANA_ALLOW_V18_UPGRADE === '1',
    allowV19Upgrade: process.env.VANA_ALLOW_V19_UPGRADE === '1',
    allowV20Upgrade: process.env.VANA_ALLOW_V20_UPGRADE === '1',
    allowV21Upgrade: process.env.VANA_ALLOW_V21_UPGRADE === '1',
    allowV22Upgrade: process.env.VANA_ALLOW_V22_UPGRADE === '1',
    allowV23Upgrade: process.env.VANA_ALLOW_V23_UPGRADE === '1',
    allowV24Upgrade: process.env.VANA_ALLOW_V24_UPGRADE === '1',
    allowV25Upgrade: process.env.VANA_ALLOW_V25_UPGRADE === '1',
    allowV26Upgrade: process.env.VANA_ALLOW_V26_UPGRADE === '1',
    allowV27Upgrade: process.env.VANA_ALLOW_V27_UPGRADE === '1',
    allowV28Upgrade: process.env.VANA_ALLOW_V28_UPGRADE === '1',
    allowV29Upgrade: process.env.VANA_ALLOW_V29_UPGRADE === '1',
    allowV30Upgrade: process.env.VANA_ALLOW_V30_UPGRADE === '1',
    allowV31Upgrade: process.env.VANA_ALLOW_V31_UPGRADE === '1',
    allowV32Upgrade: process.env.VANA_ALLOW_V32_UPGRADE === '1',
    allowV33Upgrade: process.env.VANA_ALLOW_V33_UPGRADE === '1',
    allowV34Upgrade: process.env.VANA_ALLOW_V34_UPGRADE === '1',
    allowV35Upgrade: process.env.VANA_ALLOW_V35_UPGRADE === '1',
    allowV36Upgrade: process.env.VANA_ALLOW_V36_UPGRADE === '1',
    allowV5Upgrade: process.env.VANA_ALLOW_V5_UPGRADE === '1',
    allowV6Upgrade: process.env.VANA_ALLOW_V6_UPGRADE === '1',
    allowV7Upgrade: process.env.VANA_ALLOW_V7_UPGRADE === '1',
    allowV8Upgrade: process.env.VANA_ALLOW_V8_UPGRADE === '1',
    allowV9Upgrade: process.env.VANA_ALLOW_V9_UPGRADE === '1',
    allowV10Upgrade: process.env.VANA_ALLOW_V10_UPGRADE === '1',
    allowV11Upgrade: process.env.VANA_ALLOW_V11_UPGRADE === '1',
    allowV12Upgrade: process.env.VANA_ALLOW_V12_UPGRADE === '1',
    allowV13Upgrade: process.env.VANA_ALLOW_V13_UPGRADE === '1' });
  let api: ReturnType<typeof buildApi> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let gateway: Gateway | undefined;
  let metricsServer: ReturnType<typeof serveMetrics> | undefined;
  let broadcastTimer: NodeJS.Timeout | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let live: LiveRuntime | null = null;
  let challenges: ChallengesRuntime | null = null;
  let closing: Promise<void> | undefined;
  const onSignal = (): void => { void close().then(() => process.exit(0), () => process.exit(1)); };
  const cleanup = async (checkpoint: boolean): Promise<void> => {
    if (broadcastTimer) clearInterval(broadcastTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.removeListener(signal, onSignal);
    gateway?.close();
    metricsServer?.close();
    challenges?.stop();
    await live?.stop();
    try {
      if (checkpoint) await host.stop(); else await host.abort();
    } finally {
      await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); });
      try { await api?.close(); } finally { await pool.end(); }
    }
  };
  const close = (): Promise<void> => closing ??= cleanup(true);
  try {
    const boot = await host.boot();
    console.log(
      boot.restoredFrom === null
        ? 'booted a fresh world'
        : `restored world at ${boot.restoredFrom}, rolled back ${boot.rolledBackEvents} events`,
    );

    // Narration is optional (spec §9.2): without credentials, or past the day's budget, every
    // recap line is its template and the world carries on unchanged.
    const rephrase = claudeRephraser();
    const narrator = new Narrator({
      pool, rephrase, dailyTokenBudget: Number(process.env.NARRATION_DAILY_TOKENS ?? 200_000),
    });
    console.log(rephrase === null ? 'narration: templates only (no API key)' : 'narration: model rephrasing on');

    // Observer insights (TypeSafe AI) are optional too: without a key they are simply absent.
    const typesafe = typesafeConfig(process.env);
    const insights = new Insights(typesafe ? typesafeSystemOne(typesafe) : null, typesafeDailyCalls(process.env));
    console.log(typesafe === null ? 'insights: off (no TypeSafe key)' : `insights: TypeSafe ${typesafe.model} on`);

    // Outside agents steering animals: off unless VANA_LIVE_AGENTS=1.
    live = liveRuntime(host, pool, rewards, process.env);
    // Wildsentia Challenges: off unless VANA_CHALLENGES=1 (which needs live agents).
    const challengeSettings = challengesConfig(process.env);
    const species = () => [...host.world.species.values()];
    if (challengeSettings && live) challenges = challengesRuntime(challengeSettings, { pool, live: live.routes.live, world: live.routes.world,
      species });
    // People's accounts (X sign-in): off unless VANA_X_* are set; they play through the live layer.
    const accountSettings = accountsConfig(process.env);
    if (accountSettings && !live) throw new Error('VANA_X_* (accounts) needs VANA_LIVE_AGENTS=1');
    const accounts = accountSettings && live
      ? accountsRuntime(accountSettings, { pool, agents: live.routes.store, chainId: challengeSettings?.chainId }) : null;
    if (accountSettings) console.log(`accounts: X sign-in on (${accountSettings.origin})`);

    const httpStats = newHttpStats();
    api = buildApi({ host, pool, narrator, insights, rewards, social, holder, trustedProxyHops: trustedProxyHops(process.env), limits, httpStats,
      ...(live ? { live: { ...live.routes, spot: live.spot, species, ...(challenges ? { challenges: challenges.agent } : {}),
        ...(accounts ? { humans: accounts.humans } : {}) } } : {}),
      ...(challenges ? { challenges: { ...challenges.routes, ...(accounts ? { creators: accounts.creators } : {}) } } : {}),
      ...(accounts ? { accounts: accounts.routes } : {}), ...(challenges ? { challengeSocial: challenges.social } : {}) });
    await api.ready();

    server = createServer((req, res) => { api!.server.emit('request', req, res); });
    gateway = new Gateway(host, { maxConnections: limits.liveMaxConnections, maxPerNetwork: limits.liveMaxPerNetwork,
      trustedProxyHops: trustedProxyHops(process.env) });

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, () => { server!.removeListener('error', reject); resolve(); });
    });
    // Attach only after listen succeeds. ws forwards HTTP 'error' events; attaching before
    // listen can swallow the rejection path via an unhandled WebSocketServer error.
    gateway.attach(server);
    host.start();
    broadcastTimer = setInterval(() => gateway!.broadcast(), 1000);
    await live?.start({ live: (state, at) => gateway!.broadcastLive(state as never, at), roster: (state) => gateway!.broadcastRoster(state as never) });
    await challenges?.start();
    // Docker restart policies react to process exit, not an unhealthy healthcheck. A lost
    // writer or three consecutive failed scheduled ticks must exit so one writer can recover
    // from the last durable checkpoint. A single transient failure gets the next tick to retry.
    watchdogTimer = setInterval(() => {
      if (host.isWriterActive && host.consecutiveTickFailures < 3 && host.hasFreshCheckpoint) return;
      console.error(`vana watchdog: writer=${host.isWriterActive} failedTicks=${host.consecutiveTickFailures} fresh=${host.hasFreshCheckpoint}; restarting`);
      // A wedged database operation can keep the serial close queue pending forever. The
      // last committed checkpoint is recoverable, so bound graceful shutdown before exit.
      const forceExit = setTimeout(() => process.exit(1), 30_000);
      forceExit.unref();
      void close().then(() => process.exit(1), () => process.exit(1));
    }, 60_000);
    console.log(`vana listening on :${port}`);
    if (metricsPort) {
      // Operator metrics on their own internal port; never published and never behind Caddy.
      const runtime = live;
      metricsServer = serveMetrics(() => renderMetrics({ host, gateway, pool, http: httpStats,
        live: runtime ? { avatars: () => runtime.routes.live.avatars.size, registered: () => runtime.routes.store.count(), tickLag: runtime.tickLag } : undefined }));
      metricsServer.on('error', (e) => console.error('[metrics] listener failed', e));
      metricsServer.listen(metricsPort.port, metricsPort.host);
      console.log(`metrics on ${metricsPort.host}:${metricsPort.port}/metrics`);
    }

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, onSignal);
    }

    return { close };
  } catch (error) {
    await cleanup(false);
    throw error;
  }
}

/**
 * VANA_METRICS_PORT (default 9464; 0 turns metrics off) and VANA_METRICS_HOST (default 127.0.0.1:
 * reachable only from inside the container; set 0.0.0.0 for a scraper on the compose network).
 */
export function metricsListen(env: NodeJS.ProcessEnv): { port: number; host: string } | null {
  const raw = env.VANA_METRICS_PORT?.trim() || '9464';
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) > 65535) throw new Error('Invalid VANA_METRICS_PORT');
  if (raw === '0') return null;
  const host = env.VANA_METRICS_HOST?.trim() || '127.0.0.1';
  if (!/^[0-9a-fA-F.:]+$/.test(host)) throw new Error('Invalid VANA_METRICS_HOST');
  return { port: Number(raw), host };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void startServer();
}
