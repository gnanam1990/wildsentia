/**
 * WildsentiaBounties on Arc Mainnet: real USDC (docs/2026-11-15-arc-mainnet-readiness.md). Run only
 * after the legal review, by the owner, from their own machine.
 *
 *   npx tsx tools/arc/mainnet.ts <mainnet.env> check          read-only: chain, USDC decimals, balances, the contract if deployed
 *   ARC_MAINNET_CONFIRM=deploy npx tsx tools/arc/mainnet.ts <mainnet.env> deploy
 *                                                            deploy from the owner key, set the contract's caps
 *   ARC_MAINNET_CONFIRM=fund-<usdc> npx tsx tools/arc/mainnet.ts <mainnet.env> fund <usdc>
 *                                                            move that much of the owner's USDC into the pool
 *
 * The file holds ARC_OWNER_KEY and ARC_EVALUATOR_ADDRESS (the Circle wallet that decides bounties,
 * never the owner); `deploy` appends ARC_MAINNET_CONTRACT and ARC_MAINNET_BLOCK. Nothing secret is
 * printed. Each step that spends money needs its own ARC_MAINNET_CONFIRM, naming the amount for
 * `fund`, so an old shell line cannot repeat it by accident. Run `forge build` in contracts/ first.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatUnits, getAddress, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bountiesAbi } from '../../packages/server/src/challenges/bountiesAbi.js';

const RPC = process.env.ARC_RPC ?? 'https://rpc.mainnet.arc.io';
const arc = defineChain({ id: 5042, name: 'Arc Mainnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const USDC = '0x3600000000000000000000000000000000000000' as const;
/**
 * The contract's own limits, below the server's: 0.1 to 5 USDC a bounty, at most 10 USDC paid in a
 * day whatever the server says, and paid only after 10 minutes open. A stolen evaluator key can
 * then take at most a day's cap before the owner pauses settling.
 */
const MIN_AMOUNT = 100_000n, MAX_AMOUNT = 5_000_000n, DAILY_CAP = 10_000_000n, MIN_OPEN_SECONDS = 600n;
/** The most one `fund` may move: a pool larger than this is a decision to make, not a typo to allow. */
const MAX_FUND = 500_000_000n;

const readEnv = (path: string): Record<string, string> => Object.fromEntries(readFileSync(path, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

async function main(): Promise<void> {
  const [file, step, amount] = process.argv.slice(2);
  if (!file || !['check', 'deploy', 'fund'].includes(step ?? '')) throw new Error('usage: npx tsx tools/arc/mainnet.ts <mainnet.env> check|deploy|fund <usdc>');
  const w = readEnv(file);
  const client = createPublicClient({ chain: arc, transport: http(RPC, { timeout: 20_000, retryCount: 2 }) });
  if ((await client.getChainId()) !== arc.id) throw new Error('not Arc Mainnet: refusing');
  if (await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'decimals' }) !== 6) throw new Error('USDC does not count 6 decimals: refusing');
  const owner = privateKeyToAccount(w.ARC_OWNER_KEY as Hex);
  const evaluator = getAddress(w.ARC_EVALUATOR_ADDRESS!);
  if (evaluator === owner.address) throw new Error('owner and evaluator must differ');
  const usdcOf = (a: Hex) => client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
  const contract = w.ARC_MAINNET_CONTRACT ? getAddress(w.ARC_MAINNET_CONTRACT) : null;

  if (step === 'check') {
    console.log(`owner ${owner.address}: ${formatUnits(await usdcOf(owner.address), 6)} USDC`);
    console.log(`evaluator ${evaluator}: ${formatUnits(await usdcOf(evaluator), 6)} USDC (its gas)`);
    if (!contract) { console.log('contract: not deployed'); return; }
    const read = <F extends 'pool' | 'reserved' | 'evaluator' | 'owner' | 'minAmount' | 'maxAmount' | 'settlePaused'>(functionName: F) =>
      client.readContract({ address: contract, abi: bountiesAbi, functionName });
    console.log(`contract ${contract}: pool ${formatUnits(await read('pool'), 6)}, reserved ${formatUnits(await read('reserved'), 6)} USDC; `
      + `bounties ${formatUnits(await read('minAmount'), 6)}-${formatUnits(await read('maxAmount'), 6)} USDC; settling ${await read('settlePaused') ? 'PAUSED' : 'on'}`);
    if (getAddress(await read('evaluator')) !== evaluator) console.log('WARNING: the contract\'s evaluator is not ARC_EVALUATOR_ADDRESS');
    if (getAddress(await read('owner')) !== owner.address) console.log('WARNING: the contract\'s owner is not this key');
    return;
  }

  const wallet = createWalletClient({ chain: arc, transport: http(RPC), account: owner });
  // Fresh fees for every transaction, never cached; Arc's mempool floor is 20 gwei.
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
    if (process.env.ARC_MAINNET_CONFIRM !== 'deploy') throw new Error('set ARC_MAINNET_CONFIRM=deploy to deploy on Arc Mainnet');
    if (contract) throw new Error(`already deployed at ${contract}`);
    const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/WildsentiaBounties.sol/WildsentiaBounties.json', import.meta.url), 'utf8')) as { bytecode: { object: Hex } };
    const hash = await wallet.deployContract({ abi: bountiesAbi, bytecode: artifact.bytecode.object, args: [USDC, owner.address, evaluator, MIN_AMOUNT, MAX_AMOUNT], ...await fees() });
    const deployed = await wait('deployed', hash);
    const address = getAddress(deployed.contractAddress!);
    appendFileSync(file, `ARC_MAINNET_CONTRACT=${address}\nARC_MAINNET_BLOCK=${deployed.blockNumber}\n`);
    console.log(`WildsentiaBounties at ${address}, block ${deployed.blockNumber}`);
    await wait('daily payout cap', await wallet.writeContract({ address, abi: bountiesAbi, functionName: 'setDailyPayoutCap', args: [DAILY_CAP], ...await fees() }));
    await wait('minimum open time', await wallet.writeContract({ address, abi: bountiesAbi, functionName: 'setMinOpenSeconds', args: [MIN_OPEN_SECONDS], ...await fees() }));
    return;
  }

  if (!contract) throw new Error('deploy first');
  if (!amount || !/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error('fund needs an amount in USDC, as 25 or 2.5');
  if (process.env.ARC_MAINNET_CONFIRM !== `fund-${amount}`) throw new Error(`set ARC_MAINNET_CONFIRM=fund-${amount} to move ${amount} USDC into the pool`);
  const atomic = parseUnits(amount, 6);
  if (atomic <= 0n || atomic > MAX_FUND) throw new Error(`fund between 0 and ${formatUnits(MAX_FUND, 6)} USDC at a time`);
  if ((await usdcOf(owner.address)) < atomic) throw new Error('the owner holds less USDC than that');
  await wait('approved', await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [contract, atomic], ...await fees() }));
  await wait(`funded ${amount} USDC`, await wallet.writeContract({ address: contract, abi: bountiesAbi, functionName: 'fund', args: [atomic], ...await fees() }));
  console.log(`pool now ${formatUnits(await client.readContract({ address: contract, abi: bountiesAbi, functionName: 'pool' }), 6)} USDC`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
