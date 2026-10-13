import { randomUUID } from 'node:crypto';
import type { Pool } from '../src/db/pool.js';
import type { OwnershipStore } from '../src/ownership/store.js';

// Congo 1C test fixtures: people with proven wallets, and their assets.
/** A signed-in person with a proven wallet, as accounts makes them. */
export async function person(db: Pool, n: number): Promise<{ accountId: string; agentId: string; wallet: string }> {
  const agentId = `ag_${n.toString(16).padStart(16, '0')}`, wallet = `0x${n.toString(16).padStart(40, '0')}`, accountId = randomUUID();
  await db.query(`insert into live_agents (id, kind, public_key, name, name_key, network_hash, wallet, wallet_proven)
    values ($1, 'human', null, $2, $3, 'test', $4, true)`, [agentId, `Person${n}`, `person${n}`, wallet]);
  await db.query(`insert into accounts (id, x_user_id, x_handle, x_name, x_created_at, agent_id) values ($1, $2, $3, $3, now() - interval '1 year', $4)`,
    [accountId, String(1000 + n), `person${n}`, agentId]);
  return { accountId, agentId, wallet };
}
export async function ownedAsset(store: OwnershipStore, owner: { accountId: string; wallet: string }, speciesId = 'blue_duiker'): Promise<string> {
  const purchase = await store.recordPurchase({ idempotencyKey: randomUUID(), ownerAccountId: owner.accountId, ownerWallet: owner.wallet,
    kind: 'buy', speciesId, priceAtomic: 5_000_000n, feeAtomic: 250_000n, decimals: 6, pricingVersion: 'test' }, []);
  return (await store.createAsset({ ownerAccountId: owner.accountId, ownerWallet: owner.wallet, speciesId, purchaseId: purchase.purchaseId, pricingVersion: 'test' })).assetId;
}

