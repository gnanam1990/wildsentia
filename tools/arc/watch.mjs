#!/usr/bin/env node
/**
 * Watches the Arc bounty contract from outside the server (the security audit of 22 October 2026, #14):
 * run on a schedule by .github/workflows/arc-watch.yml, it exits 1 with each alert when
 *   - the contract's evaluator or owner is not the expected one, an ownership transfer is pending,
 *     settling is paused, or the pool holds less than it has reserved;
 *   - the evaluator's gas is low;
 *   - in the window it reads, the evaluator, the pause, the amount limits, the daily payout cap, the
 *     minimum open time or the owner changed, an evaluator was revoked, or USDC was withdrawn;
 *   - a bounty was published, paid, voided or expired that the server does not know.
 * No dependencies and no keys: it reads the chain over JSON-RPC and the server's public API.
 *
 *   ARC_WATCH_CONTRACT, ARC_WATCH_EVALUATOR, ARC_WATCH_OWNER   the contract and the addresses it should have
 *   ARC_WATCH_API          the server's public API (https://wildsentia.lol/api)
 *   ARC_WATCH_RPC          JSON-RPC URLs, comma-separated, tried in turn (default the public Arc Testnet RPC)
 *   ARC_WATCH_MINUTES      how far back to read events (default 90: an hourly run, with room for a late one)
 *   ARC_WATCH_MIN_GAS      the evaluator's least gas, in USDC (default 0.05)
 *
 * A bounty the local demo publishes to the same contract is unknown to production, so it alerts too.
 */
import { pathToFileURL } from 'node:url';

export const TOPICS = {
  Withdrawn: '0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5',
  BountyPublished: '0x05cc70baf02e1931e8fa98ef180a96fb95cf8603c8e15bdb685ea6ef28b285b9',
  BountyPaid: '0x784d016c167c46642d5a8462bfc361487b091b326750bd0209a858b808f9635e',
  BountyVoided: '0xdad5a25464614df46b03f4f8a83c6ce47ceb10636ccfd5d49788a4e0ef6ab098',
  BountyExpired: '0x5977e8df15c387bddcbb90913066308cd59f6c427319ec29b29b1176bbe6663a',
  EvaluatorChanged: '0xf123b2ca76dd3e13505bd7272d4eafce9711986e959202c35245b1a85b6bd8c7',
  SettlePausedSet: '0xb0bcc4fd215faab58ecb617bdb4481b021ada0c5e32b0e3f0e1139c02e0ae17c',
  AmountLimitsSet: '0x4140e92c22042c445832c178477bbc18c5f562bbd3824600cf3554eba2bbcf14',
  OwnershipTransferStarted: '0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700',
  OwnershipTransferred: '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0',
  // Version 2 (docs/2026-10-29-bounties-v2.md).
  DailyPayoutCapSet: '0x4995113b5be0caba8a4cdfee51cd7752af9d8be0a7aae646041e6694379e917b',
  MinOpenSecondsSet: '0x6a34b76d3e3c32bca305c1fdca24c227960c4831aacd9080424225bae1737474',
  EvaluatorRevoked: '0x718b73897cc8631ec09c3e42bd021b9e75bdeab3f6918333c917aeea888dfff8',
};
export const SELECTORS = { evaluator: '0x9cb93dd1', owner: '0x8da5cb5b', pendingOwner: '0xe30c3978', settlePaused: '0xb9301c0d', pool: '0x16f0115b', reserved: '0xfe60d12c' };
/** Events that are always the owner's own doing, so always worth a look. */
const OWNER_EVENTS = ['Withdrawn', 'EvaluatorChanged', 'SettlePausedSet', 'AmountLimitsSet', 'OwnershipTransferStarted', 'OwnershipTransferred',
  'DailyPayoutCapSet', 'MinOpenSecondsSet', 'EvaluatorRevoked'];
const BOUNTY_EVENTS = ['BountyPublished', 'BountyPaid', 'BountyVoided', 'BountyExpired'];
/** Arc Testnet's public RPC refuses a log range much wider than this. */
const LOG_SPAN = 2000;
const ZERO = `0x${'0'.repeat(40)}`;

const address = (word) => `0x${word.slice(-40)}`.toLowerCase();
const hex = (n) => `0x${n.toString(16)}`;

/**
 * A JSON-RPC caller over the URLs in turn: the next one answers when one fails. A rate-limited
 * round is tried again after a pause (the public RPC limits bursts of log reads).
 */
export function rpcOver(urls, fetchImpl = fetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  return async (method, params) => {
    let last;
    for (let round = 0; round < 5; round++) {
      if (round) await pause(1500 * round);
      for (const url of urls) {
        try {
          const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
          const json = await res.json();
          if (json.error) throw new Error(`${method}: ${json.error.message ?? json.error.code}`);
          return json.result;
        } catch (error) { last = error; }
      }
      if (!/limit|429|too many/i.test(String(last?.message))) break;
    }
    throw last ?? new Error(`${method}: no RPC URL`);
  };
}

