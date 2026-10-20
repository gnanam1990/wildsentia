import { describe, expect, it, vi } from 'vitest';
import type { ArcBounty } from '../src/arcBounties/store.js';
import { type AlertContext, aboutRealTime, publishedAlert, settledAlert, shortWallet, usdcText } from '../src/notify/messages.js';
import { type NotifyConfig, Notifier, arcBountyAnnouncer, notifyConfig, retryAfterMs } from '../src/notify/notify.js';

/**
 * Alerts for Congo bounties paid on Arc (docs/2026-10-19-congo-arc-bounties-design.md, "Alerts"),
 * against a fake fetch and a fake clock: nothing here reaches Discord or Telegram.
 */
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/fixture-webhook-secret_ABCdef';
const BOT_TOKEN = '123456:fixture-bot-token-secret_ABCdef';
const HUNTER_WALLET = '0x00000000000000000000000000000000000000a1', PREY_WALLET = '0x1234000000000000000000000000000000b2abcd';
const ID = `0x${'ab'.repeat(32)}`, DECIDE_TX = `0x${'cd'.repeat(32)}`;

const bounty = (over: Partial<ArcBounty> = {}): ArcBounty => ({
  bountyId: ID, worldId: 'world-test', status: 'active', targetAnimalId: 'blue_duiker_2011', targetSpeciesId: 'blue_duiker', targetRegion: 'r3_2',
  targetAgentId: 'prey-agent', targetWallet: PREY_WALLET, targetKey: '0xkey', salt: '0xsalt', amountAtomic: 5_000_000n, windowWorldSeconds: 3 * 86_400,
  publishedWorldTime: 100_000, deadlineWorldTime: 100_000 + 3 * 86_400, expiresAt: new Date('2026-10-20T00:00:00Z'), eligiblePredators: ['african_leopard'],
  rules: {}, rulesHash: '0xrules', notified: true, killAgentId: null, killAnimalId: null, killWorldTime: null, killPreyAgentId: null,
  outcome: null, payeeWallet: null, winnerAgentId: null, winnerAnimalId: null, decidedWorldTime: null, record: null, recordHash: null,
  publishTx: '0xpublish', publishSentAt: null, decideTx: null, decideSentAt: null, error: null,
  createdAt: new Date(), decidedAt: null, settledAt: null, ...over,
});
const ctx = (over: Partial<AlertContext> = {}): AlertContext => ({
  origin: 'https://wildsentia.lol', rate: () => 12, now: () => 100_000,
  txUrl: (h) => h ? `https://testnet.arcscan.app/tx/${h}` : null, ...over,
});
const config = (over: Partial<NotifyConfig> = {}): NotifyConfig => ({ discordWebhook: null, telegram: null, origin: null, dryRun: false, ...over });

/** A fake clock whose sleeps move it on at once, and a fake fetch that answers from a script. */
function harness(answers: Array<() => Response | Promise<Response>> = []) {
  let t = 0;
  const calls: Array<{ at: number; url: string; body: Record<string, unknown> }> = [], sleeps: number[] = [], logs: string[] = [], warns: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    calls.push({ at: t, url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const answer = answers.shift();
    return answer ? answer() : new Response('{"ok":true}', { status: 200 });
  });
  const options = { fetch, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    log: (l: string) => logs.push(l), warn: (l: string) => warns.push(l), minIntervalMs: 1000 };
  return { fetch, calls, sleeps, logs, warns, options };
}

