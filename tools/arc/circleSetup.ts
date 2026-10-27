/**
 * Makes a Circle developer-controlled wallet the bounty contract's evaluator, on Arc Testnet
 * (docs/2026-10-22-circle-evaluator.md).
 *
 *   npx tsx tools/arc/circleSetup.ts <circle.env> <wallets.env>             make the wallet (once), show its gas
 *   npx tsx tools/arc/circleSetup.ts <circle.env> <wallets.env> --appoint   then setEvaluator to it, from the owner key
 *
 * Done by hand first, in Circle's Console (developers.circle.com): an account, a testnet API key
 * (TEST_API_KEY:…, Wallets read/write), and an entity secret registered there, its recovery file
 * kept apart from it. The circle.env file holds VANA_CIRCLE_API_KEY and VANA_CIRCLE_ENTITY_SECRET;
 * this writes VANA_CIRCLE_WALLET_SET_ID, VANA_CIRCLE_WALLET_ID and VANA_CIRCLE_WALLET_ADDRESS back
 * into it. The wallets file holds ARC_OWNER_KEY and ARC_BOUNTIES_CONTRACT. Nothing secret is printed.
 * Run it again and it skips what is done (Circle's idempotency keys are drawn from the file's path).
 * Fund the wallet's gas from faucet.circle.com (Arc Testnet) before --appoint. Testnet only.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, formatEther, getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { circleSigner, idempotencyUuid } from '../../packages/server/src/arcBounties/circle.js';

const RPC = process.env.ARC_RPC ?? 'https://rpc.testnet.arc.io';
const BASE = process.env.VANA_CIRCLE_BASE_URL ?? 'https://api.circle.com';
const arc = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const bounties = parseAbi(['function evaluator() view returns (address)', 'function setEvaluator(address next)', 'function owner() view returns (address)']);

const readEnv = (path: string): Record<string, string> => Object.fromEntries(readFileSync(path, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

async function circle<T>(apiKey: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json().catch(() => ({})) as { data?: T; message?: string };
  if (!res.ok) throw new Error(`Circle ${method} ${path} failed: ${res.status} ${json.message ?? ''}`);
  return json.data as T;
}

async function main(): Promise<void> {
  const [circleFile, walletsFile] = process.argv.slice(2);
  if (!circleFile || !walletsFile) throw new Error('usage: npx tsx tools/arc/circleSetup.ts <circle.env> <wallets.env> [--appoint]');
  const c = readEnv(circleFile), w = readEnv(walletsFile);
  const apiKey = c.VANA_CIRCLE_API_KEY, entitySecret = c.VANA_CIRCLE_ENTITY_SECRET;
  if (!apiKey?.startsWith('TEST_API_KEY:')) throw new Error('VANA_CIRCLE_API_KEY must be a testnet key (TEST_API_KEY:…)');
  if (!entitySecret) throw new Error('VANA_CIRCLE_ENTITY_SECRET is missing');
  const client = createPublicClient({ chain: arc, transport: http(RPC) });
  if ((await client.getChainId()) !== arc.id) throw new Error('not Arc Testnet: refusing');
  const ciphertext = () => circleSigner({ apiKey, entitySecret, walletId: '-', walletAddress: '0x0000000000000000000000000000000000000001', baseUrl: BASE }).ciphertext();

  let walletId = c.VANA_CIRCLE_WALLET_ID, address = c.VANA_CIRCLE_WALLET_ADDRESS;
  if (!walletId || !address) {
    let setId = c.VANA_CIRCLE_WALLET_SET_ID;
    if (!setId) {
      const set = await circle<{ walletSet: { id: string } }>(apiKey, 'POST', '/v1/w3s/developer/walletSets',
        { idempotencyKey: idempotencyUuid(`${circleFile}:walletSet`), name: 'Wildsentia evaluator', entitySecretCiphertext: await ciphertext() });
      setId = set.walletSet.id;
      appendFileSync(circleFile, `VANA_CIRCLE_WALLET_SET_ID=${setId}\n`);
    }
    const made = await circle<{ wallets: Array<{ id: string; address: string; blockchain: string; accountType: string }> }>(apiKey, 'POST', '/v1/w3s/developer/wallets',
      { idempotencyKey: idempotencyUuid(`${circleFile}:wallet`), walletSetId: setId, blockchains: ['ARC-TESTNET'], count: 1, accountType: 'EOA', entitySecretCiphertext: await ciphertext() });
    const wallet = made.wallets[0]!;
    if (wallet.blockchain !== 'ARC-TESTNET' || wallet.accountType !== 'EOA') throw new Error(`unexpected wallet: ${wallet.blockchain} ${wallet.accountType}`);
    walletId = wallet.id; address = getAddress(wallet.address);
    appendFileSync(circleFile, `VANA_CIRCLE_WALLET_ID=${walletId}\nVANA_CIRCLE_WALLET_ADDRESS=${address}\n`);
    console.log(`made the Circle wallet ${walletId} (${address}) on ARC-TESTNET`);
  }
  const gas = await client.getBalance({ address: address as Hex });
  console.log(`evaluator wallet ${address}: ${formatEther(gas)} USDC of gas${gas < 10n ** 17n ? ' (low: fund it at faucet.circle.com, Arc Testnet)' : ''}`);

  const contract = getAddress(w.ARC_BOUNTIES_CONTRACT!);
  const current = await client.readContract({ address: contract, abi: bounties, functionName: 'evaluator' });
  if (current.toLowerCase() === address!.toLowerCase()) { console.log('it is already the contract\'s evaluator'); return; }
  if (!process.argv.includes('--appoint')) { console.log(`the contract's evaluator is still ${current}: run again with --appoint`); return; }
  if (gas < 10n ** 16n) throw new Error('fund the wallet\'s gas before appointing it');
  const owner = privateKeyToAccount(w.ARC_OWNER_KEY as Hex);
  if ((await client.readContract({ address: contract, abi: bounties, functionName: 'owner' })).toLowerCase() !== owner.address.toLowerCase()) throw new Error('ARC_OWNER_KEY is not the contract owner');
  const base = (await client.getBlock()).baseFeePerGas ?? 20_000_000_000n;
  const hash = await createWalletClient({ chain: arc, transport: http(RPC), account: owner }).writeContract({ address: contract, abi: bounties,
    functionName: 'setEvaluator', args: [address as Hex], maxFeePerGas: base * 2n + 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  const r = await client.waitForTransactionReceipt({ hash });
  console.log(`setEvaluator(${address}): ${r.status} (${hash})`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
