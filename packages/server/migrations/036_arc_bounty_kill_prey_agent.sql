-- Who steered an Arc bounty's target when it was killed (docs/2026-10-19-congo-arc-bounties-design.md):
-- a hunter is never paid for prey its own agent, a related agent or its own wallet steered then,
-- whether the target was wild at publication or steered without a proven wallet.
alter table arc_bounties add column kill_prey_agent_id text;
