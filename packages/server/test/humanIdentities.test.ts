import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { AgentStore, humanAgentId } from '../src/live/liveStore.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

maybe('human identities', () => {
  let store: AgentStore;
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate live_agents cascade');
    store = new AgentStore(pool!);
  });
  const limits = { slots: 1, perNetworkPerDay: 5 };

  it('gives each X account one live identity of its own, named for its handle', async () => {
    const a = await store.ensureHuman({ xUserId: '1001', handle: 'kavya_k', networkHash: 'n' });
    expect(a).toMatchObject({ id: humanAgentId('1001'), name: 'kavya_k', publicKey: null, kind: 'human', wallet: null });
    expect(a.id).toMatch(/^ag_[0-9a-f]{16}$/);
    expect(await store.ensureHuman({ xUserId: '1001', handle: 'kavya_k', networkHash: 'n' })).toMatchObject({ id: a.id });
    // A handle that is not a valid live name, a reserved one, or one an agent already has.
    expect((await store.ensureHuman({ xUserId: '1002', handle: '9lives', networkHash: 'n' })).name).toBe('X 9lives');
    expect((await store.ensureHuman({ xUserId: '1003', handle: 'admin_x', networkHash: 'n' })).name).toBe('X admin_x');
    expect((await store.register({ publicKey: 'A'.repeat(43), name: 'Stripe', bio: '', networkHash: 'n' }, limits)).ok).toBe(true);
    expect((await store.ensureHuman({ xUserId: '1004', handle: 'stripe', networkHash: 'n' })).name).toBe('stripe 2');
  });

  it('have no key, so no signed request can act as them', async () => {
    const h = await store.ensureHuman({ xUserId: '2001', handle: 'tara', networkHash: 'n' });
    expect(await store.byId(h.id)).toMatchObject({ kind: 'human', publicKey: null });
    expect(await store.byKey('')).toBeNull();
    await expect(pool!.query(`update live_agents set public_key = $2 where id = $1`, [h.id, 'B'.repeat(43)])).rejects.toThrow();
    await expect(pool!.query(`insert into live_agents (id, name, name_key, network_hash) values ('ag_00000000000000aa', 'Bot', 'bot', 'n')`)).rejects.toThrow();
  });

  it('do not take agent slots, and are never reaped', async () => {
    await store.ensureHuman({ xUserId: '3001', handle: 'tara', networkHash: 'n' });
    expect(await store.count()).toBe(0);
    expect((await store.register({ publicKey: 'C'.repeat(43), name: 'Bot', bio: '', networkHash: 'n' }, limits)).ok).toBe(true);
    expect(await store.count()).toBe(1);
    await pool!.query("update live_agents set last_seen_at = now() - interval '60 days'");
    expect(await store.reapInactive(14)).toBe(1);
    expect(await store.byId(humanAgentId('3001'))).not.toBeNull();
  });

  it('are registered under the network they sign in from, so the collusion check compares people as it does agents', async () => {
    const tara = await store.ensureHuman({ xUserId: '4001', handle: 'tara', networkHash: 'net-home' });
    const ravi = await store.ensureHuman({ xUserId: '4002', handle: 'ravi', networkHash: 'net-cafe' });
    expect(await store.networkOf(tara.id)).toBe('net-home');
    expect(await store.networkOf(ravi.id)).toBe('net-cafe');
    // Signing in again from elsewhere moves them to that network.
    await store.ensureHuman({ xUserId: '4002', handle: 'ravi', networkHash: 'net-home' });
    expect(await store.networkOf(ravi.id)).toBe('net-home');
    // The old shared placeholder names no network: two people who still carry it are not related.
    const old = await store.ensureHuman({ xUserId: '4003', handle: 'mala', networkHash: 'human' });
    expect(await store.networkOf(old.id)).toBeNull();
    await store.ensureHuman({ xUserId: '4003', handle: 'mala', networkHash: 'human' });
    expect(await store.networkOf(old.id)).toBeNull();
  });
});
