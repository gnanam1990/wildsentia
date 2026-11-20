-- ERC-8004 identities and reputation (the challenges ERC-8004 plan):
-- a player links the identity their payout wallet owns, and each met or failed attempt leaves one feedback on it.
alter table live_agents add column erc8004_agent_id numeric(78, 0) unique check (erc8004_agent_id is null or erc8004_agent_id >= 0);
-- Feedback goes only for attempts that ended after the identity was linked.
alter table live_agents add column erc8004_linked_at timestamptz;

alter table challenge_chain_ops drop constraint challenge_chain_ops_kind_check;
alter table challenge_chain_ops add constraint challenge_chain_ops_kind_check
  check (kind in ('relay_create', 'resolve', 'refund', 'record_start', 'record_end', 'reputation'));
alter table challenge_chain_ops drop constraint challenge_chain_ops_target;
alter table challenge_chain_ops add constraint challenge_chain_ops_target check (
  (kind = 'relay_create' and draft_id is not null and challenge_id is null and attempt_id is null)
  or (kind in ('resolve', 'refund') and challenge_id is not null and draft_id is null and attempt_id is null)
  or (kind in ('record_start', 'record_end', 'reputation') and attempt_id is not null and challenge_id is not null and draft_id is null));
