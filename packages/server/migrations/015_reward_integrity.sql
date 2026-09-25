-- One identity per founded world. Founding a new world replaces it, so the reward ledger
-- can never pay against an actor ID that a different world happens to reuse.
create table world_identity (
  singleton boolean primary key default true check (singleton),
  world_id uuid not null,
  founded_at timestamptz not null default now()
);
-- Existing drops are bound to the current world when rewards next start (see rewards.ts).
alter table reward_drops add column world_id uuid;
create index reward_drops_world on reward_drops(world_id, status);
-- When the observer began watching its current subject; a claim needs real watching time.
alter table reward_observers add column watch_started_at timestamptz;
-- A keyed hash of the claimant's network address, for daily limits. Never the address itself.
alter table reward_claims add column client_hash text;
create index reward_claims_wallet_recent on reward_claims(wallet, created_at);
create index reward_claims_client_recent on reward_claims(client_hash, created_at);