/** Reads the contract, its recent events and the server, and returns what is wrong. */
export async function watch(config, { rpc, known }) {
  const alerts = [], notes = [];
  const read = async (name) => rpc('eth_call', [{ to: config.contract, data: SELECTORS[name] }, 'latest']);
  const [evaluator, owner, pendingOwner, paused, pool, reserved] = await Promise.all(
    ['evaluator', 'owner', 'pendingOwner', 'settlePaused', 'pool', 'reserved'].map(read));
  if (address(evaluator) !== config.evaluator.toLowerCase()) alerts.push(`the evaluator is ${address(evaluator)}, not ${config.evaluator}`);
  if (address(owner) !== config.owner.toLowerCase()) alerts.push(`the owner is ${address(owner)}, not ${config.owner}`);
  if (address(pendingOwner) !== ZERO) alerts.push(`an ownership transfer to ${address(pendingOwner)} is pending`);
  if (BigInt(paused) !== 0n) alerts.push('settling is paused');
  if (BigInt(pool) < BigInt(reserved)) alerts.push(`the pool (${BigInt(pool)}) holds less than it has reserved (${BigInt(reserved)})`);
  notes.push(`pool ${Number(BigInt(pool)) / 1e6} USDC, reserved ${Number(BigInt(reserved)) / 1e6} USDC`);

  // Arc's native balance counts 18 decimals.
  const gas = BigInt(await rpc('eth_getBalance', [address(evaluator), 'latest']));
  notes.push(`evaluator gas ${Number(gas) / 1e18} USDC`);
  if (gas < BigInt(Math.round(config.minGasUsdc * 1e6)) * 10n ** 12n) alerts.push(`the evaluator has ${Number(gas) / 1e18} USDC of gas, under ${config.minGasUsdc}`);

  const head = BigInt(await rpc('eth_blockNumber', []));
  const headBlock = await rpc('eth_getBlockByNumber', [hex(head), false]);
  const back = await rpc('eth_getBlockByNumber', [hex(head > 10_000n ? head - 10_000n : 0n), false]);
  const perBlock = Math.max(0.05, (Number(BigInt(headBlock.timestamp)) - Number(BigInt(back.timestamp))) / Number(head > 10_000n ? 10_000n : head || 1n));
  const from = head - BigInt(Math.ceil(config.minutes * 60 / perBlock));
  const logs = [];
  for (let start = from > 0n ? from : 0n; start <= head; start += BigInt(LOG_SPAN)) {
    const end = start + BigInt(LOG_SPAN) - 1n < head ? start + BigInt(LOG_SPAN) - 1n : head;
    logs.push(...await rpc('eth_getLogs', [{ address: config.contract, fromBlock: hex(start), toBlock: hex(end) }]));
  }
  notes.push(`${logs.length} contract events in blocks ${from}-${head} (about ${config.minutes} minutes)`);
  const nameOf = new Map(Object.entries(TOPICS).map(([name, topic]) => [topic, name]));
  for (const log of logs) {
    const name = nameOf.get(log.topics[0]);
    const tx = `tx ${log.transactionHash}`;
    if (OWNER_EVENTS.includes(name)) alerts.push(`${name} in block ${BigInt(log.blockNumber)} (${tx})`);
    if (BOUNTY_EVENTS.includes(name) && !await known(log.topics[1])) alerts.push(`${name} for a bounty the server does not know: ${log.topics[1]} (${tx})`);
  }
  return { alerts, notes };
}

/** Whether the server's public API knows a bounty. */
export const knownTo = (api, fetchImpl = fetch) => async (bountyId) => {
  const res = await fetchImpl(`${api.replace(/\/+$/, '')}/congo/arc-bounties/${bountyId}`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`the server answered ${res.status} for bounty ${bountyId}`);
  return true;
};

async function main() {
  const env = process.env, need = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const config = { contract: need('ARC_WATCH_CONTRACT'), evaluator: need('ARC_WATCH_EVALUATOR'), owner: need('ARC_WATCH_OWNER'),
    minutes: Number(env.ARC_WATCH_MINUTES || 90), minGasUsdc: Number(env.ARC_WATCH_MIN_GAS || 0.05) };
  const rpc = rpcOver((env.ARC_WATCH_RPC || 'https://rpc.testnet.arc.io').split(',').map((u) => u.trim()).filter(Boolean));
  if (BigInt(await rpc('eth_chainId', [])) !== 5042002n) throw new Error('the RPC is not Arc Testnet');
  const { alerts, notes } = await watch(config, { rpc, known: knownTo(need('ARC_WATCH_API')) });
  for (const note of notes) console.log(note);
  for (const alert of alerts) console.log(`ALERT: ${alert}`);
  if (alerts.length) process.exit(1);
  console.log('all as expected');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error(`the watch could not run: ${error.message}`); process.exit(2); });
}
