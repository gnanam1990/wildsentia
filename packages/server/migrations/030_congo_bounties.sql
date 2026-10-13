-- Congo 1D (docs/superpowers/specs/2026-10-13-congo-phase1-design.md §5-§6): bounties on owned
-- animals' lives. Every amount is SIMULATED; the database refuses a row that is not.
create table bounties (
  bounty_id uuid primary key,
  status text not null check (status in ('draft', 'validated', 'active', 'on_hold', 'adjudicated', 'settled', 'cancelled')),
  preset text not null check (preset in ('standard', 'hard', 'elite')),
  world_id text not null,
  target_life_id uuid not null references animal_lives(life_id),
  target_animal_id text not null,
  target_species_id text not null,
  target_region text not null,
  target_asset_id uuid not null references animal_assets(asset_id),
  -- The survival payee: the owner at publication, whatever happens to the asset later.
  target_owner_account_id uuid not null references accounts(id),
  target_owner_wallet text not null check (target_owner_wallet ~ '^0x[0-9a-f]{40}$'),
  amount_atomic numeric(78) not null check (amount_atomic > 0),
  decimals int not null check (decimals between 0 and 18),
  window_world_seconds bigint not null check (window_world_seconds > 0),
  published_world_time bigint,
  deadline_world_time bigint,
  published_at timestamptz,
  eligible_predators text[] not null,
  rules jsonb not null,
  rules_hash text check (rules_hash is null or rules_hash ~ '^[0-9a-f]{64}$'),
  validation jsonb,
  outcome text check (outcome in ('predator', 'survived', 'void')),
  winner_wallet text,
  winner_animal_id text,
  decided_world_time bigint,
  adjudicated_at timestamptz,
  cancel_reason text,
  hold_reason text,
  simulated boolean not null default true check (simulated),
  created_at timestamptz not null default now(),
  check ((status in ('active', 'on_hold', 'adjudicated', 'settled')) = (published_at is not null) or status = 'cancelled')
);
-- One live bounty per life.
create unique index bounties_one_live_per_life on bounties(target_life_id) where status in ('active', 'on_hold', 'adjudicated');
create index bounties_world_status on bounties(world_id, status);

-- One settlement per bounty: the intent is written before the payout is recorded.
create table bounty_settlements (
  settlement_id uuid primary key,
  bounty_id uuid not null unique references bounties(bounty_id),
  payee_wallet text not null check (payee_wallet ~ '^0x[0-9a-f]{40}$'),
  amount_atomic numeric(78) not null check (amount_atomic > 0),
  decimals int not null,
  status text not null check (status in ('intent', 'recorded')),
  simulated boolean not null default true check (simulated),
  created_at timestamptz not null default now(),
  recorded_at timestamptz
);

-- The agents whose animals perceived a bounty's target, first time each.
create table bounty_entrants (
  bounty_id uuid not null references bounties(bounty_id),
  agent_id text not null,
  animal_id text not null,
  first_seen_world_time bigint not null,
  first_seen_at timestamptz not null default now(),
  primary key (bounty_id, agent_id)
);

-- Each decided bounty's event slice and its hash, for replay.
create table bounty_records (
  bounty_id uuid primary key references bounties(bounty_id),
  events jsonb not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
