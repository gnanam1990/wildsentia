-- When a wallet was set aside: it is tried again an hour later, and cleared once read
-- (the Arc mainnet readiness review of 15 November 2026), so a passing refusal never disables it for good.
alter table arc_usdc_watch add column stuck_since timestamptz;
