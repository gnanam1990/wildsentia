/**
 * Moves the Arc bounties to WildsentiaBounties version 2 on Arc Testnet (docs/2026-10-29-bounties-v2.md).
 *
 *   npx tsx tools/arc/bountiesV2.ts <wallets.env> deploy    deploy v2 from the owner key, set its daily cap and minimum open time
 *   npx tsx tools/arc/bountiesV2.ts <wallets.env> move      pause v1, withdraw its unreserved pool and fund v2 with it
 *
 * The wallets file holds ARC_OWNER_KEY, ARC_BOUNTIES_CONTRACT (v1) and ARC_EVALUATOR_ADDRESS; `deploy`
 * appends ARC_BOUNTIES_V2_CONTRACT and ARC_BOUNTIES_V2_BLOCK to it. Nothing secret is printed.
 * Run `forge build` in contracts/ first. Testnet only.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatUnits, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bountiesAbi } from '../../packages/server/src/challenges/bountiesAbi.js';

const RPC = process.env.ARC_RPC ?? 'https://rpc.testnet.arc.io';
const arc = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const USDC = '0x3600000000000000000000000000000000000000' as const;
/**
 * v2's settings: v1's smallest bounty, at most 5 USDC a bounty (v1 allowed 100, above the cap), at most
 * 10 USDC paid a day (as the server's own cap), paid only after 10 minutes open.
 */
const MAX_AMOUNT = 5_000_000n, DAILY_CAP = 10_000_000n, MIN_OPEN_SECONDS = 600n;

const readEnv = (path: string): Record<string, string> => Object.fromEntries(readFileSync(path, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

async function main(): Promise<void> {
  const [file, step] = process.argv.slice(2);
  if (!file || (step !== 'deploy' && step !== 'move')) throw new Error('usage: npx tsx tools/arc/bountiesV2.ts <wallets.env> deploy|move');
  const w = readEnv(file);
  const client = createPublicClient({ chain: arc, transport: http(RPC) });
  if ((await client.getChainId()) !== arc.id) throw new Error('not Arc Testnet: refusing');
  const owner = privateKeyToAccount(w.ARC_OWNER_KEY as Hex);
  const wallet = createWalletClient({ chain: arc, transport: http(RPC), account: owner });
  // Fresh fees for every transaction, never cached.
  const fees = async () => {
    const base = (await client.getBlock()).baseFeePerGas ?? 20_000_000_000n;
    return { maxFeePerGas: base * 2n + 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  };
  const wait = async (what: string, hash: Hex) => {
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${what} reverted (${hash})`);
    console.log(`${what}: ${hash}`);
    return r;
  };

  if (step === 'deploy') {
    if (w.ARC_BOUNTIES_V2_CONTRACT) throw new Error(`v2 is already deployed at ${w.ARC_BOUNTIES_V2_CONTRACT}`);
    const evaluator = getAddress(w.ARC_EVALUATOR_ADDRESS!);
    if (evaluator === owner.address) throw new Error('owner and evaluator must differ');
    if (await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'decimals' }) !== 6) throw new Error('USDC does not count 6 decimals');
    const v1 = getAddress(w.ARC_BOUNTIES_CONTRACT!);
    const min = await client.readContract({ address: v1, abi: bountiesAbi, functionName: 'minAmount' });
    if (min > MAX_AMOUNT) throw new Error(`v1's smallest bounty (${formatUnits(min, 6)} USDC) is above ${formatUnits(MAX_AMOUNT, 6)} USDC`);
    const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/WildsentiaBounties.sol/WildsentiaBounties.json', import.meta.url), 'utf8')) as { bytecode: { object: Hex } };
    const hash = await wallet.deployContract({ abi: bountiesAbi, bytecode: artifact.bytecode.object, args: [USDC, owner.address, evaluator, min, MAX_AMOUNT], ...await fees() });
    const deployed = await wait('deployed v2', hash);
    const address = getAddress(deployed.contractAddress!);
    appendFileSync(file, `ARC_BOUNTIES_V2_CONTRACT=${address}\nARC_BOUNTIES_V2_BLOCK=${deployed.blockNumber}\n`);
    console.log(`v2 at ${address}, block ${deployed.blockNumber}`);
    await wait('daily payout cap', await wallet.writeContract({ address, abi: bountiesAbi, functionName: 'setDailyPayoutCap', args: [DAILY_CAP], ...await fees() }));
    await wait('minimum open time', await wallet.writeContract({ address, abi: bountiesAbi, functionName: 'setMinOpenSeconds', args: [MIN_OPEN_SECONDS], ...await fees() }));
    return;
  }

  const v1 = getAddress(w.ARC_BOUNTIES_CONTRACT!), v2 = getAddress(w.ARC_BOUNTIES_V2_CONTRACT!);
  const read = (address: Hex, functionName: 'pool' | 'reserved') => client.readContract({ address, abi: bountiesAbi, functionName });
  if ((await read(v1, 'reserved')) > 0n) console.log(`v1 still reserves ${formatUnits(await read(v1, 'reserved'), 6)} USDC for open bounties: they return to its pool as they expire; run move again then`);
  if (!(await client.readContract({ address: v1, abi: bountiesAbi, functionName: 'settlePaused' })))
    await wait('paused v1', await wallet.writeContract({ address: v1, abi: bountiesAbi, functionName: 'setSettlePaused', args: [true], ...await fees() }));
  const pool = await read(v1, 'pool');
  if (pool > 0n) {
    await wait(`withdrew ${formatUnits(pool, 6)} USDC from v1`, await wallet.writeContract({ address: v1, abi: bountiesAbi, functionName: 'withdraw', args: [pool, owner.address], ...await fees() }));
    await wait('approved v2', await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [v2, pool], ...await fees() }));
    await wait(`funded v2 with ${formatUnits(pool, 6)} USDC`, await wallet.writeContract({ address: v2, abi: bountiesAbi, functionName: 'fund', args: [pool], ...await fees() }));
  }
  console.log(`v1 pool ${formatUnits(await read(v1, 'pool'), 6)}, v2 pool ${formatUnits(await read(v2, 'pool'), 6)} USDC`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
