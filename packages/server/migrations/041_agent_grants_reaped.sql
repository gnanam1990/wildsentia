-- An agent reaped for being idle takes its asset grants with it (docs/2026-11-17-security-audit.md L1).
-- Without this, one grant ever given to an idle agent failed the reaper's whole delete, so no
-- agent was reaped again and the slots filled. The owner grants a returning agent again.
alter table asset_agent_grants drop constraint asset_agent_grants_agent_id_fkey;
alter table asset_agent_grants add constraint asset_agent_grants_agent_id_fkey
  foreign key (agent_id) references live_agents(id) on delete cascade;
