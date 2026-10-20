import type { ArcBounty } from '../arcBounties/store.js';
import { type AlertContext, arcBountyAlert } from './messages.js';

/**
 * Alerts to a Discord channel and a Telegram chat, so people can follow the hunts
 * (docs/2026-10-19-congo-arc-bounties-design.md, "Alerts"). Everything here is best effort: an
 * alert that cannot be sent is logged once and dropped, and nothing ever throws into the bounty
 * engine, whose chain work must not wait on a chat service.
 */

export interface NotifyConfig {
  /** A Discord webhook (its URL holds its secret token). */
  discordWebhook: string | null;
  telegram: { token: string; chatId: string } | null;
  /** The public site, for links (VANA_PUBLIC_ORIGIN); none without it. */
  origin: string | null;
  /** Log each alert's text instead of sending it (VANA_NOTIFY_DRY_RUN=1). */
  dryRun: boolean;
}

const DISCORD_WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{1,30}\/[A-Za-z0-9_-]{1,200}$/;
const TELEGRAM_TOKEN = /^[0-9]{1,20}:[A-Za-z0-9_-]{20,100}$/;
const TELEGRAM_CHAT = /^(?:-?[0-9]{1,20}|@[A-Za-z0-9_]{5,32})$/;

/**
 * The alert settings, all optional: null when no destination is set and it is not a dry run, so
 * nothing is sent unless configured. A setting given but malformed stops the server, as other
 * settings do; the error never repeats the value, which may be a secret.
 */
export function notifyConfig(env: NodeJS.ProcessEnv): NotifyConfig | null {
  const value = (name: string) => env[name]?.trim() || null;
  const discordWebhook = value('VANA_NOTIFY_DISCORD_WEBHOOK');
  if (discordWebhook && !DISCORD_WEBHOOK.test(discordWebhook)) throw new Error('Invalid VANA_NOTIFY_DISCORD_WEBHOOK (a https://discord.com/api/webhooks/... URL)');
  const token = value('VANA_NOTIFY_TELEGRAM_BOT_TOKEN'), chatId = value('VANA_NOTIFY_TELEGRAM_CHAT_ID');
  if (!token !== !chatId) throw new Error('Set both VANA_NOTIFY_TELEGRAM_BOT_TOKEN and VANA_NOTIFY_TELEGRAM_CHAT_ID, or neither');
  if (token && !TELEGRAM_TOKEN.test(token)) throw new Error('Invalid VANA_NOTIFY_TELEGRAM_BOT_TOKEN');
  if (chatId && !TELEGRAM_CHAT.test(chatId)) throw new Error('Invalid VANA_NOTIFY_TELEGRAM_CHAT_ID');
  const dry = value('VANA_NOTIFY_DRY_RUN');
  if (dry && !['0', '1'].includes(dry)) throw new Error('Invalid VANA_NOTIFY_DRY_RUN (1 or 0)');
  const site = value('VANA_PUBLIC_ORIGIN');
  let origin: string | null = null;
  if (site) {
    let u: URL;
    try { u = new URL(site); } catch { throw new Error('Invalid VANA_PUBLIC_ORIGIN'); }
    // https, or http on this machine for a local dry run; an origin only.
    const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
    if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Invalid VANA_PUBLIC_ORIGIN');
    origin = u.origin;
  }
  if (!discordWebhook && !token && dry !== '1') return null;
  return { discordWebhook, telegram: token && chatId ? { token, chatId } : null, origin, dryRun: dry === '1' };
}

/** Where the alerts go, for the startup log (never the secrets). */
export function describeNotify(c: NotifyConfig): string {
  const to = [c.discordWebhook ? 'discord' : null, c.telegram ? 'telegram' : null].filter(Boolean).join(', ') || 'no destination';
  return `${to}${c.dryRun ? ' (dry run: logged, not sent)' : ''}${c.origin ? `, links to ${c.origin}` : ', no links'}`;
}

