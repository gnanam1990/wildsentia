-- An independent, manual-payment ledger. No foreign keys or writes into simulation state.
create table reward_observers (
  token_hash text primary key,
  actor_id text,
  expires_at timestamptz not null
);
create table reward_drops (
  id uuid primary key,
  actor_id text not null,
  network text not null check (network = 'base'),
  amount_micro bigint not null check (amount_micro > 0 and amount_micro <= 1000000000000),
  reveal_when text not null check (reveal_when in ('watch', 'carcass')),
  status text not null default 'open' check (status in ('open', 'reserved', 'paid_reported', 'cancelled')),
  created_at timestamptz not null default now()
);
create index reward_drops_actor on reward_drops(actor_id, status);
create table reward_claims (
  id uuid primary key,
  drop_id uuid not null references reward_drops(id),
  observer_hash text not null,
  wallet text not null,
  status text not null default 'reserved' check (status in ('reserved', 'rejected', 'paid_reported')),
  created_at timestamptz not null default now(),
  unique (drop_id, observer_hash),
  unique (drop_id, wallet)
);
create unique index reward_one_winner on reward_claims(drop_id) where status in ('reserved', 'paid_reported');
create table reward_audit (
  id bigserial primary key,
  drop_id uuid not null references reward_drops(id),
  claim_id uuid references reward_claims(id),
  action text not null,
  network text not null,
  transaction_ref text,
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (network, transaction_ref)
);
