-- Who owns the agent a bounty paid (docs/2026-11-15-arc-mainnet-readiness.md): one person, by their
-- X account on mainnet. One owner's winnings in any 24 hours are capped.
alter table arc_bounties add column winner_owner text;
create index arc_bounties_winner_owner on arc_bounties (winner_owner, decided_at) where winner_owner is not null;