export interface NotifierOptions {
  fetch?: typeof fetch;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Discord's and Telegram's limits are about one message a second to one channel or chat. */
  minIntervalMs?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Alerts waiting per destination; more are dropped (a chat service down for hours). */
  maxQueued?: number;
  /** A wait asked for (retry-after) longer than this is a give-up, not a stall of every later alert. */
  maxRetryWaitMs?: number;
}

interface Destination { name: 'discord' | 'telegram'; url: string; body: (text: string) => unknown; maxLength: number }
interface Lane { dest: Destination; queue: string[]; lastAt: number; draining: Promise<void> | null }

/** Sends alert texts, one destination's at a time and at most one a second to each. */
export class Notifier {
  readonly #lanes: Lane[] = [];
  readonly #secrets: string[];
  readonly #fetch: typeof fetch; readonly #log: (line: string) => void; readonly #warn: (line: string) => void;
  readonly #sleep: (ms: number) => Promise<void>; readonly #now: () => number;
  readonly #minIntervalMs: number; readonly #maxAttempts: number; readonly #timeoutMs: number; readonly #maxQueued: number; readonly #maxRetryWaitMs: number;

  constructor(private readonly config: NotifyConfig, o: NotifierOptions = {}) {
    this.#fetch = o.fetch ?? fetch; this.#log = o.log ?? console.log; this.#warn = o.warn ?? console.error;
    this.#sleep = o.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    this.#now = o.now ?? Date.now;
    this.#minIntervalMs = o.minIntervalMs ?? 1100; this.#maxAttempts = o.maxAttempts ?? 4; this.#timeoutMs = o.timeoutMs ?? 10_000;
    this.#maxQueued = o.maxQueued ?? 100; this.#maxRetryWaitMs = o.maxRetryWaitMs ?? 120_000;
    // The webhook URL and the bot token are secrets: whoever has one can post as the bot.
    const webhookToken = config.discordWebhook?.split('/').pop();
    this.#secrets = [config.discordWebhook, webhookToken, config.telegram?.token].filter((s): s is string => !!s && s.length >= 8);
    if (config.discordWebhook) this.#lanes.push(this.#lane({ name: 'discord', url: config.discordWebhook, maxLength: 2000,
      // Plain content; no @everyone, @here, role or user pings whatever the text holds. Links keep their
      // previews: the board's share card is what makes an alert worth opening.
      body: (content) => ({ content, allowed_mentions: { parse: [] } }) }));
    if (config.telegram) {
      const chatId = config.telegram.chatId;
      this.#lanes.push(this.#lane({ name: 'telegram', url: `https://api.telegram.org/bot${config.telegram.token}/sendMessage`, maxLength: 4096,
        // No parse_mode: the text is sent as plain text, so nothing in it needs escaping.
        body: (text) => ({ chat_id: chatId, text }) }));
    }
  }

  #lane(dest: Destination): Lane { return { dest, queue: [], lastAt: -Infinity, draining: null }; }

  /** A string safe to log: the webhook URL and the bot token cut out wherever they appear. */
  redact(s: string): string {
    let out = s;
    for (const secret of this.#secrets) out = out.split(secret).join('[redacted]');
    return out;
  }

  /** Queues an alert for every destination (or logs it, on a dry run). Never throws. */
  send(text: string): void {
    try {
      if (this.config.dryRun) { this.#log(this.redact(`[notify] dry run: ${text}`)); return; }
      for (const lane of this.#lanes) {
        if (lane.queue.length >= this.#maxQueued) { this.#warn(`[notify] ${lane.dest.name}: ${lane.queue.length} alerts waiting, dropped one`); continue; }
        lane.queue.push(text.length > lane.dest.maxLength ? `${text.slice(0, lane.dest.maxLength - 1)}…` : text);
        this.#kick(lane);
      }
    } catch (error) {
      this.#warn(this.redact(`[notify] could not queue an alert: ${String((error as Error)?.message ?? error)}`));
    }
  }

  /** Resolves once every queued alert has been sent or given up on. */
  async idle(): Promise<void> {
    while (this.#lanes.some((l) => l.draining)) await Promise.all(this.#lanes.map((l) => l.draining));
  }

  /** Starts a lane's sender unless it runs; an alert queued as it finishes starts it again. */
  #kick(lane: Lane): void {
    if (lane.draining) return;
    lane.draining = this.#drain(lane).finally(() => { lane.draining = null; if (lane.queue.length > 0) this.#kick(lane); });
  }

  async #drain(lane: Lane): Promise<void> {
    // Each destination in its own lane: a slow Discord never holds Telegram's alerts back.
    await Promise.resolve();
    while (lane.queue.length > 0) {
      const text = lane.queue.shift()!;
      try { await this.#deliver(lane, text); } catch (error) {
        this.#warn(this.redact(`[notify] ${lane.dest.name}: ${String((error as Error)?.message ?? error)}`));
      }
    }
  }

  /** One alert to one destination: retried with backoff on a 429, a 5xx or a network failure; given up on after a few tries. */
  async #deliver(lane: Lane, text: string): Promise<void> {
    const { name, url } = lane.dest;
    let problem = '', attempt = 0;
    while (++attempt <= this.#maxAttempts) {
      const wait = lane.lastAt + this.#minIntervalMs - this.#now();
      if (wait > 0) await this.#sleep(wait);
      lane.lastAt = this.#now();
      let retryInMs: number | null = null;
      try {
        const response = await this.#fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(lane.dest.body(text)), signal: AbortSignal.timeout(this.#timeoutMs) });
        const body = await response.text().catch(() => '');
        if (response.ok) return;
        problem = `status ${response.status}`;
        if (response.status !== 429 && response.status < 500) break;
        retryInMs = retryAfterMs(response.headers.get('retry-after'), body, this.#now());
      } catch (error) {
        const e = error as Error;
        problem = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : `network error: ${String(e?.message ?? error)}`;
      }
      if (attempt >= this.#maxAttempts) break;
      const delay = retryInMs ?? 1000 * 2 ** (attempt - 1);
      if (delay > this.#maxRetryWaitMs) { problem += `, asked to wait ${Math.round(delay / 1000)} s`; break; }
      await this.#sleep(delay);
    }
    this.#warn(this.redact(`[notify] ${name}: gave up on an alert after ${Math.min(attempt, this.#maxAttempts)} attempt${attempt === 1 ? '' : 's'} (${problem})`));
  }
}

/**
 * How long a 429 or 5xx asked us to wait, in ms: the Retry-After header (seconds or an HTTP date),
 * else the body's retry_after (Discord, in seconds) or parameters.retry_after (Telegram); null if none.
 */
export function retryAfterMs(header: string | null, body: string, now: number): number | null {
  if (header?.trim()) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown; parameters?: { retry_after?: unknown } };
    const seconds = typeof parsed?.retry_after === 'number' ? parsed.retry_after : parsed?.parameters?.retry_after;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  } catch { /* not JSON */ }
  return null;
}

/**
 * The bounty engine's `announce` port: each event's alert, once (a restart may confirm the same
 * publish or settlement again), queued on the notifier. Never throws.
 */
export function arcBountyAnnouncer(notifier: Notifier, ctx: AlertContext): (event: { kind: 'published' | 'settled'; bounty: ArcBounty }) => void {
  const seen = new Set<string>();
  return (event) => {
    try {
      const key = `${event.kind}:${event.bounty.bountyId}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 1000) seen.delete(seen.values().next().value!);
      const text = arcBountyAlert(event, ctx);
      if (text) notifier.send(text);
    } catch (error) {
      console.error(notifier.redact(`[notify] arc bounty alert failed: ${String((error as Error)?.message ?? error)}`));
    }
  };
}