describe('alert texts', () => {
  it('announces a live bounty with its amount, species, region and deadline, and never its animal or agent', () => {
    const text = publishedAlert(bounty(), ctx());
    expect(text).toContain('5 USDC on a blue duiker in region r3_2');
    // Three world days at 12 world hours a real hour: six real hours.
    expect(text).toContain('world time, about 6 hours from now');
    expect(text).toMatch(/Deadline: Y\d+-\w+-D\d+ \d\d:\d\d world time/);
    expect(text).toContain(`Board: https://wildsentia.lol/bounties.html#${ID}`);
    for (const secret of ['blue_duiker_2011', 'prey-agent', PREY_WALLET, '0xsalt', '0xkey']) expect(text).not.toContain(secret);
    // Confirmed late (after a restart), it says how long is really left.
    expect(publishedAlert(bounty(), ctx({ now: () => 100_000 + 3 * 86_400 - 3600 }))).toContain('about 5 minutes from now');
  });

  it('carries no site link without an origin', () => {
    expect(publishedAlert(bounty(), ctx({ origin: null }))).not.toContain('http');
    expect(settledAlert(bounty({ status: 'paid', outcome: 'survived', payeeWallet: PREY_WALLET, winnerAnimalId: 'blue_duiker_2011' }),
      ctx({ origin: null, txUrl: () => null }))).not.toContain('http');
  });

  it('settles a hunter win with the target revealed, the hunter, the shortened wallet, the payment and a watch link', () => {
    const text = settledAlert(bounty({ status: 'paid', outcome: 'predator', payeeWallet: HUNTER_WALLET, winnerAgentId: 'hunter-agent',
      winnerAnimalId: 'african_leopard_12', killAnimalId: 'african_leopard_12', decideTx: DECIDE_TX }), ctx())!;
    expect(text).toBe([
      'Bounty won by a hunter: 5 USDC.',
      'african_leopard_12 killed the target, blue_duiker_2011.',
      'Paid to 0x0000…00a1.',
      `Payment: https://testnet.arcscan.app/tx/${DECIDE_TX}`,
      'Watch: https://wildsentia.lol/#animal=african_leopard_12',
    ].join('\n'));
    expect(text).not.toContain(HUNTER_WALLET);
  });

  it('settles a survival and a void', () => {
    const survived = settledAlert(bounty({ status: 'paid', outcome: 'survived', payeeWallet: PREY_WALLET, winnerAnimalId: 'blue_duiker_2011', decideTx: DECIDE_TX }), ctx())!;
    expect(survived).toContain('Bounty won by the prey: 5 USDC.');
    expect(survived).toContain('The target, blue_duiker_2011, survived to the deadline.');
    expect(survived).toContain('Paid to 0x1234…abcd.');
    expect(survived).toContain('Watch: https://wildsentia.lol/#animal=blue_duiker_2011');
    const voided = settledAlert(bounty({ status: 'voided', outcome: 'void', decideTx: DECIDE_TX, killAnimalId: 'african_leopard_12' }), ctx())!;
    expect(voided).toContain('Bounty closed with no winner: 5 USDC back to the pool.');
    expect(voided).toContain('The target was blue_duiker_2011. african_leopard_12 killed it, but the kill did not qualify.');
    expect(voided).toContain(`Return: https://testnet.arcscan.app/tx/${DECIDE_TX}`);
    expect(voided).toContain('Watch: https://wildsentia.lol/#animal=blue_duiker_2011');
    expect(voided).not.toContain('Paid to');
    expect(settledAlert(bounty(), ctx())).toBeNull();
  });

  it('formats amounts, wallets and real durations plainly', () => {
    expect([usdcText(1_000_000n), usdcText(1_500_000n), usdcText(100_000n), usdcText(1n)]).toEqual(['1', '1.5', '0.1', '0.000001']);
    expect(shortWallet('0xAbCd000000000000000000000000000000001234')).toBe('0xAbCd…1234');
    expect([aboutRealTime(1), aboutRealTime(1.5), aboutRealTime(0.25), aboutRealTime(72), aboutRealTime(0)])
      .toEqual(['about 1 hour', 'about 1.5 hours', 'about 15 minutes', 'about 3 days', 'any moment now']);
  });
});

