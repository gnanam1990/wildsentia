-- Completion eligibility uses the authoritative observation, not the later payout delivery.
-- Older met attempts have no reliable observation timestamp; leave those null.
alter table challenge_attempts add column goal_met_at timestamptz;
