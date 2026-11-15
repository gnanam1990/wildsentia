-- A wallet whose logs the RPC will not return even one block and one wallet at a time (flooded with
-- transfers in a block): set aside at that block so the other wallets read on; its links stay unknown,
-- so nothing involving it is paid (docs/2026-11-15-arc-mainnet-readiness.md).
alter table arc_usdc_watch add column stuck_at bigint;
