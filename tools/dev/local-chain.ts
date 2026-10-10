/**
 * A local chain for trying Wildsentia Challenges on this machine: deploys the LOCAL TEST STAND-IN
 * USDC, WildsentiaChallenges, WildsentiaAttempts and stand-in ERC-8004 registries to anvil
 * (http://127.0.0.1:8545), funds the creator, and prints the server settings. Anvil's public
 * development keys only; never a real network.
 *
 *   anvil --port 8545 --chain-id 31337 &
 *   (cd contracts && forge build) && npx tsx tools/dev/local-chain.ts > local.env
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = 'http://127.0.0.1:8545';
const KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  evaluator: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  creator: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
} as const;
const artifact = (path: string) => {
  const json = JSON.parse(readFileSync(new URL(`../../contracts/out/${path}`, import.meta.url), 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
};

const client = createPublicClient({ transport: http(RPC) });
if (await client.getChainId() !== 31337) throw new Error('not the local anvil chain');
const owner = createWalletClient({ account: privateKeyToAccount(KEYS.owner), transport: http(RPC), chain: null });
const deploy = async (path: string, args: unknown[]) => {
  const { abi, bytecode } = artifact(path);
  const r = await client.waitForTransactionReceipt({ hash: await owner.deployContract({ abi, bytecode, args, chain: null }) });
  return r.contractAddress!;
};
const evaluator = privateKeyToAccount(KEYS.evaluator).address, creator = privateKeyToAccount(KEYS.creator).address;
const usdc = await deploy('TestUSDC.sol/TestUSDC.json', []);
const contract = await deploy('WildsentiaChallenges.sol/WildsentiaChallenges.json', [usdc, owner.account.address, evaluator, 1_000_000n, 100_000_000n]);
const attempts = await deploy('WildsentiaAttempts.sol/WildsentiaAttempts.json', [owner.account.address, evaluator]);
const identity = await deploy('MockIdentityRegistry.sol/MockIdentityRegistry.json', []);
const reputation = await deploy('MockReputationRegistry.sol/MockReputationRegistry.json', [identity]);
await client.waitForTransactionReceipt({ hash: await owner.writeContract({ address: usdc, abi: artifact('TestUSDC.sol/TestUSDC.json').abi,
  functionName: 'mint', args: [creator, 1_000_000_000n], chain: null }) });
console.log(`# local chain ${RPC}: USDC ${usdc}, identity ${identity}, reputation ${reputation}; creator ${creator} holds 1000 test USDC
VANA_CHALLENGES=1
VANA_CHALLENGES_RPC_URL=${RPC}
VANA_CHALLENGES_CHAIN_ID=31337
VANA_CHALLENGES_CONTRACT=${contract}
VANA_CHALLENGES_ATTEMPTS_CONTRACT=${attempts}
VANA_CHALLENGES_USDC=${usdc}
VANA_CHALLENGES_USDC_DOMAIN_NAME=USDC
VANA_CHALLENGES_USDC_DOMAIN_VERSION=2
VANA_CHALLENGES_EVALUATOR_KEY=${KEYS.evaluator}
VANA_CHALLENGES_FROM_BLOCK=0`);
