-- Outside AI agents that each steer one animal (docs/2026-09-26-live-agents-design.md).
create table live_agents (
  id text primary key check (id ~ '^ag_[0-9a-f]{16}$'),
  public_key text not null unique check (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  name text not null,
  name_key text not null unique,
  bio text not null default '',
  -- Lower-case EVM address; unique on every change, and only paid once proven by signature.
  wallet text unique check (wallet is null or wallet ~ '^0x[0-9a-f]{40}$'),
  wallet_proven boolean not null default false,
  -- A keyed hash of the registering network address, for registration limits. Never the address.
  network_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index live_agents_network on live_agents(network_hash, created_at);

create table live_possessions (
  agent_id text primary key references live_agents(id) on delete cascade,
  animal_id text not null unique,
  world_id uuid not null,
  started_at timestamptz not null default now(),
  x double precision not null,
  z double precision not null,
  heading double precision not null,
  last_command_at timestamptz not null default now()
);

-- Place drops: a reward waiting at a spot on the island, won by the first agent to open it.
alter table reward_drops alter column actor_id drop not null;
alter table reward_drops add column kind text not null default 'animal' check (kind in ('animal', 'place'));
alter table reward_drops add column place_x double precision, add column place_z double precision,
  add column hint_x double precision, add column hint_z double precision,
  add column appears_at timestamptz, add column expires_at timestamptz,
  add column spotted_by text, add column spotted_at timestamptz;
alter table reward_drops drop constraint reward_drops_reveal_when_check;
alter table reward_drops add constraint reward_drops_reveal_when_check check (reveal_when in ('watch', 'carcass', 'place'));
alter table reward_drops add constraint reward_drops_kind_shape check (
  (kind = 'animal' and actor_id is not null and place_x is null)
  or (kind = 'place' and actor_id is null and reveal_when = 'place' and place_x is not null and place_z is not null
      and hint_x is not null and hint_z is not null and appears_at is not null and expires_at > appears_at));
create index reward_drops_place on reward_drops(world_id, kind, status, appears_at);
alter table reward_claims add column agent_id text;
create index reward_claims_agent_recent on reward_claims(agent_id, created_at) where agent_id is not null;
