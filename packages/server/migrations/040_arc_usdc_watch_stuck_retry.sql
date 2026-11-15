-- When a wallet was set aside: it is tried again an hour later, and cleared once read
-- (docs/2026-11-15-arc-mainnet-readiness.md), so a passing refusal never disables it for good.
alter table arc_usdc_watch add column stuck_since timestamptz;
