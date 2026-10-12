import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { buildApi } from '../src/api.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { WindowMax, newHttpStats, renderMetrics, serveMetrics, type MetricsSources } from '../src/metrics.js';
import type { Pool } from '../src/db/pool.js';
import { testDatabaseUrl } from './testDatabase.js';

/** Workstream D: the operator's /metrics, on its own internal port and never through Caddy. */

const standInHost = { worldId: null, rewardSubject: () => null, observation: () => null, isWriterActive: true,
  lastError: null, hasFreshCheckpoint: true, checkpointTime: 7200 } as unknown as Parameters<typeof buildApi>[0]['host'];
const standInPool = { query: async () => ({ rows: [] }) } as unknown as Pool;

/** Every line is a comment or `name{labels} value`, and every family is described before use. */
function parse(text: string): Map<string, number> {
  const samples = new Map<string, number>(), typed = new Set<string>();
  expect(text.endsWith('\n')).toBe(true);
  for (const line of text.trimEnd().split('\n')) {
    const type = /^# TYPE ([a-z_:][a-z0-9_:]*) (counter|gauge)$/.exec(line);
    if (type) { typed.add(type[1]!); continue; }
    if (/^# HELP [a-z_:][a-z0-9_:]* \S/.test(line)) continue;
    const sample = /^([a-z_:][a-z0-9_:]*)(\{[a-z_]+="(?:[^"\\\n]|\\.)*"(?:,[a-z_]+="(?:[^"\\\n]|\\.)*")*\})? (-?[0-9.e+-]+|NaN)$/.exec(line);
    expect(sample, line).not.toBeNull();
    expect(typed.has(sample![1]!), `${sample![1]} has no TYPE`).toBe(true);
    samples.set(`${sample![1]}${sample![2] ?? ''}`, Number(sample![3]));
  }
  return samples;
}

function sources(over: Partial<MetricsSources> = {}): MetricsSources {
  const lag = new WindowMax(); lag.record(0.042);
  return {
    host: { checkpointTime: 7200, lastCheckpointAt: 1_000_000, worldHoursPerRealHour: 12, isWriterActive: true, worldId: 'w"1\\x',
      consecutiveTickFailures: 0, simVersion: 'sim_9.9.9', clockLagSeconds: () => 0,
      stats: { tickFailures: 2, ticksSkipped: 1, lastTickSeconds: 0.25, maxTickSeconds: 0.5 } },
    gateway: { connectionCount: 3, stats: { accepted: 5, refused: { busy: 1, busy_network: 2, world_unavailable: 0 }, messages: 40,
      bytes: 123_456, slowConsumerTerminations: 1, broadcastSeconds: { scene: lag, live: lag, roster: lag } } },
    pool: { totalCount: 4, idleCount: 3, waitingCount: 1, options: { max: 10 } },
    live: { avatars: () => 6, registered: async () => 9, tickLag: lag },
    http: { responses: { '1xx': 0, '2xx': 10, '3xx': 0, '4xx': 3, '5xx': 1 }, rateLimited: 2 },
    ...over,
  };
}

describe('renderMetrics', () => {
  it('writes valid Prometheus text covering the world, sockets, agents, HTTP and the database pool', async () => {
    const m = parse(await renderMetrics(sources(), 1_030_000));
    expect(m.get('vana_world_time_seconds')).toBe(7200);
    expect(m.get('vana_world_clock_lag_seconds')).toBe(0);
    expect(m.get('vana_world_tick_failures_total')).toBe(2);
    expect(m.get('vana_world_ticks_skipped_total')).toBe(1);
    expect(m.get('vana_world_tick_duration_seconds')).toBe(0.25);
    expect(m.get('vana_checkpoint_age_seconds')).toBe(30);
    expect(m.get('vana_writer_active')).toBe(1);
    expect(m.get('vana_ws_connections')).toBe(3);
    expect(m.get('vana_ws_connections_accepted_total')).toBe(5);
    expect(m.get('vana_ws_connections_refused_total{reason="busy_network"}')).toBe(2);
    expect(m.get('vana_ws_messages_sent_total')).toBe(40);
    expect(m.get('vana_ws_sent_bytes_total')).toBe(123_456);
    expect(m.get('vana_ws_slow_consumer_terminations_total')).toBe(1);
    expect(m.get('vana_ws_broadcast_seconds_max{kind="live"}')).toBe(0.042);
    expect(m.get('vana_live_avatars')).toBe(6);
    expect(m.get('vana_live_agents_registered')).toBe(9);
    expect(m.get('vana_live_tick_lag_seconds_max')).toBe(0.042);
    expect(m.get('vana_http_responses_total{class="4xx"}')).toBe(3);
    expect(m.get('vana_http_rate_limited_total')).toBe(2);
    expect(m.get('vana_db_pool_connections{state="idle"}')).toBe(3);
    expect(m.get('vana_db_pool_waiting_requests')).toBe(1);
    expect(m.get('vana_db_pool_max_connections')).toBe(10);
    // Label values are escaped, so a world id can never break the format.
    expect(m.get('vana_world_info{world_id="w\\"1\\\\x",sim_version="sim_9.9.9"}')).toBe(1);
    expect(m.get('process_resident_memory_bytes')).toBeGreaterThan(0);
    expect(m.has('vana_event_loop_delay_seconds{quantile="0.99"}')).toBe(true);
  });

  it('leaves out what is not running, and still answers when the database count fails', async () => {
    const m = parse(await renderMetrics(sources({ gateway: undefined,
      live: { avatars: () => 0, registered: async () => { throw new Error('db down'); }, tickLag: new WindowMax() } })));
    expect(m.has('vana_ws_connections')).toBe(false);
    expect(m.has('vana_live_agents_registered')).toBe(false);
    expect(m.get('vana_live_avatars')).toBe(0);
  });
});

