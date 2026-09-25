-- A finalized, canonical native Base USDC Transfer may settle one exact reservation.
-- Historical paid_reported rows remain unverified and are not promoted implicitly.
alter table reward_drops drop constraint reward_drops_status_check;
alter table reward_drops add constraint reward_drops_status_check
  check (status in ('open', 'reserved', 'paid_reported', 'verified_paid', 'cancelled'));
alter table reward_claims drop constraint reward_claims_status_check;
alter table reward_claims add constraint reward_claims_status_check
  check (status in ('reserved', 'rejected', 'paid_reported', 'verified_paid'));
drop index reward_one_winner;
create unique index reward_one_winner on reward_claims(drop_id)
  where status in ('reserved', 'paid_reported', 'verified_paid');

create table reward_verified_payouts (
  drop_id uuid primary key references reward_drops(id),
  claim_id uuid not null unique references reward_claims(id),
  network text not null check (network = 'base'),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index between 0 and 1000000),
  block_number text not null check (block_number ~ '^0x(0|[1-9a-f][0-9a-f]*)$'),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  token text not null check (token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  from_wallet text not null check (from_wallet ~ '^0x[0-9a-f]{40}$'),
  to_wallet text not null check (to_wallet ~ '^0x[0-9a-f]{40}$'),
  amount_micro bigint not null check (amount_micro > 0 and amount_micro <= 1000000000000),
  verified_at timestamptz not null default now(),
  unique (network, tx_hash, log_index)
);
