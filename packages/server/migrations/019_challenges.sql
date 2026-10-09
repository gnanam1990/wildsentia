-- Wildsentia Challenges (docs/2026-10-09-challenges-design.md): USDC prizes escrowed on Arc by
-- the WildsentiaChallenges contract, won by the first player to meet a templated goal.

-- Terms a creator is about to fund: the server hands back the rules hash and the EIP-3009
-- nonce to sign, and later recognises the on-chain challenge by that nonce.
create table challenge_drafts (
  id uuid primary key,
  creator_wallet text not null check (creator_wallet ~ '^0x[0-9a-f]{40}$'),
  terms jsonb not null,
  rules_hash text not null check (rules_hash ~ '^0x[0-9a-f]{64}$'),
  prize_atomic numeric(30, 0) not null check (prize_atomic > 0),
  deadline timestamptz not null,
  salt text not null check (salt ~ '^0x[0-9a-f]{64}$'),
  auth_nonce text not null unique check (auth_nonce ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  relayed_at timestamptz
);

-- Challenges as the contract recorded them (its ChallengeCreated events).
create table challenges (
  id bigint primary key check (id > 0),
  contract text not null check (contract ~ '^0x[0-9a-f]{40}$'),
  draft_id uuid references challenge_drafts(id),
  creator_wallet text not null check (creator_wallet ~ '^0x[0-9a-f]{40}$'),
  -- Terms are known only when the rules hash is one of ours; otherwise the challenge is
  -- 'unrecognised' and nobody can play it (its prize simply refunds after the deadline).
  terms jsonb,
  rules_hash text not null check (rules_hash ~ '^0x[0-9a-f]{64}$'),
  prize_atomic numeric(30, 0) not null check (prize_atomic > 0),
  deadline timestamptz not null,
  auth_nonce text not null check (auth_nonce ~ '^0x[0-9a-f]{64}$'),
  -- won: a winner is being paid; unpaid: the payout reverted (e.g. a blocklisted winner), so it refunds.
  status text not null check (status in ('open', 'won', 'paid', 'unpaid', 'refunding', 'refunded', 'unrecognised')),
  winner_attempt uuid,
  created_tx text not null check (created_tx ~ '^0x[0-9a-f]{64}$'),
  created_block bigint not null,
  settled_tx text check (settled_tx is null or settled_tx ~ '^0x[0-9a-f]{64}$'),
  indexed_at timestamptz not null default now()
);
create index challenges_status on challenges(status, deadline);

-- One player's go at a challenge: a possession started through it.
create table challenge_attempts (
  id uuid primary key,
  challenge_id bigint not null references challenges(id),
  agent_id text not null references live_agents(id) on delete cascade,
  animal_id text not null,
  payout_wallet text not null check (payout_wallet ~ '^0x[0-9a-f]{40}$'),
  started_at timestamptz not null default now(),
  started_world bigint not null,
  start_state jsonb not null,
  kills integer not null default 0 check (kills >= 0),
  escapes integer not null default 0 check (escapes >= 0),
  status text not null check (status in ('running', 'met', 'failed', 'void')),
  ended_at timestamptz,
  ended_world bigint,
  end_reason text,
  -- The exact JSON record whose keccak256 is the on-chain resultHash (winners only).
  result_record text,
  result_hash text check (result_hash is null or result_hash ~ '^0x[0-9a-f]{64}$')
);
create unique index challenge_attempts_one_running on challenge_attempts(agent_id) where status = 'running';
create index challenge_attempts_challenge on challenge_attempts(challenge_id, started_at);
alter table challenges add constraint challenges_winner foreign key (winner_attempt) references challenge_attempts(id);

-- Everything that happened in an attempt, in order: commands, hunts, the start and the end.
create table challenge_attempt_log (
  id bigserial primary key,
  attempt_id uuid not null references challenge_attempts(id) on delete cascade,
  at timestamptz not null,
  kind text not null,
  data jsonb not null
);
create index challenge_attempt_log_attempt on challenge_attempt_log(attempt_id, id);

-- Chain transactions, written before they are sent so a restart never sends one twice blind.
create table challenge_chain_ops (
  id uuid primary key,
  kind text not null check (kind in ('relay_create', 'resolve', 'refund')),
  challenge_id bigint references challenges(id),
  draft_id uuid references challenge_drafts(id),
  payload jsonb not null,
  status text not null check (status in ('pending', 'sent', 'confirmed', 'failed')),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  tries integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'relay_create') = (draft_id is not null)),
  check ((kind = 'relay_create') = (challenge_id is null))
);
-- At most one live (not failed) operation of each kind per challenge or draft.
create unique index challenge_chain_ops_one_per_challenge on challenge_chain_ops(kind, challenge_id)
  where challenge_id is not null and status <> 'failed';
create unique index challenge_chain_ops_one_per_draft on challenge_chain_ops(kind, draft_id)
  where draft_id is not null and status <> 'failed';
create index challenge_chain_ops_due on challenge_chain_ops(status, updated_at);

-- How far the ChallengeCreated indexer has read each contract.
create table challenge_index_cursor (
  contract text primary key check (contract ~ '^0x[0-9a-f]{40}$'),
  next_block bigint not null check (next_block >= 0)
);
