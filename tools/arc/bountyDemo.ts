/**
 * The Congo bounty flow on Arc Testnet, end to end (docs/2026-10-19-congo-arc-bounties-design.md),
 * against a running Congo server with VANA_ARC_BOUNTIES=1 and VANA_CONGO_OPEN_PLAY=1, and
 * VANA_ARC_BOUNTIES_RANDOM_CROWD=1 (its one steered duiker is no crowd to hide in).
 *
 *   npx tsx tools/arc/bountyDemo.ts <wallets.env> <hunt|survive> [serverUrl=http://127.0.0.1:8090]
 *
 * Two AI agents register and prove the demo's hunter and prey wallets. One steers a leopard, the
 * other the blue duiker nearest it. The operator puts a bounty on a prey animal picked at random
 * (here the only one an agent with a wallet steers). Then:
 * - hunt: the leopard's agent stalks and hunts it, and is paid if it kills it;
 * - survive: the duiker's agent keeps it alive through a short window, and is paid at the deadline.
 * The script prints each Arc transaction and the wallets' USDC before and after.
 * Needs ARC_BOUNTIES_ADMIN_TOKEN in the wallets file (the server's VANA_ARC_BOUNTIES_ADMIN_TOKEN).
 */
import { generateKeyPairSync, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createPublicClient, getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signingString } from '../../packages/server/src/live/signing.js';
import { walletProofMessage } from '../../packages/server/src/live/routes.js';

const RPC = process.env.ARC_RPC ?? 'https://rpc.testnet.arc.io';
const USDC = getAddress('0x3600000000000000000000000000000000000000');
const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const [file, mode = 'hunt', server = 'http://127.0.0.1:8090'] = process.argv.slice(2);
if (!file || (mode !== 'hunt' && mode !== 'survive')) throw new Error('usage: npx tsx tools/arc/bountyDemo.ts <wallets.env> <hunt|survive> [serverUrl]');
const env = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const adminToken = env.ARC_BOUNTIES_ADMIN_TOKEN;
if (!adminToken) throw new Error('ARC_BOUNTIES_ADMIN_TOKEN is missing from the wallets file');
const chain = createPublicClient({ transport: http(RPC, { timeout: 20_000, retryCount: 2 }) });
const usdcOf = async (who: string) => Number(await chain.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [who as Hex] })) / 1e6;

