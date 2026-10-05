/**
 * Load test for the /live WebSocket and the live-agent API, run against a local stack
 * (tools/e2e/stack.sh). It never reads secrets: spectators are anonymous and agents register
 * themselves through the published signed client.
 *
 *   npx tsx tools/ops/load.ts --steps 50:0,200:0,500:0,1000:0,0:25,0:100,0:250,0:500 [options]
 *
 * Each step is SPECTATORS:AGENTS. Spectators open /live, send a `view` (a camera somewhere on the
 * island) every second and follow a random animal now and then. Agents use
 * packages/server/agent-client/client.mjs, each with its own HOME, to register, possess and move.
 * During each step the server container is sampled every 5 s: `docker stats` for CPU, memory and
 * network, and its internal /metrics (through `docker exec`) for tick lag, broadcast time and
 * sockets. Results print as a table and are written as JSON.
 *
 * Options: --base http://localhost:28080  --duration 60 (measured seconds per step)
 *   --container vana-e2e-server-1  --profiles DIR (agent HOME dirs, kept between runs)
 *   --register N (only register agents 0..N-1, pacing for the per-network limit, then exit)
 *   --workers 4  --ramp 50 (new spectator connections per second)  --out FILE.json
 */
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const clientScript = join(root, 'packages/server/agent-client/client.mjs');

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}
const base = option('base', 'http://localhost:28080').replace(/\/+$/, '');
const profiles = resolve(option('profiles', join(tmpdir(), 'vana-load-agents')));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Shared measurement helpers.

/** Keeps at most `limit` samples, uniformly (reservoir sampling), so percentiles stay honest. */
class Samples {
  values: number[] = [];
  seen = 0;
  constructor(private readonly limit = 20_000) {}
  add(v: number): void {
    this.seen++;
    if (this.values.length < this.limit) this.values.push(v);
    else { const i = Math.floor(Math.random() * this.seen); if (i < this.limit) this.values[i] = v; }
  }
}
const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};

interface WorkerReport {
  kind: 'spectators' | 'agents';
  connected?: number; refused?: Record<string, number>; closed?: Record<string, number>; errors?: number;
  firstScene?: number[]; liveLatency?: number[]; messages?: Record<string, number>; bytes?: number;
  /** For each checkpoint broadcast: first and last arrival (ms since epoch) and how many arrived. */
  sceneArrivals?: Record<string, [number, number, number]>;
  calls?: Record<string, { ok: number; status: Record<string, number>; latency: number[] }>;
  possessing?: number; queued?: number; cpuSeconds: number; wallSeconds: number;
}

// ---------------------------------------------------------------------------------------------
// Spectator worker: `count` anonymous /live viewers.