describe('alert settings', () => {
  it('sends nothing unless a destination or a dry run is set', () => {
    expect(notifyConfig({})).toBeNull();
    expect(notifyConfig({ VANA_PUBLIC_ORIGIN: 'https://wildsentia.lol', VANA_NOTIFY_DRY_RUN: '0' })).toBeNull();
    expect(notifyConfig({ VANA_NOTIFY_DRY_RUN: '1' })).toEqual({ discordWebhook: null, telegram: null, origin: null, dryRun: true });
    expect(notifyConfig({ VANA_NOTIFY_DISCORD_WEBHOOK: WEBHOOK, VANA_NOTIFY_TELEGRAM_BOT_TOKEN: BOT_TOKEN, VANA_NOTIFY_TELEGRAM_CHAT_ID: '-1001234',
      VANA_PUBLIC_ORIGIN: 'https://wildsentia.lol/' })).toEqual({ discordWebhook: WEBHOOK, telegram: { token: BOT_TOKEN, chatId: '-1001234' },
      origin: 'https://wildsentia.lol', dryRun: false });
    expect(notifyConfig({ VANA_NOTIFY_DISCORD_WEBHOOK: WEBHOOK.replace('discord.com', 'discordapp.com') })?.discordWebhook).toContain('discordapp.com');
  });

  it('refuses a malformed setting without repeating it', () => {
    for (const bad of ['https://example.com/api/webhooks/1/fixture-webhook-secret', 'http://discord.com/api/webhooks/1/fixture-webhook-secret',
      'https://discord.com.evil.example/api/webhooks/1/fixture-webhook-secret']) {
      expect(() => notifyConfig({ VANA_NOTIFY_DISCORD_WEBHOOK: bad })).toThrow(/^Invalid VANA_NOTIFY_DISCORD_WEBHOOK/);
      try { notifyConfig({ VANA_NOTIFY_DISCORD_WEBHOOK: bad }); } catch (e) { expect(String(e)).not.toContain('fixture-webhook-secret'); }
    }
    expect(() => notifyConfig({ VANA_NOTIFY_TELEGRAM_BOT_TOKEN: BOT_TOKEN })).toThrow(/both/);
    expect(() => notifyConfig({ VANA_NOTIFY_TELEGRAM_BOT_TOKEN: 'not a token', VANA_NOTIFY_TELEGRAM_CHAT_ID: '1' })).toThrow('Invalid VANA_NOTIFY_TELEGRAM_BOT_TOKEN');
    expect(() => notifyConfig({ VANA_NOTIFY_DRY_RUN: '1', VANA_PUBLIC_ORIGIN: 'https://wildsentia.lol/bounties' })).toThrow('Invalid VANA_PUBLIC_ORIGIN');
    expect(() => notifyConfig({ VANA_NOTIFY_DRY_RUN: 'yes' })).toThrow('Invalid VANA_NOTIFY_DRY_RUN');
  });
});

