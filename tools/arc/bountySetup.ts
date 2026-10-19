/**
 * Sets up WildsentiaBounties on Arc Testnet for the demo (docs/2026-10-19-congo-arc-bounties-design.md).
 *
 *   npx tsx tools/arc/bountySetup.ts <wallets.env> [poolUsdc=10]
 *
 * The wallets file holds ARC_{OWNER,EVALUATOR,TREASURY,HUNTER,PREY}_{ADDRESS,KEY} for Arc Testnet
 * wallets made for this demo; it is never printed. The treasury must hold testnet USDC from the
 * Circle faucet. The script:
 * 1. sends the owner and the evaluator 1 USDC each for gas (Arc's gas is USDC);
 * 2. deploys the contract from the owner with `forge script` (it refuses any chain but Arc Testnet);
 * 3. funds the pool from the treasury;
 * 4. writes ARC_BOUNTIES_CONTRACT back into the wallets file.
 * Run it again and it skips what is done. Testnet only: it refuses any other chain.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.ARC_RPC ?? 'https://rpc.testnet.arc.io';
const ARC_TESTNET = 5042002;
const USDC = getAddress('0x3600000000000000000000000000000000000000');
const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)', 'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)']);
const bountiesAbi = parseAbi(['function fund(uint256 amount)', 'function pool() view returns (uint256)', 'function evaluator() view returns (address)']);

function readEnv(path: string): Record<string, string> {
  return Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('usage: npx tsx tools/arc/bountySetup.ts <wallets.env> [poolUsdc]');
  const poolUsdc = BigInt(process.argv[3] ?? '10');
  const env = readEnv(file);
  const client = createPublicClient({ transport: http(RPC, { timeout: 20_000, retryCount: 2 }) });
  if ((await client.getChainId()) !== ARC_TESTNET) throw new Error('not Arc Testnet: refusing');
  const decimals = await client.readContract({ address: USDC, abi: usdcAbi, functionName: 'decimals' });
  if (decimals !== 6) throw new Error(`USDC's ERC-20 interface reports ${decimals} decimals, expected 6`);
  const unit = 10n ** 6n;
  const account = (role: string) => privateKeyToAccount(env[`ARC_${role}_KEY`] as Hex);
  const wallet = (role: string) => createWalletClient({ account: account(role), transport: http(RPC), chain: null });
  const balance = (who: Hex) => client.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [who] });
  const show = async (label: string) => {
    for (const role of ['TREASURY', 'OWNER', 'EVALUATOR', 'HUNTER', 'PREY']) {
      console.log(`${label} ${role.toLowerCase().padEnd(9)} ${account(role).address} ${(Number(await balance(account(role).address)) / 1e6).toFixed(6)} USDC`);
    }
  };
  const send = async (role: string, to: Hex, abi: typeof usdcAbi | typeof bountiesAbi, functionName: string, args: unknown[]) => {
    const block = await client.getBlock({ blockTag: 'latest' });
    // Fresh fees every time, at least Arc's 20 Gwei floor.
    const fee = (block.baseFeePerGas ?? 0n) * 2n + 1_000_000_000n;
    const hash = await wallet(role).writeContract({ address: to, abi, functionName, args, chain: null,
      maxFeePerGas: fee > 20_000_000_000n ? fee : 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n } as never);
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    console.log(`  ${functionName} ${hash}`);
  };
  await show('before');
  const treasury = account('TREASURY').address;
  if ((await balance(treasury)) < poolUsdc * unit + 2n * unit) throw new Error(`the treasury ${treasury} needs at least ${poolUsdc + 2n} USDC from the faucet`);

  // 1. Gas for the owner and the evaluator.
  for (const role of ['OWNER', 'EVALUATOR']) {
    if ((await balance(account(role).address)) < unit / 2n) await send('TREASURY', USDC, usdcAbi, 'transfer', [account(role).address, unit]);
  }

  // 2. The contract, from the owner, through the deploy script's checks.
  let contract = env.ARC_BOUNTIES_CONTRACT as Hex | undefined;
  if (!contract) {
    const contracts = fileURLToPath(new URL('../../contracts', import.meta.url));
    const run = spawnSync('forge', ['script', 'script/DeployBounties.s.sol', '--rpc-url', RPC, '--private-key', env.ARC_OWNER_KEY!, '--broadcast', '--slow'], {
      cwd: contracts, encoding: 'utf8',
      env: { ...process.env, BOUNTIES_USDC: USDC, BOUNTIES_OWNER: account('OWNER').address, BOUNTIES_EVALUATOR: account('EVALUATOR').address,
        BOUNTIES_MIN_AMOUNT: String(unit / 10n), BOUNTIES_MAX_AMOUNT: String(100n * unit) },
    });
    const address = /Contract Address: (0x[0-9a-fA-F]{40})|0: contract WildsentiaBounties (0x[0-9a-fA-F]{40})/.exec(run.stdout ?? '');
    if (run.status !== 0 || !address) throw new Error(`deploy failed:\n${(run.stdout ?? '').slice(-1500)}\n${(run.stderr ?? '').slice(-1500)}`);
    contract = getAddress((address[1] ?? address[2])!) as Hex;
    appendFileSync(file, `ARC_BOUNTIES_CONTRACT=${contract}\n`);
    console.log(`  deployed WildsentiaBounties ${contract}`);
  }
  const evaluator = await client.readContract({ address: contract, abi: bountiesAbi, functionName: 'evaluator' });
  if (getAddress(evaluator) !== account('EVALUATOR').address) throw new Error('the contract has another evaluator');

  // 3. The pool.
  const pool = await client.readContract({ address: contract, abi: bountiesAbi, functionName: 'pool' });
  if (pool < poolUsdc * unit) {
    const amount = poolUsdc * unit - pool;
    await send('TREASURY', USDC, usdcAbi, 'approve', [contract, amount]);
    await send('TREASURY', contract, bountiesAbi, 'fund', [amount]);
  }
  console.log(`contract ${contract}, pool ${(Number(await client.readContract({ address: contract, abi: bountiesAbi, functionName: 'pool' })) / 1e6).toFixed(6)} USDC`);
  await show('after ');
}

main().catch((error: unknown) => { console.error(String((error as Error).message ?? error)); process.exit(1); });
