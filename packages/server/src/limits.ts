/**
 * General per-visitor limits (Workstream D; security review residual risk "public reads and
 * /live connections have no general limit"). The defaults are generous: an observer page makes
 * well under one read a second and holds one /live connection, so these only bite a script.
 */

export interface GeneralLimits {
  /** Public read requests a visitor network may make per minute; 0 turns the limit off. */
  publicReadsPerMinute: number;
  /** Concurrent /live connections in total; 0 turns the cap off. */
  liveMaxConnections: number;
  /** Concurrent /live connections from one visitor network; 0 turns the cap off. */
  liveMaxPerNetwork: number;
  /** New /live connections one visitor network may open per minute; 0 turns the limit off. */
  liveConnectsPerMinute: number;
}

export const GENERAL_LIMIT_DEFAULTS: GeneralLimits = {
  // Twenty a second, sustained, per address: dozens of observers behind one carrier NAT.
  publicReadsPerMinute: 1200,
  // The highest load tested (docs/2026-10-05-load-test.md): 1000 viewers plus 500 agents held,
  // with the main thread near one full core on a 4-CPU VM.
  liveMaxConnections: 1000,
  // A school, office or carrier NAT can put many real viewers behind one address.
  liveMaxPerNetwork: 100,
  // Each connection is sent the whole scene (about 1.6 MB). 120 a minute, in bursts of 30, lets a
  // NAT full of viewers come back after a restart (the client backs off on 1013) but not a loop.
  liveConnectsPerMinute: 120,
};

function setting(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]{1,7}$/.test(raw)) throw new Error(`Invalid ${name}`);
  return Number(raw);
}

/** VANA_PUBLIC_READS_PER_MINUTE, VANA_LIVE_MAX_CONNECTIONS, VANA_LIVE_MAX_CONNECTIONS_PER_NETWORK, VANA_LIVE_CONNECTS_PER_MINUTE. */
export function generalLimits(env: NodeJS.ProcessEnv): GeneralLimits {
  return {
    publicReadsPerMinute: setting(env, 'VANA_PUBLIC_READS_PER_MINUTE', GENERAL_LIMIT_DEFAULTS.publicReadsPerMinute),
    liveMaxConnections: setting(env, 'VANA_LIVE_MAX_CONNECTIONS', GENERAL_LIMIT_DEFAULTS.liveMaxConnections),
    liveMaxPerNetwork: setting(env, 'VANA_LIVE_MAX_CONNECTIONS_PER_NETWORK', GENERAL_LIMIT_DEFAULTS.liveMaxPerNetwork),
    liveConnectsPerMinute: setting(env, 'VANA_LIVE_CONNECTS_PER_MINUTE', GENERAL_LIMIT_DEFAULTS.liveConnectsPerMinute),
  };
}

/**
 * A token bucket per visitor network: `perMinute` sustained, bursts of a quarter of that. The
 * table is bounded; when it is full, visitors whose buckets have refilled are forgotten first
 * (they are indistinguishable from new ones), and only then is the whole table cleared.
 */
export class NetworkRateLimit {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #perMs: number;
  readonly burst: number;

  constructor(readonly perMinute: number, private readonly maxNetworks = 50_000) {
    this.#perMs = perMinute / 60_000;
    this.burst = Math.max(1, Math.floor(perMinute / 4));
  }

  /** Takes one request's token; on refusal, the whole seconds until the next one is due. */
  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
    let bucket = this.#buckets.get(key);
    if (bucket) {
      bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.at) * this.#perMs);
      bucket.at = now;
    } else {
      if (this.#buckets.size >= this.maxNetworks) this.#sweep(now);
      bucket = { tokens: this.burst, at: now };
      this.#buckets.set(key, bucket);
    }
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.#perMs / 1000)) };
  }

  get size(): number { return this.#buckets.size; }

  #sweep(now: number): void {
    for (const [key, b] of this.#buckets) if (b.tokens + (now - b.at) * this.#perMs >= this.burst) this.#buckets.delete(key);
    if (this.#buckets.size >= this.maxNetworks) this.#buckets.clear();
  }
}

/**
 * At most `perMinute` requests per visitor network in each minute-long window. The table is
 * bounded: once full, it is cleared rather than refusing every newcomer (which would lock out
 * the owner the moment enough addresses had visited, the very thing an attacker can arrange).
 */
export class WindowRateLimit {
  readonly #windows = new Map<string, { count: number; until: number }>();

  /** `windowMs` stretches the window for a quota (so many a day), `perMinute` then counting per window. */
  constructor(readonly perMinute: number, private readonly maxNetworks = 5000, private readonly windowMs = 60_000) {}

  take(key: string, now = Date.now()): boolean {
    let window = this.#windows.get(key);
    if (window && window.until <= now) window = undefined;
    if (!window) {
      if (this.#windows.size >= this.maxNetworks) {
        for (const [k, w] of this.#windows) if (w.until <= now) this.#windows.delete(k);
        if (this.#windows.size >= this.maxNetworks) this.#windows.clear();
      }
      window = { count: 0, until: now + this.windowMs };
      this.#windows.set(key, window);
    }
    return ++window.count <= this.perMinute;
  }

  get size(): number { return this.#windows.size; }
}

/**
 * Concurrent connections, in total and per visitor network. `admit` reserves a place or says
 * which cap refused it; `release` gives the place back when the connection ends.
 */
export class ConnectionCaps {
  readonly #perNetwork = new Map<string, number>();
  #total = 0;

  constructor(private readonly maxTotal: number, private readonly maxPerNetwork: number) {}

  admit(network: string): 'ok' | 'total' | 'network' {
    if (this.maxTotal > 0 && this.#total >= this.maxTotal) return 'total';
    const mine = this.#perNetwork.get(network) ?? 0;
    if (this.maxPerNetwork > 0 && mine >= this.maxPerNetwork) return 'network';
    this.#perNetwork.set(network, mine + 1);
    this.#total++;
    return 'ok';
  }

  release(network: string): void {
    const mine = this.#perNetwork.get(network);
    if (mine === undefined) return;
    if (mine <= 1) this.#perNetwork.delete(network); else this.#perNetwork.set(network, mine - 1);
    this.#total--;
  }

  get total(): number { return this.#total; }
  get networks(): number { return this.#perNetwork.size; }
}
