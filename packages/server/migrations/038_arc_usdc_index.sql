-- Arc USDC transfers into and out of the wallets players proved, read from Arc's own RPC
-- (docs/2026-11-15-arc-mainnet-readiness.md): the funding graph's source where the explorer refuses
-- servers. One row a transfer, told apart by transaction and log index, so a range read twice adds
-- nothing; the graph sums them per pair of addresses.
create table arc_usdc_transfers (
  chain_id integer not null,
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index >= 0),
  block_number bigint not null check (block_number >= 0),
  from_addr text not null check (from_addr ~ '^0x[0-9a-f]{40}$'),
  to_addr text not null check (to_addr ~ '^0x[0-9a-f]{40}$'),
  -- In USDC's native 18 decimals, as the system emitter logs it.
  value_wei numeric(78, 0) not null check (value_wei >= 0),
  primary key (chain_id, tx_hash, log_index)
);
create index arc_usdc_transfers_from on arc_usdc_transfers (chain_id, from_addr);
create index arc_usdc_transfers_to on arc_usdc_transfers (chain_id, to_addr);

-- The wallets indexed, and the last block read for each.
create table arc_usdc_watch (
  chain_id integer not null,
  wallet text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  scanned_to bigint not null,
  added_at timestamptz not null default now(),
  primary key (chain_id, wallet)
);
