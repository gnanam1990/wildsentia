import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { testDatabaseUrl } from './testDatabase.js';
const url = testDatabaseUrl();
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });
(url ? describe : describe.skip)('challenge completion migration', () => {
  it('upgrades existing attempts without inventing a pre-deadline observation', async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, live_agents cascade');
    await pool!.query(`insert into live_agents (id, public_key, name, name_key, network_hash)
      values ('ag_0000000000000001', $1, 'Migration', 'migration', 'fixture')`, ['1'.padEnd(43, 'A')]);
    const address = '0x' + 'a'.repeat(40), hash = '0x' + 'b'.repeat(64);
    await pool!.query(`insert into challenges (id, contract, creator_wallet, evaluator, rules_hash, prize_atomic, deadline, auth_nonce,
      status, created_tx, created_block) values (1,$1,$1,$1,$2,1,now(),$2,'won',$2,1)`, [address, hash]);
    const { rows: [a] } = await pool!.query(`insert into challenge_attempts (id, challenge_id, agent_id, animal_id, payout_wallet,
      started_world, start_state, status, ended_at, ended_world, result_record, result_hash)
      values (gen_random_uuid(),1,'ag_0000000000000001','tiger_1',$1,0,'{}','met',now(),100,'{}',$2) returning id`, [address, hash]);
    await pool!.query('alter table challenge_attempts drop column goal_met_at');
    await pool!.query("delete from schema_migrations where name = '024_challenge_goal_time.sql'");
    try {
      expect(await migrate(pool!)).toEqual(['024_challenge_goal_time.sql']);
      expect((await pool!.query('select status, goal_met_at, result_record, result_hash from challenge_attempts where id = $1', [a.id])).rows)
        .toEqual([{ status: 'met', goal_met_at: null, result_record: '{}', result_hash: hash }]);
      expect(await migrate(pool!)).toEqual([]);
    } finally { await migrate(pool!); }
  });
});