async function spectatorWorker(count: number, rampPerSecond: number): Promise<void> {
  const url = `${base.replace(/^http/, 'ws')}/live`;
  let connected = 0, errors = 0, bytes = 0;
  const refused: Record<string, number> = {}, closed: Record<string, number> = {}, messages: Record<string, number> = {};
  const firstScene = new Samples();
  let liveLatency = new Samples();
  let sceneArrivals: Record<string, [number, number, number]> = {};
  let animals: Array<{ id: string; x: number; z: number }> = [];
  const sockets: WebSocket[] = [];
  let stopping = false;
  let cpuMark = process.cpuUsage(), wallMark = performance.now();

  const open = (): void => {
    const started = performance.now();
    const ws = new WebSocket(url);
    sockets.push(ws);
    let gotScene = false, timer: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      connected++;
      timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const a = animals[Math.floor(Math.random() * animals.length)];
        const view = a ? { x: Math.round(a.x + (Math.random() - 0.5) * 200), z: Math.round(a.z + (Math.random() - 0.5) * 200) } : { x: 3000, z: 3000 };
        ws.send(JSON.stringify({ type: 'view', ...view, radius: Math.round(300 + Math.random() * 1200) }));
        if (a && Math.random() < 1 / 30) ws.send(JSON.stringify({ type: 'watch', actorId: a.id }));
      }, 1000 + Math.random() * 100);
    });
    ws.on('message', (data: Buffer) => {
      bytes += data.length;
      const head = data.subarray(0, 120).toString();
      const type = /^\{"type":"([a-z-]+)"/.exec(head)?.[1] ?? 'other';
      messages[type] = (messages[type] ?? 0) + 1;
      if (type === 'scene' && !gotScene) {
        gotScene = true;
        firstScene.add(performance.now() - started);
        if (animals.length === 0) {
          const scene = JSON.parse(String(data)) as { animals: Array<{ id: string; position: { x: number; z: number } }> };
          animals = scene.animals.map((a) => ({ id: a.id, x: a.position.x, z: a.position.z }));
        }
      } else if (type === 'scene') {
        // A later scene carrying the environment is a new checkpoint, sent to every viewer at
        // once: how long it takes to reach them all. (Scenes after a `watch` are only for one.)
        const id = /"checkpointId":"([^"]+)"/.exec(head)?.[1];
        if (id && data.includes('"environment":{')) {
          const now = Date.now(), a = sceneArrivals[id] ??= [now, now, 0];
          a[0] = Math.min(a[0], now); a[1] = Math.max(a[1], now); a[2]++;
        }
      } else if (type === 'live') {
        const at = /"at":(\d+)/.exec(head)?.[1];
        if (at) liveLatency.add(Date.now() - Number(at));
      }
    });
    ws.on('close', (code, reason) => {
      if (timer) clearInterval(timer);
      if (stopping) return;
      const key = `${code}${reason.length ? ` ${String(reason)}` : ''}`;
      if (code === 1013) refused[key] = (refused[key] ?? 0) + 1; else closed[key] = (closed[key] ?? 0) + 1;
    });
    ws.on('error', () => { errors++; });
  };

  for (let i = 0; i < count; i++) {
    open();
    await sleep(1000 / rampPerSecond);
  }
  process.send!({ type: 'ready' });
  process.on('message', (m: { type: string }) => {
    if (m.type === 'mark') {
      errors = 0; bytes = 0; liveLatency = new Samples(); sceneArrivals = {};
      for (const o of [refused, closed, messages]) for (const k of Object.keys(o)) delete o[k];
      cpuMark = process.cpuUsage(); wallMark = performance.now();
    } else if (m.type === 'report') {
      const cpu = process.cpuUsage(cpuMark);
      const open = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
      const report: WorkerReport = { kind: 'spectators', connected: open, refused, closed, errors, firstScene: firstScene.values,
        liveLatency: liveLatency.values, messages, bytes, sceneArrivals, cpuSeconds: (cpu.user + cpu.system) / 1e6, wallSeconds: (performance.now() - wallMark) / 1000 };
      process.send!({ type: 'report', report });
    } else if (m.type === 'stop') {
      stopping = true;
      for (const s of sockets) s.terminate();
      setTimeout(() => process.exit(0), 200);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Agent worker: agents `from`..`to`-1, each a separate instance of the published client module
// with its own HOME, as separate people running `node client.mjs` would have.

type ClientApi = Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;

async function loadAgent(index: number): Promise<{ api: ClientApi; dir: string }> {
  const dir = join(profiles, `agent-${String(index).padStart(4, '0')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The client reads HOME, VANA_URL and VANA_PROFILE when it is evaluated; each import with its
  // own query string is a separate module instance, evaluated before the import resolves.
  process.env.HOME = dir; process.env.VANA_URL = `${base}/api`; process.env.VANA_PROFILE = 'load';
  const module = await import(`${pathToFileURL(clientScript).href}?agent=${index}`) as { api: ClientApi };
  return { api: module.api, dir };
}

async function ensureRegistered(index: number, api: ClientApi, dir: string): Promise<'registered' | 'existing'> {
  const marker = join(dir, 'registered.json');
  if (existsSync(marker)) return 'existing';
  for (;;) {
    try {
      const r = await api.register!(`load${String(index).padStart(4, '0')}${Math.random().toString(36).slice(2, 6)}`, 'Load-test agent.');
      writeFileSync(marker, JSON.stringify(r));
      return 'registered';
    } catch (e) {
      const err = e as { status?: number; message: string };
      // One registration every six seconds per network after a burst of ten (routes.ts).
      if (err.status === 429 && err.message === 'rate_limited') { await sleep(6_500); continue; }
      // A restart or proxy hiccup: wait and try again rather than lose the whole run.
      if (err.status === undefined || err.status >= 500) { await sleep(10_000); continue; }
      throw e;
    }
  }
}

async function agentWorker(from: number, to: number): Promise<void> {
  const agents: Array<{ api: ClientApi; species: string }> = [];
  const species = ['chital', 'boar', 'hare', 'sambar', 'langur', 'gaur', 'squirrel'];
  for (let i = from; i < to; i++) {
    const { api, dir } = await loadAgent(i);
    await ensureRegistered(i, api, dir);
    agents.push({ api, species: species[i % species.length]! });
  }
  let calls: Record<string, { ok: number; status: Record<string, number>; latency: Samples }> = {};
  const timed = async <T>(op: string, call: () => Promise<T>): Promise<T | null> => {
    const c = calls[op] ??= { ok: 0, status: {}, latency: new Samples(5_000) };
    const started = performance.now();
    try { const r = await call(); c.ok++; c.latency.add(performance.now() - started); return r; }
    catch (e) {
      const err = e as { status?: number; message?: string };
      const key = err.status ? `${err.status} ${err.message}` : `network ${String(err.message).slice(0, 40)}`;
      c.status[key] = (c.status[key] ?? 0) + 1; c.latency.add(performance.now() - started);
      return null;
    }
  };
  let running = true, possessing = 0, queued = 0, cpuMark = process.cpuUsage(), wallMark = performance.now();
  const state = agents.map(() => ({ animal: false, queued: false, nextPossess: 0, nextMove: 0 }));
  const loops = agents.map(async (agent, i) => {
    await sleep(Math.random() * 2000);
    const s = state[i]!;
    while (running) {
      const o = await timed('observe', () => agent.api.observe!()) as { animal?: { position: { x: number; z: number } } | null } | null;
      if (o) s.animal = !!o.animal;
      const now = Date.now();
      if (o && !o.animal && now >= s.nextPossess) {
        const r = await timed('possess', () => agent.api.possess!(agent.species));
        s.queued = !!r && 'queued' in r; s.animal = !!r && 'animalId' in r; s.nextPossess = now + 15_000;
      } else if (o?.animal && now >= s.nextMove) {
        const p = o.animal.position, angle = Math.random() * Math.PI * 2;
        await timed('move', () => agent.api.move!([{ x: p.x + Math.sin(angle) * 40, z: p.z + Math.cos(angle) * 40 }], 'walk'));
        s.nextMove = now + 3_000 + Math.random() * 2_000;
      }
      await sleep(2_000 + Math.random() * 200);
    }
  });
  process.send!({ type: 'ready' });
  process.on('message', (m: { type: string }) => {
    if (m.type === 'mark') { calls = {}; cpuMark = process.cpuUsage(); wallMark = performance.now(); }
    else if (m.type === 'report') {
      possessing = state.filter((s) => s.animal).length; queued = state.filter((s) => !s.animal && s.queued).length;
      const cpu = process.cpuUsage(cpuMark);
      const report: WorkerReport = { kind: 'agents', possessing, queued, cpuSeconds: (cpu.user + cpu.system) / 1e6, wallSeconds: (performance.now() - wallMark) / 1000,
        calls: Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, { ok: v.ok, status: v.status, latency: v.latency.values }])) };
      process.send!({ type: 'report', report });
    } else if (m.type === 'stop') {
      running = false;
      // Give the animals back, so the next step starts from a wild island.
      void Promise.allSettled([...loops, ...agents.map((a, i) => state[i]!.animal || state[i]!.queued ? a.api.release!() : Promise.resolve({}))])
        .then(() => process.exit(0));
      setTimeout(() => process.exit(0), 15_000);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Orchestrator.

const run = (cmd: string, args: string[]): Promise<string> => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 }, (e, out) => e ? reject(e) : resolve(out)));

const bytesOf = (s: string): number => {
  const m = /([0-9.]+)\s*([kKMGT]?i?B)/.exec(s);
  if (!m) return NaN;
  const unit = m[2]!.toLowerCase().replace('i', '');
  return Number(m[1]) * ({ b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 }[unit] ?? 1) * (m[2]!.includes('i') ? ({ kb: 1.024, mb: 1.048576, gb: 1.073741824 }[unit] ?? 1) : 1);
};

interface Sample { at: number; cpu: number; rssMB: number; netTx: number; metrics: Map<string, number>; healthMs: number | null; healthOk: boolean }

async function sample(container: string): Promise<Sample> {
  const at = Date.now();
  const [stats, text, health] = await Promise.all([
    run('docker', ['stats', '--no-stream', '--format', '{{json .}}', container]).then((o) => JSON.parse(o) as Record<string, string>),
    run('docker', ['exec', container, 'wget', '-qO-', 'http://127.0.0.1:9464/metrics']).catch(() => ''),
    (async () => {
      const t = performance.now();
      try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) }); return { ms: performance.now() - t, ok: r.ok }; }
      catch { return { ms: null, ok: false }; }
    })(),
  ]);
  const metrics = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^([a-z_:][a-z0-9_:]*(?:\{[^}]*\})?) (\S+)$/.exec(line);
    if (m) metrics.set(m[1]!, Number(m[2]));
  }
  return { at, cpu: parseFloat(stats.CPUPerc ?? 'NaN'), rssMB: bytesOf((stats.MemUsage ?? '').split('/')[0]!) / 1e6,
    netTx: bytesOf((stats.NetIO ?? '').split('/')[1] ?? ''), metrics, healthMs: health.ms, healthOk: health.ok };
}

function spawnWorker(args: string[]): ChildProcess {
  return fork(fileURLToPath(import.meta.url), args, { execArgv: process.execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
}
const once = (child: ChildProcess, type: string): Promise<Record<string, unknown>> => new Promise((resolve) => {
  const on = (m: Record<string, unknown>) => { if (m.type === type) { child.off('message', on); resolve(m); } };
  child.on('message', on);
});

async function step(spectators: number, agents: number, opts: { duration: number; workers: number; ramp: number; container: string }) {
  const children: ChildProcess[] = [];
  const split = (n: number, k: number) => Array.from({ length: Math.min(k, n) }, (_, i) => Math.floor(n / Math.min(k, n)) + (i < n % Math.min(k, n) ? 1 : 0));
  for (const n of split(spectators, opts.workers))
    children.push(spawnWorker(['--worker', 'spectators', '--count', String(n), '--ramp', String(opts.ramp / Math.min(opts.workers, spectators)), '--base', base]));
  let from = 0;
  for (const n of split(agents, opts.workers)) {
    children.push(spawnWorker(['--worker', 'agents', '--from', String(from), '--to', String(from + n), '--base', base, '--profiles', profiles]));
    from += n;
  }
  const rampStart = Date.now();
  await Promise.all(children.map((c) => once(c, 'ready')));
  const rampSeconds = (Date.now() - rampStart) / 1000;
  await sleep(10_000); // Let first scenes and first possessions settle.
  for (const c of children) c.send({ type: 'mark' });
  const samples: Sample[] = [];
  const end = Date.now() + opts.duration * 1000;
  const take = async () => { try { samples.push(await sample(opts.container)); } catch (e) { console.error('sample failed:', String(e).slice(0, 200)); } };
  while (Date.now() < end) {
    const at = Date.now();
    await take();
    await sleep(Math.max(0, 5_000 - (Date.now() - at)));
  }
  await take();
  const reports = await Promise.all(children.map(async (c) => { const p = once(c, 'report'); c.send({ type: 'report' }); return (await p).report as WorkerReport; }));
  await Promise.all(children.map((c) => new Promise<void>((resolve) => { c.once('exit', () => resolve()); c.send({ type: 'stop' }); })));
  return summarize(spectators, agents, rampSeconds, samples, reports);
}

function summarize(spectators: number, agents: number, rampSeconds: number, samples: Sample[], reports: WorkerReport[]) {
  const first = samples[0]!, last = samples.at(-1)!, seconds = (last.at - first.at) / 1000;
  const metric = (s: Sample, name: string) => s.metrics.get(name) ?? NaN;
  const maxOf = (name: string) => Math.max(...samples.map((s) => metric(s, name)).filter(Number.isFinite));
  const delta = (name: string) => metric(last, name) - metric(first, name);
  const spect = reports.filter((r) => r.kind === 'spectators'), ag = reports.filter((r) => r.kind === 'agents');
  const merge = (pick: (r: WorkerReport) => Record<string, number> | undefined) => {
    const out: Record<string, number> = {};
    for (const r of reports) for (const [k, v] of Object.entries(pick(r) ?? {})) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const live = spect.flatMap((r) => r.liveLatency ?? []), scenes = spect.flatMap((r) => r.firstScene ?? []);
  const arrivals: Record<string, [number, number, number]> = {};
  for (const r of spect) for (const [id, [lo, hi, n]] of Object.entries(r.sceneArrivals ?? {})) {
    const a = arrivals[id] ??= [lo, hi, 0];
    a[0] = Math.min(a[0], lo); a[1] = Math.max(a[1], hi); a[2] += n;
  }
  const fanout = Object.values(arrivals).map(([lo, hi, n]) => ({ spreadMs: hi - lo, viewers: n }));
  const calls: Record<string, { ok: number; failed: Record<string, number>; p50: number | null; p95: number | null; p99: number | null }> = {};
  for (const op of new Set(ag.flatMap((r) => Object.keys(r.calls ?? {})))) {
    const parts = ag.map((r) => r.calls?.[op]).filter((c) => c !== undefined);
    const lat = parts.flatMap((p) => p.latency), failed: Record<string, number> = {};
    for (const p of parts) for (const [k, v] of Object.entries(p.status)) failed[k] = (failed[k] ?? 0) + v;
    calls[op] = { ok: parts.reduce((n, p) => n + p.ok, 0), failed, p50: percentile(lat, 0.5), p95: percentile(lat, 0.95), p99: percentile(lat, 0.99) };
  }
  const round = (v: number | null, d = 0) => v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
  return {
    spectators, agents, rampSeconds: round(rampSeconds, 1), measuredSeconds: round(seconds),
    connected: spect.reduce((n, r) => n + (r.connected ?? 0), 0),
    refused: merge((r) => r.refused), closed: merge((r) => r.closed), wsErrors: spect.reduce((n, r) => n + (r.errors ?? 0), 0),
    possessing: ag.reduce((n, r) => n + (r.possessing ?? 0), 0), queued: ag.reduce((n, r) => n + (r.queued ?? 0), 0),
    cpuPercent: { mean: round(samples.reduce((n, s) => n + s.cpu, 0) / samples.length), max: round(Math.max(...samples.map((s) => s.cpu))) },
    rssMB: { max: round(Math.max(...samples.map((s) => s.rssMB))) },
    eventLoopP99Ms: round(maxOf('vana_event_loop_delay_seconds{quantile="0.99"}') * 1000, 1),
    eventLoopMaxMs: round(maxOf('vana_event_loop_delay_seconds{quantile="1"}') * 1000, 1),
    liveTickLagMaxMs: round(maxOf('vana_live_tick_lag_seconds_max') * 1000, 1),
    broadcastMaxMs: { live: round(maxOf('vana_ws_broadcast_seconds_max{kind="live"}') * 1000, 1),
      roster: round(maxOf('vana_ws_broadcast_seconds_max{kind="roster"}') * 1000, 1), scene: round(maxOf('vana_ws_broadcast_seconds_max{kind="scene"}') * 1000, 1) },
    worldClockLagMaxS: round(maxOf('vana_world_clock_lag_seconds')),
    worldTickMaxS: round(maxOf('vana_world_tick_duration_seconds'), 2),
    dbPoolWaitingMax: round(maxOf('vana_db_pool_waiting_requests')),
    serverSentMBps: round(delta('vana_ws_sent_bytes_total') / seconds / 1e6, 2),
    serverMessagesPerS: round(delta('vana_ws_messages_sent_total') / seconds),
    wireTxMBps: round((last.netTx - first.netTx) / seconds / 1e6, 2),
    slowConsumerTerminations: round(delta('vana_ws_slow_consumer_terminations_total')),
    http5xx: round(delta('vana_http_responses_total{class="5xx"}')), http429: round(delta('vana_http_rate_limited_total')),
    healthOk: samples.every((s) => s.healthOk), healthMaxMs: round(Math.max(...samples.map((s) => s.healthMs ?? Infinity))),
    liveLatencyMs: { n: live.length, p50: percentile(live, 0.5), p95: percentile(live, 0.95), p99: percentile(live, 0.99) },
    firstSceneMs: { n: scenes.length, p50: round(percentile(scenes, 0.5)), p95: round(percentile(scenes, 0.95)) },
    checkpointFanout: fanout,
    receivedMBps: round(spect.reduce((n, r) => n + (r.bytes ?? 0), 0) / seconds / 1e6, 2),
    messagesReceived: merge((r) => r.messages),
    agentCalls: calls,
    loadGeneratorCpu: round(Math.max(0, ...reports.map((r) => r.cpuSeconds / Math.max(1, r.wallSeconds) * 100))),
  };
}

async function main(): Promise<void> {
  const worker = option('worker', '');
  if (worker === 'spectators') return spectatorWorker(Number(option('count', '0')), Number(option('ramp', '50')));
  if (worker === 'agents') return agentWorker(Number(option('from', '0')), Number(option('to', '0')));

  const register = Number(option('register', '0'));
  if (register > 0) {
    let made = 0;
    for (let i = 0; i < register; i++) {
      const { api, dir } = await loadAgent(i);
      if (await ensureRegistered(i, api, dir) === 'registered') made++;
      if (i % 25 === 24) console.log(`agents 0..${i}: ${made} newly registered`);
    }
    console.log(`${register} agents ready under ${profiles} (${made} newly registered)`);
    return;
  }

  const steps = option('steps', '50:0,200:0,500:0,1000:0,0:25,0:100,0:250,0:500').split(',').map((s) => s.split(':').map(Number) as [number, number]);
  const opts = { duration: Number(option('duration', '60')), workers: Number(option('workers', '4')), ramp: Number(option('ramp', '50')),
    container: option('container', 'vana-e2e-server-1') };
  const out = resolve(option('out', join(root, '.ci-artifacts', 'load', `load-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)));
  mkdirSync(dirname(out), { recursive: true });
  const hardware = { host: `${cpus()[0]?.model} x${cpus().length}`, docker: await run('docker', ['info', '--format', '{{.NCPU}} CPUs, {{.MemTotal}} bytes, {{.OperatingSystem}}']).then((s) => s.trim()).catch(() => 'unknown') };
  const results: unknown[] = [];
  console.log(`load test against ${base}; ${JSON.stringify(hardware)}`);
  for (const [spectators, agents] of steps) {
    console.log(`\n== step ${spectators} spectators, ${agents} agents ==`);
    const result = await step(spectators, agents, opts);
    results.push(result);
    console.log(JSON.stringify(result));
    writeFileSync(out, JSON.stringify({ base, hardware, opts, results }, null, 2));
    await sleep(15_000); // Cool down between steps.
  }
  console.log(`\nresults: ${out}`);
  if (existsSync(out)) console.log(readFileSync(out, 'utf8').length, 'bytes');
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
