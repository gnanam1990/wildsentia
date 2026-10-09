-- Wildsentia Challenges v2 (docs/2026-10-09-challenges-design.md §13): every attempt's start and
-- end is written on chain by the WildsentiaAttempts contract, through the same durable chain
-- operations as payouts. Every ended attempt keeps its record; its keccak256 is the on-chain logHash.

alter table challenge_chain_ops drop constraint challenge_chain_ops_kind_check;
alter table challenge_chain_ops add constraint challenge_chain_ops_kind_check
  check (kind in ('relay_create', 'resolve', 'refund', 'record_start', 'record_end'));
alter table challenge_chain_ops add column attempt_id uuid references challenge_attempts(id);

-- Each kind names exactly its own target.
alter table challenge_chain_ops drop constraint challenge_chain_ops_check;
alter table challenge_chain_ops drop constraint challenge_chain_ops_check1;
alter table challenge_chain_ops add constraint challenge_chain_ops_target check (
  (kind = 'relay_create' and draft_id is not null and challenge_id is null and attempt_id is null)
  or (kind in ('resolve', 'refund') and challenge_id is not null and draft_id is null and attempt_id is null)
  or (kind in ('record_start', 'record_end') and attempt_id is not null and challenge_id is not null and draft_id is null));

-- A challenge's own operations (resolve, refund) stay one live per kind; an attempt is recorded
-- at most once per kind, even after a failure.
drop index challenge_chain_ops_one_per_challenge;
create unique index challenge_chain_ops_one_per_challenge on challenge_chain_ops(kind, challenge_id)
  where challenge_id is not null and attempt_id is null and status <> 'failed';
create unique index challenge_chain_ops_one_per_attempt on challenge_chain_ops(kind, attempt_id)
  where attempt_id is not null;

comment on column challenge_attempts.result_record is
  'The exact JSON record of the attempt; its keccak256 (result_hash) is the winner''s resultHash and every attempt''s on-chain logHash.';
