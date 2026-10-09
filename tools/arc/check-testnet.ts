/**
 * Read-only checks of Arc Testnet before plan 4 deploys anything (docs/2026-10-09-challenges-design.md §12).
 * It sends no transaction and needs no key: only eth_chainId, eth_call, eth_getCode and eth_getStorageAt.
 *
 *   npx tsx tools/arc/check-testnet.ts [rpcUrl]      (default https://rpc.testnet.arc.io)
 *
 * It reports what the server's VANA_CHALLENGES_USDC_DOMAIN_NAME / _VERSION must be, and whether the
 * USDC token implements receiveWithAuthorization with a bytes signature, which createWithAuthorization calls.
 */
import { createPublicClient, encodeAbiParameters, getAddress, http, keccak256, parseAbi, toFunctionSelector, toHex, type Hex } from 'viem';

const ARC_TESTNET = 5042002;
const USDC = getAddress('0x3600000000000000000000000000000000000000');
const EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const FIAT_TOKEN_PROXY_IMPLEMENTATION = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const abi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function version() view returns (string)', 'function DOMAIN_SEPARATOR() view returns (bytes32)']);

async function main(): Promise<void> {
  const url = process.argv[2] ?? 'https://rpc.testnet.arc.io';
  const client = createPublicClient({ transport: http(url, { timeout: 15_000, retryCount: 1 }) });
  const report: Record<string, unknown> = { rpc: url };
  const chainId = await client.getChainId();
  report.chainId = chainId;
  report.isArcTestnet = chainId === ARC_TESTNET;
  const read = async <T>(fn: 'name' | 'symbol' | 'decimals' | 'version' | 'DOMAIN_SEPARATOR'): Promise<T | null> => {
    try { return await client.readContract({ address: USDC, abi, functionName: fn }) as T; } catch { return null; }
  };
  const [name, symbol, decimals, version, separator] = await Promise.all([read<string>('name'), read<string>('symbol'), read<number>('decimals'),
    read<string>('version'), read<Hex>('DOMAIN_SEPARATOR')]);
  Object.assign(report, { usdc: { address: USDC, name, symbol, decimals, version, domainSeparator: separator } });
  // The EIP-712 domain the server signs for: it must reproduce the token's own separator.
  if (name && version && separator) {
    const expected = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [
      keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
      keccak256(toHex(name)), keccak256(toHex(version)), BigInt(chainId), USDC]));
    report.domainMatches = expected === separator;
    report.serverSettings = { VANA_CHALLENGES_USDC_DOMAIN_NAME: name, VANA_CHALLENGES_USDC_DOMAIN_VERSION: version };
  }
  // Which code answers for the token: the proxy's implementation if there is one, else the address itself.
  let codeAt: Hex = USDC;
  for (const slot of [EIP1967_IMPLEMENTATION, FIAT_TOKEN_PROXY_IMPLEMENTATION] as const) {
    const word = await client.getStorageAt({ address: USDC, slot });
    if (word && BigInt(word) !== 0n) { codeAt = getAddress(`0x${word.slice(-40)}`); break; }
  }
  const code = (await client.getCode({ address: codeAt })) ?? '0x';
  const has = (signature: string) => code.toLowerCase().includes(toFunctionSelector(signature).slice(2));
  report.code = { address: codeAt, bytes: (code.length - 2) / 2,
    receiveWithAuthorizationBytes: has('function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'),
    receiveWithAuthorizationVRS: has('function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)'),
    transferWithAuthorizationBytes: has('function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)') };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('check failed:', (e as Error).message.split('\n')[0]); process.exit(1); });
