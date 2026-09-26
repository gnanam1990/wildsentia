import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPool } from './db/pool.js';
import { SimHost } from './simHost.js';
import { buildApi, trustedProxyHops } from './api.js';
import { Narrator } from './narration/narrator.js';
import { claudeRephraser } from './narration/claude.js';
import { Gateway } from './gateway.js';
import { rewardConfig } from './rewards.js';
import { socialConfig } from './socialOutbox.js';
import { holderConfig } from './holder.js';

export async function startServer(): Promise<{ close(): Promise<void> }> {
  const databaseUrl = process.env.DATABASE_URL;
  const rewards = rewardConfig(process.env);
  const social = socialConfig(process.env);
  const holder = holderConfig(process.env);
  trustedProxyHops(process.env); // Fail at startup, not at the first request.
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const port = Number(process.env.PORT ?? 8080);
  const seed = Number(process.env.WORLD_SEED ?? 1);
  const speciesDir =
    process.env.SPECIES_DIR ?? fileURLToPath(new URL('../../../config/species', import.meta.url));
  const terrainProfile = process.env.VANA_TERRAIN_PROFILE ?? 'mainland';
  if (terrainProfile !== 'mainland' && terrainProfile !== 'island_v1') throw new Error('invalid VANA_TERRAIN_PROFILE');
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
  let broadcastTimer: NodeJS.Timeout | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  const onSignal = (): void => { void close().then(() => process.exit(0), () => process.exit(1)); };
  const cleanup = async (checkpoint: boolean): Promise<void> => {
    if (broadcastTimer) clearInterval(broadcastTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.removeListener(signal, onSignal);
    gateway?.close();
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

    api = buildApi({ host, pool, narrator, rewards, social, holder, trustedProxyHops: trustedProxyHops(process.env) });
    await api.ready();

    server = createServer((req, res) => { api!.server.emit('request', req, res); });
    gateway = new Gateway(host);

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, () => { server!.removeListener('error', reject); resolve(); });
    });
    // Attach only after listen succeeds. ws forwards HTTP 'error' events; attaching before
    // listen can swallow the rejection path via an unhandled WebSocketServer error.
    gateway.attach(server);
    host.start();
    broadcastTimer = setInterval(() => gateway!.broadcast(), 1000);
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

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, onSignal);
    }

    return { close };
  } catch (error) {
    await cleanup(false);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void startServer();
}
