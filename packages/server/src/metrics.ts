import { createServer, type Server } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Operator metrics in the Prometheus text format (version 0.0.4). They are served by their own
 * listener on an internal port (VANA_METRICS_PORT), never by the public API, and Caddy refuses
 * /api/metrics as well. See deploy/README.md for how to scrape them.
 */

export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';
export interface HttpStats { responses: Record<StatusClass, number>; rateLimited: number }
export const newHttpStats = (): HttpStats => ({ responses: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, rateLimited: 0 });
export function countResponse(stats: HttpStats, status: number): void {
  const key = `${Math.min(5, Math.max(1, Math.floor(status / 100)))}xx` as StatusClass;
  stats.responses[key]++;
  if (status === 429) stats.rateLimited++;
}

/** The largest value seen in the current window or the whole previous one (10 s by default). */
export class WindowMax {
  #start: number;
  #current = 0;
  #previous = 0;
  constructor(private readonly windowMs = 10_000, private readonly clock: () => number = Date.now) { this.#start = clock(); }
  record(value: number): void { this.#roll(); if (value > this.#current) this.#current = value; }
  get max(): number { this.#roll(); return Math.max(this.#current, this.#previous); }
  #roll(): void {
    const now = this.clock();
    if (now - this.#start < this.windowMs) return;
    this.#previous = now - this.#start < 2 * this.windowMs ? this.#current : 0;
    this.#current = 0;
    this.#start = now - (now - this.#start) % this.windowMs;
  }
}

export interface MetricsSources {
  host: {
    checkpointTime: number | null; lastCheckpointAt: number; worldHoursPerRealHour: number; isWriterActive: boolean;
    consecutiveTickFailures: number; worldId: string | null; simVersion: string; clockLagSeconds(): number;
    stats: { tickFailures: number; ticksSkipped: number; lastTickSeconds: number; maxTickSeconds: number };
  };
  gateway?: { connectionCount: number; stats: {
    accepted: number; refused: Record<'busy' | 'busy_network' | 'world_unavailable', number>; messages: number; bytes: number;
    slowConsumerTerminations: number; broadcastSeconds: Record<'scene' | 'live' | 'roster', { max: number }>;
  } } | undefined;
  pool?: { totalCount: number; idleCount: number; waitingCount: number; options: { max?: number } } | undefined;
  live?: { avatars(): number; registered(): Promise<number>; tickLag: { max: number } } | undefined;
  http?: HttpStats | undefined;
}

/** Event-loop delay over rolling 10 s windows: what every timer, broadcast and request waits for. */
class LoopDelay {
  readonly #histogram = monitorEventLoopDelay({ resolution: 10 });
  #last = { p50: 0, p99: 0, max: 0 };
  constructor() {
    this.#histogram.enable();
    setInterval(() => {
      const h = this.#histogram;
      this.#last = { p50: h.percentile(50) / 1e9, p99: h.percentile(99) / 1e9, max: h.max / 1e9 };
      h.reset();
    }, 10_000).unref();
  }
  get last(): { p50: number; p99: number; max: number } { return this.#last; }
}
let loopDelay: LoopDelay | null = null;

type Sample = [labels: Record<string, string> | null, value: number];
const escape = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const number = (v: number): string => Number.isFinite(v) ? String(v) : Number.isNaN(v) ? 'NaN' : v > 0 ? '+Inf' : '-Inf';

export async function renderMetrics(src: MetricsSources, now = Date.now()): Promise<string> {
  loopDelay ??= new LoopDelay();
  const out: string[] = [];
  const family = (name: string, type: 'counter' | 'gauge', help: string, samples: Sample[] | number): void => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of typeof samples === 'number' ? [[null, samples] as Sample] : samples) {
      const l = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`).join(',')}}` : '';
      out.push(`${name}${l} ${number(value)}`);
    }
  };
  const { host } = src;

  family('vana_world_info', 'gauge', 'The running world and simulation version (always 1).',
    [[{ world_id: host.worldId ?? '', sim_version: host.simVersion }, 1]]);
  family('vana_world_time_seconds', 'gauge', 'World time of the last durable checkpoint.', host.checkpointTime ?? NaN);
  family('vana_world_hours_per_real_hour', 'gauge', 'Configured world clock rate.', host.worldHoursPerRealHour);
  family('vana_world_clock_lag_seconds', 'gauge', 'World seconds the clock is behind its schedule since this process started.', host.clockLagSeconds());
  family('vana_world_tick_duration_seconds', 'gauge', 'Wall time the last hourly world step took.', host.stats.lastTickSeconds);
  family('vana_world_tick_duration_seconds_max', 'gauge', 'Longest hourly world step since start.', host.stats.maxTickSeconds);
  family('vana_world_tick_failures_total', 'counter', 'Scheduled world steps that failed.', host.stats.tickFailures);
  family('vana_world_consecutive_tick_failures', 'gauge', 'Failed world steps in a row (the watchdog restarts at 3).', host.consecutiveTickFailures);
  family('vana_world_ticks_skipped_total', 'counter', 'Scheduled steps skipped because the previous one was still running.', host.stats.ticksSkipped);
  family('vana_checkpoint_age_seconds', 'gauge', 'Wall time since the last durable checkpoint.',
    host.lastCheckpointAt > 0 ? (now - host.lastCheckpointAt) / 1000 : NaN);
  family('vana_writer_active', 'gauge', '1 while this process holds the world writer.', host.isWriterActive ? 1 : 0);

  const loop = loopDelay.last;
  family('vana_event_loop_delay_seconds', 'gauge', 'Event-loop delay over the last 10 s window.',
    [[{ quantile: '0.5' }, loop.p50], [{ quantile: '0.99' }, loop.p99], [{ quantile: '1' }, loop.max]]);

  if (src.gateway) {
    const g = src.gateway.stats;
    family('vana_ws_connections', 'gauge', 'Open /live connections.', src.gateway.connectionCount);
    family('vana_ws_connections_accepted_total', 'counter', '/live connections admitted.', g.accepted);
    family('vana_ws_connections_refused_total', 'counter', '/live connections closed with 1013 (try again later), by reason.',
      Object.entries(g.refused).map(([reason, n]) => [{ reason }, n] as Sample));
    family('vana_ws_messages_sent_total', 'counter', 'Messages sent to /live viewers.', g.messages);
    family('vana_ws_sent_bytes_total', 'counter', 'Payload bytes sent to /live viewers, before compression.', g.bytes);
    family('vana_ws_slow_consumer_terminations_total', 'counter', 'Viewers cut off for falling 16 MB behind.', g.slowConsumerTerminations);
    family('vana_ws_broadcast_seconds_max', 'gauge', 'Longest single fan-out to all viewers in the last 10 s window, by kind.',
      Object.entries(g.broadcastSeconds).map(([kind, w]) => [{ kind }, w.max] as Sample));
  }

  if (src.live) {
    family('vana_live_avatars', 'gauge', 'Animals currently steered by live agents.', src.live.avatars());
    family('vana_live_tick_lag_seconds_max', 'gauge', 'Largest lateness of the 10 Hz live tick in the last 10 s window.', src.live.tickLag.max);
    const registered = await Promise.race([src.live.registered(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref())])
      .catch(() => null);
    if (registered !== null) family('vana_live_agents_registered', 'gauge', 'Registered live agents (slots taken).', registered);
  }

  if (src.http) {
    family('vana_http_responses_total', 'counter', 'API responses by status class.',
      Object.entries(src.http.responses).map(([klass, n]) => [{ class: klass }, n] as Sample));
    family('vana_http_rate_limited_total', 'counter', 'API requests refused with 429.', src.http.rateLimited);
  }

  if (src.pool) {
    const p = src.pool;
    family('vana_db_pool_connections', 'gauge', 'API database pool connections by state.',
      [[{ state: 'total' }, p.totalCount], [{ state: 'idle' }, p.idleCount], [{ state: 'busy' }, p.totalCount - p.idleCount]]);
    family('vana_db_pool_waiting_requests', 'gauge', 'Queries waiting for a pool connection.', p.waitingCount);
    family('vana_db_pool_max_connections', 'gauge', 'API database pool size limit.', p.options.max ?? 10);
  }

  const memory = process.memoryUsage(), cpu = process.cpuUsage();
  family('process_resident_memory_bytes', 'gauge', 'Resident set size.', memory.rss);
  family('process_heap_used_bytes', 'gauge', 'V8 heap in use.', memory.heapUsed);
  family('process_cpu_seconds_total', 'counter', 'User and system CPU time.', (cpu.user + cpu.system) / 1e6);
  family('process_start_time_seconds', 'gauge', 'Process start, Unix seconds.', Math.round(Date.now() / 1000 - process.uptime()));
  return `${out.join('\n')}\n`;
}

/** The metrics listener: GET /metrics only. The caller chooses the (internal) address. */
export function serveMetrics(render: () => Promise<string>): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics') { res.writeHead(404).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
    render().then((body) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    }, (error: unknown) => {
      console.error('[metrics] render failed', error);
      res.writeHead(500).end();
    });
  });
}
