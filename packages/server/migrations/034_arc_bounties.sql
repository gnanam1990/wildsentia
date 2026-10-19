-- Congo bounties paid in USDC on Arc (docs/2026-10-19-congo-arc-bounties-design.md): a bounty on a
-- prey animal an agent steers, picked at random; paid to the agent whose predator kills it, or to
-- the prey's agent if it lives to the deadline. The money is on chain (WildsentiaBounties); this
-- table keeps the server's side: the secret target, the decision, and each transaction's hash
-- before it is sent.
create table arc_bounties (
  bounty_id text primary key check (bounty_id ~ '^0x[0-9a-f]{64}$'),
  world_id text not null,
  -- publishing: its publish transaction is not yet confirmed; deciding: its settle or void is not.
  status text not null check (status in ('publishing', 'active', 'deciding', 'paid', 'voided', 'failed')),
  target_animal_id text not null,
  target_species_id text not null,
  target_region text not null,
  target_agent_id text not null,
  target_wallet text not null check (target_wallet ~ '^0x[0-9a-f]{40}$'),
  -- keccak256 of the target animal's id, and the salt of the commit published on chain.
  target_key text not null check (target_key ~ '^0x[0-9a-f]{64}$'),
  salt text not null check (salt ~ '^0x[0-9a-f]{64}$'),
  amount_atomic numeric(78) not null check (amount_atomic > 0),
  window_world_seconds bigint not null check (window_world_seconds > 0),
  published_world_time bigint not null,
  deadline_world_time bigint not null,
  expires_at timestamptz not null,
  eligible_predators text[] not null,
  rules jsonb not null,
  rules_hash text not null check (rules_hash ~ '^0x[0-9a-f]{64}$'),
  notified boolean not null default false,
  -- A live kill of the target, as it happened.
  kill_agent_id text,
  kill_animal_id text,
  kill_world_time bigint,
  outcome text check (outcome in ('predator', 'survived', 'void')),
  payee_wallet text check (payee_wallet is null or payee_wallet ~ '^0x[0-9a-f]{40}$'),
  winner_agent_id text,
  winner_animal_id text,
  decided_world_time bigint,
  record jsonb,
  record_hash text check (record_hash is null or record_hash ~ '^0x[0-9a-f]{64}$'),
  publish_tx text,
  publish_sent_at timestamptz,
  decide_tx text,
  decide_sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  settled_at timestamptz,
  check ((outcome is null) = (status in ('publishing', 'active', 'failed')))
);
-- One live bounty per animal.
create unique index arc_bounties_one_live_per_animal on arc_bounties(world_id, target_animal_id) where status in ('publishing', 'active', 'deciding');
create index arc_bounties_world_status on arc_bounties(world_id, status);
