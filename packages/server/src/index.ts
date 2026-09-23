import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { SimHost } from './simHost.js';
import { buildApi } from './api.js';
import { Narrator } from './narration/narrator.js';
import { claudeRephraser } from './narration/claude.js';
import { Gateway } from './gateway.js';

export async function startServer(): Promise<{ close(): Promise<void> }> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const port = Number(process.env.PORT ?? 8080);
  const seed = Number(process.env.WORLD_SEED ?? 1);
  const speciesDir =
    process.env.SPECIES_DIR ?? fileURLToPath(new URL('../../../config/species', import.meta.url));

  const pool = createPool(databaseUrl);
  await migrate(pool);

  // Live default is 24x real time (spec D4). Raising it is for demos and load tests only.
  const worldHoursPerRealHour = Number(process.env.WORLD_HOURS_PER_REAL_HOUR ?? 24);

  const host = new SimHost({ pool, seed, speciesDir, worldHoursPerRealHour });
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

  const api = buildApi({ host, pool, narrator });
  await api.ready();

  const server = createServer((req, res) => { api.server.emit('request', req, res); });
  const gateway = new Gateway(host);
  gateway.attach(server);

  host.start();
  const broadcastTimer = setInterval(() => gateway.broadcast(), 1000);

  await new Promise<void>((resolve) => { server.listen(port, resolve); });
  console.log(`vana listening on :${port}`);

  const close = async (): Promise<void> => {
    clearInterval(broadcastTimer);
    gateway.close();
    await host.stop();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    await api.close();
    await pool.end();
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void close().then(() => process.exit(0)); });
  }

  return { close };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void startServer();
}
