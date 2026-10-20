-- The operator may drop an Arc bounty on any hunted animal, wild ones too (docs/2026-10-19-congo-arc-bounties-design.md):
-- a wild target has no agent and no wallet, so only a hunter can win it, or it goes back to the pool.
alter table arc_bounties alter column target_agent_id drop not null;
alter table arc_bounties alter column target_wallet drop not null;
alter table arc_bounties add check ((target_agent_id is null) = (target_wallet is null));
