import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { challengesAbi } from '../src/challenges/challengesAbi.js';

/**
 * A local chain for the challenge tests: anvil, with the LOCAL TEST STAND-IN USDC
 * (contracts/test/mocks/TestUSDC.sol) and WildsentiaChallenges deployed from Foundry's build
 * output. Needs `forge build` in contracts/ (the regression gate runs `forge test` first).
 * The keys are anvil's public development keys: never funded anywhere real.
 */

export const ANVIL_KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  evaluator: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  creator: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  player: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} as const satisfies Record<string, Hex>;
export const CHAIN_ID = 31_337;

/** True if anvil runs here. The regression gate (VANA_REQUIRE_TEST_DATABASE=1) requires it. */
export function anvilAvailable(): boolean {
  const ok = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!ok && process.env.VANA_REQUIRE_TEST_DATABASE === '1') throw new Error('anvil is required for the challenge chain tests; install Foundry');
  return ok;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

const artifact = (path: string): { abi: unknown[]; bytecode: Hex } => {
  const json = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../contracts/out/${path}`, import.meta.url)), 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode.object };
};

export interface LocalChain {
  /** WildsentiaAttempts, with the evaluator as its recorder. */
  url: string; usdc: Hex; contract: Hex; attempts: Hex;
  addresses: { owner: Hex; evaluator: Hex; creator: Hex; player: Hex };
  stop(): void;
  mine(seconds: number): Promise<void>;
}

export async function startLocalChain(): Promise<LocalChain> {
  const port = await freePort();
  const proc: ChildProcess = spawn('anvil', ['--port', String(port), '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ transport: http(url) });
  for (let i = 0; ; i++) {
    try { await client.getBlockNumber(); break; } catch { if (i > 100) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 100)); }
  }
  const acct = Object.fromEntries(Object.entries(ANVIL_KEYS).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<keyof typeof ANVIL_KEYS, ReturnType<typeof privateKeyToAccount>>;
  const wallet = (who: keyof typeof ANVIL_KEYS) => createWalletClient({ account: acct[who], transport: http(url), chain: null });
  const deploy = async (path: string, args: unknown[]): Promise<Hex> => {
    const { abi, bytecode } = artifact(path);
    const hash = await wallet('owner').deployContract({ abi, bytecode, args, chain: null });
    const r = await client.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  };
  const usdc = await deploy('TestUSDC.sol/TestUSDC.json', []);
  const contract = await deploy('WildsentiaChallenges.sol/WildsentiaChallenges.json',
    [usdc, acct.owner.address, acct.evaluator.address, 1_000_000n, 100_000_000n]);
  const attempts = await deploy('WildsentiaAttempts.sol/WildsentiaAttempts.json', [acct.owner.address, acct.evaluator.address]);
  const usdcAbi = artifact('TestUSDC.sol/TestUSDC.json').abi;
  const mint = await wallet('owner').writeContract({ address: usdc, abi: usdcAbi, functionName: 'mint', args: [acct.creator.address, 1_000_000_000n], chain: null });
  await client.waitForTransactionReceipt({ hash: mint });
  void challengesAbi;
  return {
    url, usdc, contract, attempts,
    addresses: { owner: acct.owner.address, evaluator: acct.evaluator.address, creator: acct.creator.address, player: acct.player.address },
    stop: () => { proc.kill('SIGKILL'); },
    async mine(seconds) {
      await client.request({ method: 'evm_increaseTime' as never, params: [seconds] as never });
      await client.request({ method: 'evm_mine' as never, params: [] as never });
    },
  };
}

/** The creator's EIP-712 ReceiveWithAuthorization for the stand-in USDC (domain "USDC", "2"). */
export async function signReceive(chain: LocalChain, a: { value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }): Promise<Hex> {
  return privateKeyToAccount(ANVIL_KEYS.creator).signTypedData({
    domain: { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: chain.usdc },
    types: { ReceiveWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    primaryType: 'ReceiveWithAuthorization',
    message: { from: chain.addresses.creator, to: chain.contract, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce },
  });
}

export const usdcBalance = async (chain: LocalChain, who: Hex): Promise<bigint> =>
  createPublicClient({ transport: http(chain.url) }).readContract({ address: chain.usdc, abi: artifact('TestUSDC.sol/TestUSDC.json').abi,
    functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
