-- Congo 1C (docs/superpowers/specs/2026-10-13-congo-phase1-design.md §3-§4): owned animals,
-- their lives, who steers them, and the simulated store. No row here moves real money: every
-- money row is SIMULATED, and the database refuses one that is not.

-- A purchase or sale through the simulated store, once per owner and idempotency key.
create table sim_purchases (
  purchase_id uuid primary key,
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  owner_account_id uuid not null references accounts(id),
  owner_wallet text not null check (owner_wallet ~ '^0x[0-9a-f]{40}$'),
  kind text not null check (kind in ('buy', 'sell')),
  species_id text not null,
  price_atomic numeric(78) not null check (price_atomic >= 0),
  fee_atomic numeric(78) not null check (fee_atomic >= 0),
  decimals int not null check (decimals between 0 and 18),
  pricing_version text not null,
  simulated boolean not null default true check (simulated),
  created_at timestamptz not null default now(),
  unique (owner_account_id, idempotency_key)
);

-- The simulated ledger: signed integer amounts by category (reward pool, unallocated fees,
-- proceeds, burn obligations, payouts).
create table sim_ledger (
  entry_id bigserial primary key,
  category text not null check (category in ('reward_pool', 'unallocated', 'proceeds', 'burn_obligation', 'payout')),
  amount_atomic numeric(78) not null,
  decimals int not null check (decimals between 0 and 18),
  purchase_id uuid references sim_purchases(purchase_id),
  ref text,
  simulated boolean not null default true check (simulated),
  created_at timestamptz not null default now()
);
create index sim_ledger_category on sim_ledger(category);

-- A permanent owned animal: what was bought, by whom, paid to which wallet.
create table animal_assets (
  asset_id uuid primary key,
  owner_account_id uuid not null references accounts(id),
  owner_wallet text not null check (owner_wallet ~ '^0x[0-9a-f]{40}$'),
  species_id text not null,
  variant_id text not null default 'standard',
  purchase_id uuid not null unique references sim_purchases(purchase_id),
  pricing_version text not null,
  cosmetics jsonb not null default '{}',
  status text not null default 'active' check (status in ('active', 'locked', 'retired')),
  created_at timestamptz not null default now()
);
create index animal_assets_owner on animal_assets(owner_account_id);

-- Each life of an asset: one sim animal from spawn to death. The sim animal id stays the life's
-- id in the event log. A life reserved before its spawn has no animal yet.
create table animal_lives (
  life_id uuid primary key,
  asset_id uuid not null references animal_assets(asset_id),
  animal_id text unique,
  world_id text not null,
  status text not null check (status in ('alive', 'cooldown', 'dead')),
  spawn_patch_id int,
  spawned_at timestamptz not null default now(),
  spawned_world_time bigint,
  death_cause text,
  killer_animal_id text,
  died_at timestamptz,
  died_world_time bigint,
  cooldown_until timestamptz,
  bounty_id uuid,
  check ((status = 'alive') = (died_at is null))
);
create unique index animal_lives_one_alive on animal_lives(asset_id) where status = 'alive';
create index animal_lives_asset on animal_lives(asset_id, spawned_at);

-- Who steers a life: the owner's own session, or one agent the owner authorised. One open lease
-- per life: the database is the arbiter of a handover.
create table control_leases (
  lease_id uuid primary key,
  life_id uuid not null references animal_lives(life_id),
  holder_kind text not null check (holder_kind in ('owner', 'agent')),
  holder_id text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check ((ended_at is null) = (end_reason is null))
);
create unique index control_leases_one_open on control_leases(life_id) where ended_at is null;
create index control_leases_holder on control_leases(holder_id) where ended_at is null;

-- The agents an owner has authorised to steer an asset.
create table asset_agent_grants (
  asset_id uuid not null references animal_assets(asset_id),
  agent_id text not null references live_agents(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index asset_agent_grants_open on asset_agent_grants(asset_id, agent_id) where revoked_at is null;