interface Agent { role: 'HUNTER' | 'PREY'; key: KeyObject; publicKey: string; id?: string }
/** The agent's Ed25519 key, kept in the wallets file so a rerun is the same agent (registrations are limited). */
function agentKey(role: 'HUNTER' | 'PREY'): Agent {
  const saved = env[`ARC_${role}_AGENT_JWK`];
  if (saved) {
    const jwk = JSON.parse(Buffer.from(saved, 'base64url').toString('utf8'));
    return { role, key: createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: jwk.x };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  appendFileSync(file!, `ARC_${role}_AGENT_JWK=${Buffer.from(JSON.stringify(jwk)).toString('base64url')}\n`);
  return { role, key: privateKey, publicKey: publicKey.export({ format: 'jwk' }).x! };
}

let audience = '';
async function signed(agent: Agent, method: 'GET' | 'POST', path: string, json?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = json === undefined ? '' : JSON.stringify(json), timestamp = String(Date.now()), nonce = randomBytes(18).toString('base64url');
  const signature = sign(null, Buffer.from(signingString({ audience, method, path, timestamp, nonce, body })), agent.key).toString('base64url');
  const r = await fetch(`${server}${path}`, { method, headers: { 'x-vana-key': agent.publicKey, 'x-vana-timestamp': timestamp, 'x-vana-nonce': nonce,
    'x-vana-signature': signature, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
}
const get = async (path: string, headers: Record<string, string> = {}) => (await fetch(`${server}${path}`, { headers })).json() as Promise<Record<string, unknown>>;

async function main(): Promise<void> {
  audience = (await get('/agents/info')).audience as string;
  console.log(`server ${server} (${audience}), mode ${mode}`);
  const hunter = agentKey('HUNTER'), prey = agentKey('PREY');
  for (const agent of [hunter, prey]) {
    const reg = await signed(agent, 'POST', '/agents/register', { name: `Demo ${agent.role.toLowerCase()}`, bio: 'Arc bounty demo agent' });
    if (reg.status !== 200) throw new Error(`register ${agent.role}: ${reg.status} ${JSON.stringify(reg.body)}`);
    agent.id = reg.body.agentId as string;
    const wallet = privateKeyToAccount(env[`ARC_${agent.role}_KEY`] as Hex);
    const proof = await signed(agent, 'POST', '/agents/me/wallet', { wallet: wallet.address,
      signature: await wallet.signMessage({ message: walletProofMessage(agent.id, wallet.address, audience) }) });
    if (proof.status !== 200 && proof.body.error !== 'wallet_taken') throw new Error(`wallet ${agent.role}: ${proof.status} ${JSON.stringify(proof.body)}`);
    console.log(`agent ${agent.role.toLowerCase().padEnd(6)} ${agent.id} pays to ${wallet.address}`);
  }

  // A leopard, and the blue duiker nearest it.
  const map = await get('/animals/map') as { species: Array<{ id: string; ids: string; xz: number[] }> };
  const animals = map.species.flatMap((s) => s.ids.split(',').map((tail, i) => ({ id: tail.startsWith('=') ? tail.slice(1) : `${s.id}_${tail}`, speciesId: s.id, x: s.xz[i * 2]!, z: s.xz[i * 2 + 1]! })));
  const pairs = animals.filter((a) => a.speciesId === 'african_leopard').flatMap((l) => animals.filter((d) => d.speciesId === 'blue_duiker')
    .map((d) => ({ leopard: l, duiker: d, m: Math.hypot(l.x - d.x, l.z - d.z) }))).sort((a, b) => a.m - b.m);
  let chosen: (typeof pairs)[number] | undefined;
  for (const pair of pairs.slice(0, 20)) {
    await signed(hunter, 'POST', '/agents/me/release'); await signed(prey, 'POST', '/agents/me/release');
    const a = await signed(hunter, 'POST', '/agents/me/possess', { animalId: pair.leopard.id });
    const b = await signed(prey, 'POST', '/agents/me/possess', { animalId: pair.duiker.id });
    if (a.status === 200 && b.status === 200) { chosen = pair; break; }
  }
  if (!chosen) throw new Error('no leopard and duiker pair could be taken');
  console.log(`hunter steers ${chosen.leopard.id}, prey steers ${chosen.duiker.id}, ${Math.round(chosen.m)} m apart`);

  const before = { hunter: await usdcOf(privateKeyToAccount(env.ARC_HUNTER_KEY as Hex).address), prey: await usdcOf(privateKeyToAccount(env.ARC_PREY_KEY as Hex).address) };
  // At 12 world hours a real hour: 3 world days are 6 real hours; the survive demo uses 20 world minutes (about 100 s).
  const windowWorldSeconds = mode === 'survive' ? 1200 : 3 * 86_400;
  const published = await fetch(`${server}/congo/admin/arc-bounties/random`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ amountUsdc: 1, windowWorldSeconds }) });
  const bounty = await published.json() as Record<string, string>;
  if (published.status !== 200) throw new Error(`publish: ${published.status} ${JSON.stringify(bounty)}`);
  console.log(`bounty ${bounty.bountyId} on a ${bounty.speciesId}: 1 USDC, publish ${bounty.publishTxUrl ?? bounty.publishTx}`);

  const deadline = Date.now() + (mode === 'survive' ? 10 : 30) * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const now = await get(`/congo/arc-bounties/${bounty.bountyId}`);
    if (now.status !== last) { console.log(`  status ${now.status}`); last = now.status as string; }
    if (now.status === 'paid' || now.status === 'voided') {
      console.log(`outcome ${now.outcome}: paid to ${now.payeeWallet ?? 'nobody (back to the pool)'}; ${now.decideTxUrl ?? now.decideTx}`);
      console.log(`record hash ${now.recordHash}; target revealed ${now.targetAnimalId}`);
      break;
    }
    if (mode === 'hunt') {
      const seen = await signed(hunter, 'POST', '/agents/me/hunt', { animalId: chosen.duiker.id });
      if (seen.status !== 200) {
        const map2 = await get('/animals/map') as { species: Array<{ id: string; ids: string; xz: number[] }> };
        const d = map2.species.find((s) => s.id === 'blue_duiker');
        const i = d ? d.ids.split(',').indexOf(chosen.duiker.id.slice('blue_duiker_'.length)) : -1;
        if (d && i >= 0) await signed(hunter, 'POST', '/agents/me/move', { to: { x: d.xz[i * 2], z: d.xz[i * 2 + 1] }, gait: 'walk' });
      }
    }
    await sleep(5000);
  }
  await sleep(3000);
  const after = { hunter: await usdcOf(privateKeyToAccount(env.ARC_HUNTER_KEY as Hex).address), prey: await usdcOf(privateKeyToAccount(env.ARC_PREY_KEY as Hex).address) };
  console.log(`hunter wallet ${before.hunter} -> ${after.hunter} USDC; prey wallet ${before.prey} -> ${after.prey} USDC`);
}

main().catch((error: unknown) => { console.error(String((error as Error).message ?? error)); process.exit(1); });
