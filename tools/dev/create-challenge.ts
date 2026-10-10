/**
 * Creates a challenge on a local server and chain (tools/dev/local-chain.ts): drafts it with the
 * operator token, signs the creator's USDC authorization with anvil's public creator key, relays it.
 *
 *   VANA_CHALLENGES_ADMIN_TOKEN=… npx tsx tools/dev/create-challenge.ts '{"template":"hunt","speciesId":"tiger"}' 5 3
 */
import { privateKeyToAccount } from 'viem/accounts';

const API = process.env.VANA_API ?? 'http://127.0.0.1:8080';
const creator = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const [terms, prize = '5', days = '3'] = process.argv.slice(2);
const draft = await fetch(`${API}/challenges/drafts`, { method: 'POST', headers: { authorization: `Bearer ${process.env.VANA_CHALLENGES_ADMIN_TOKEN}`,
  'content-type': 'application/json' }, body: JSON.stringify({ creatorWallet: creator.address, terms: JSON.parse(terms!), prizeUsdc: prize, days: Number(days) }) })
  .then((r) => r.json()) as { draftId?: string; description?: string; typedData?: { domain: never; types: never; primaryType: never; message: Record<string, string> }; error?: string };
if (!draft.draftId || !draft.typedData) throw new Error(`draft refused: ${draft.error}`);
const t = draft.typedData, m = t.message;
const signature = await creator.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType,
  message: { ...m, value: BigInt(m.value!), validAfter: BigInt(m.validAfter!), validBefore: BigInt(m.validBefore!) } as never });
const relay = await fetch(`${API}/challenges/drafts/${draft.draftId}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ signature }) });
console.log(relay.status === 202 ? `sent: ${draft.description} (${prize} USDC, ${days} days)` : `relay refused: ${await relay.text()}`);