describe('sending alerts', () => {
  it('posts plain content to Discord with every mention disabled', async () => {
    const h = harness(), n = new Notifier(config({ discordWebhook: WEBHOOK }), h.options);
    n.send('@everyone a bounty');
    await n.idle();
    expect(h.calls).toEqual([{ at: 0, url: WEBHOOK, body: { content: '@everyone a bounty', allowed_mentions: { parse: [] } } }]);
    const init = h.fetch.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends Telegram plain text with no parse mode, so nothing needs escaping', async () => {
    const h = harness(), n = new Notifier(config({ telegram: { token: BOT_TOKEN, chatId: '-1001234' } }), h.options);
    n.send('5 USDC <b>on</b> a *blue_duiker* [link](x)');
    await n.idle();
    expect(h.calls).toEqual([{ at: 0, url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      body: { chat_id: '-1001234', text: '5 USDC <b>on</b> a *blue_duiker* [link](x)' } }]);
    expect(h.calls[0]!.body).not.toHaveProperty('parse_mode');
  });

  it('sends in order, at most one a second to each destination, each destination on its own', async () => {
    const h = harness(), n = new Notifier(config({ discordWebhook: WEBHOOK, telegram: { token: BOT_TOKEN, chatId: '42' } }), h.options);
    n.send('one'); n.send('two'); n.send('three');
    await n.idle();
    // The fake clock is shared, so the lanes' sleeps add up: each lane's gaps are at least a second.
    const sent = (dest: string) => h.calls.filter((c) => c.url.includes(dest)).map((c) => ({ text: c.body.content ?? c.body.text, at: c.at }));
    const gaps = (dest: string) => sent(dest).slice(1).map((c, i) => c.at - sent(dest)[i]!.at);
    for (const dest of ['discord', 'telegram']) {
      expect(sent(dest).map((c) => c.text)).toEqual(['one', 'two', 'three']);
      expect(Math.min(...gaps(dest))).toBeGreaterThanOrEqual(1000);
    }
    // An alert queued after the queue ran dry still goes, at least a second after the last.
    n.send('four');
    await n.idle();
    expect(sent('discord').map((c) => c.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(Math.min(...gaps('discord'))).toBeGreaterThanOrEqual(1000);
  });

  it('spaces one destination\'s alerts a second apart', async () => {
    const h = harness(), n = new Notifier(config({ discordWebhook: WEBHOOK }), h.options);
    n.send('one'); n.send('two'); n.send('three');
    await n.idle();
    expect(h.calls.map((c) => [c.body.content, c.at])).toEqual([['one', 0], ['two', 1000], ['three', 2000]]);
  });

  it('retries a 429 after the wait it asks for', async () => {
    const h = harness([() => new Response('{}', { status: 429, headers: { 'Retry-After': '2' } })]);
    const n = new Notifier(config({ discordWebhook: WEBHOOK }), h.options);
    n.send('alert');
    await n.idle();
    expect(h.calls.map((c) => c.at)).toEqual([0, 2000]);
    expect(h.sleeps).toEqual([2000]);
    expect(h.warns).toEqual([]);
    // Telegram's wait is in its body; Discord's may be too.
    expect(retryAfterMs(null, '{"ok":false,"error_code":429,"parameters":{"retry_after":7}}', 0)).toBe(7000);
    expect(retryAfterMs(null, '{"retry_after":1.25}', 0)).toBe(1250);
    expect(retryAfterMs('Tue, 20 Oct 2026 00:00:05 GMT', '', Date.parse('2026-10-20T00:00:00Z'))).toBe(5000);
    expect(retryAfterMs(null, 'not json', 0)).toBeNull();
  });

  it('backs off on 5xx, gives up after a few attempts, logs once, and goes on to the next alert', async () => {
    const h = harness([503, 502, 500, 504].map((status) => () => new Response('busy', { status })));
    const n = new Notifier(config({ discordWebhook: WEBHOOK }), { ...h.options, maxAttempts: 4 });
    n.send('lost'); n.send('next');
    await n.idle();
    expect(h.calls.map((c) => c.body.content)).toEqual(['lost', 'lost', 'lost', 'lost', 'next']);
    expect(h.sleeps.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(h.warns).toEqual(['[notify] discord: gave up on an alert after 4 attempts (status 504)']);
  });

  it('does not retry a refusal, nor wait longer than it should be asked to', async () => {
    const h = harness([() => new Response('{"ok":false}', { status: 400 }),
      () => new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } })]);
    const n = new Notifier(config({ telegram: { token: BOT_TOKEN, chatId: '42' } }), h.options);
    n.send('refused'); n.send('flooded');
    await n.idle();
    expect(h.calls).toHaveLength(2);
    expect(h.warns).toEqual(['[notify] telegram: gave up on an alert after 1 attempt (status 400)',
      '[notify] telegram: gave up on an alert after 1 attempt (status 429, asked to wait 3600 s)']);
  });

  it('never logs the webhook or the bot token, and never throws into the caller', async () => {
    const leak = () => { throw new Error(`connect failed for ${WEBHOOK} and https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`); };
    const h = harness([leak, leak, leak, leak]);
    const n = new Notifier(config({ discordWebhook: WEBHOOK, telegram: { token: BOT_TOKEN, chatId: '42' } }), { ...h.options, maxAttempts: 2 });
    expect(() => n.send('alert')).not.toThrow();
    await n.idle();
    expect(h.warns).toHaveLength(2);
    for (const line of h.warns) {
      expect(line).toMatch(/gave up on an alert after 2 attempts \(network error: connect failed for \[redacted\]/);
      expect(line).not.toContain('fixture-webhook-secret');
      expect(line).not.toContain('fixture-bot-token-secret');
    }
  });

  it('logs the text on a dry run and sends nothing', async () => {
    const h = harness(), n = new Notifier(config({ discordWebhook: WEBHOOK, telegram: { token: BOT_TOKEN, chatId: '42' }, dryRun: true }), h.options);
    n.send('New bounty: 5 USDC');
    await n.idle();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.logs).toEqual(['[notify] dry run: New bounty: 5 USDC']);
  });
});

describe('the bounty engine announcer', () => {
  it('alerts each event once, and the live one without its target', async () => {
    const h = harness(), n = new Notifier(config({ discordWebhook: WEBHOOK }), h.options), announce = arcBountyAnnouncer(n, ctx());
    announce({ kind: 'published', bounty: bounty() });
    announce({ kind: 'published', bounty: bounty() });
    const paid = bounty({ status: 'paid', outcome: 'predator', payeeWallet: HUNTER_WALLET, winnerAnimalId: 'african_leopard_12', decideTx: DECIDE_TX });
    announce({ kind: 'settled', bounty: paid });
    announce({ kind: 'settled', bounty: paid });
    await n.idle();
    const texts = h.calls.map((c) => String(c.body.content));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/^New bounty: 5 USDC/);
    expect(texts[0]).not.toContain('blue_duiker_2011');
    expect(texts[1]).toMatch(/^Bounty won by a hunter/);
    expect(texts[1]).toContain('blue_duiker_2011');
  });

  it('never throws, even when a text cannot be made', () => {
    const n = new Notifier(config({ dryRun: true }), { log: () => undefined });
    const announce = arcBountyAnnouncer(n, ctx({ rate: () => { throw new Error('no host'); } }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => announce({ kind: 'published', bounty: bounty() })).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