describe('WindowMax', () => {
  it('reports the largest value of the last full window and the one in progress', () => {
    let now = 0;
    const w = new WindowMax(10_000, () => now);
    w.record(5); now = 9_000; w.record(2);
    expect(w.max).toBe(5);
    now = 12_000; w.record(1);
    expect(w.max).toBe(5); // The previous window still counts.
    now = 25_000;
    expect(w.max).toBe(1); // The window from 10 s to 20 s held a 1.
    now = 31_000;
    expect(w.max).toBe(0);
  });
});

describe('HTTP status classes', () => {
  it('counts every response by class and counts limit refusals', async () => {
    const http = newHttpStats();
    const app = buildApi({ host: standInHost, pool: standInPool, httpStats: http, limits: { publicReadsPerMinute: 12 } }); // Bursts of 3.
    await app.ready();
    await app.inject('/health');
    await app.inject('/no-such-route');
    for (let i = 0; i < 3; i++) await app.inject('/world');
    await app.close();
    expect(http.responses['2xx']).toBe(1);
    expect(http.responses['4xx']).toBe(2); // The 404 and the 429.
    expect(http.responses['5xx']).toBe(2); // A world with no checkpoint answers 503.
    expect(http.rateLimited).toBe(1);
  });
});

describe('where /metrics is served', () => {
  it('is not a route of the public API, under any spelling', async () => {
    const app = buildApi({ host: standInHost, pool: standInPool });
    await app.ready();
    for (const url of ['/metrics', '/%6detrics', '/metrics/', '/METRICS']) expect((await app.inject(url)).statusCode, url).toBe(404);
    await app.close();
  });

  it('is served on its own listener as Prometheus text, and nothing else is', async () => {
    const server = serveMetrics(async () => 'vana_up 1\n');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${base}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
      expect(await ok.text()).toBe('vana_up 1\n');
      expect((await fetch(`${base}/world`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
    } finally { await new Promise((r) => server.close(r)); }
  });

  it('answers 500 with no detail when a source throws', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = serveMetrics(async () => { throw new Error('secret detail'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('secret');
    } finally { quiet.mockRestore(); await new Promise((r) => server.close(r)); }
  });

  it('is refused by Caddy: /api/metrics is answered 404 before the API proxy', () => {
    const caddyfile = readFileSync(fileURLToPath(new URL('../../../deploy/Caddyfile', import.meta.url)), 'utf8');
    // Inside the explicit route, refusal precedes the general API proxy regardless
    // of indentation or whether Caddy's formatter uses tabs.
    expect(caddyfile).toMatch(/\bhandle \/api\/metrics\*\s*\{\s*respond 404\s*}/);
    expect(caddyfile.indexOf('handle /api/metrics')).toBeLessThan(caddyfile.indexOf('handle_path /api/'));
    expect(caddyfile).not.toMatch(/9464/);
  });
});

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));

maybe('SimHost figures for /metrics', () => {
  let host: SimHost;
  beforeAll(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, human_motion, follows, viewers cascade');
    host = new SimHost({ pool: pool!, seed: 5, speciesDir, initialAgents: { sambar: 6 }, minPopulation: { sambar: 6 }, landscape: null,
      worldHoursPerRealHour: 3600 }); // One world hour a real second.
  });
  afterAll(async () => { await host?.abort(); await pool?.end(); });

  it('reports checkpoint age, tick timings, failures and how far the clock is behind schedule', async () => {
    await host.boot();
    expect(Date.now() - host.lastCheckpointAt).toBeLessThan(5_000);
    expect(host.clockLagSeconds()).toBe(0);
    host.start();
    await vi.waitFor(() => expect(host.stats.lastTickSeconds).toBeGreaterThan(0), { timeout: 10_000 });
    expect(host.stats.maxTickSeconds).toBeGreaterThanOrEqual(host.stats.lastTickSeconds);
    // A world whose ticks fail falls behind its schedule, and the failures are counted.
    const advance = vi.spyOn(host, 'advance').mockRejectedValue(new Error('disk full'));
    await vi.waitFor(() => expect(host.stats.tickFailures).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(host.clockLagSeconds()).toBeGreaterThanOrEqual(3600);
    advance.mockRestore();
  });
});
