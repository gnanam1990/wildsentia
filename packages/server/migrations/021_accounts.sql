-- Wildsentia accounts (docs/2026-10-09-challenges-design.md §14): people sign in with X, link a
-- wallet, and play the live world through an identity of their own in live_agents.

-- A person's live identity has no key: it can never sign the agent API.
alter table live_agents add column kind text not null default 'agent' check (kind in ('agent', 'human'));
alter table live_agents alter column public_key drop not null;
alter table live_agents add constraint live_agents_key_by_kind check ((kind = 'agent') = (public_key is not null));

create table accounts (
  id uuid primary key,
  x_user_id text not null unique check (x_user_id ~ '^[0-9]{1,30}$'),
  x_handle text not null,
  x_name text not null,
  -- When the X account was made: an account under 30 days old can neither create nor accept.
  x_created_at timestamptz not null,
  agent_id text not null unique references live_agents(id),
  created_at timestamptz not null default now(),
  signed_in_at timestamptz not null default now()
);

-- Only the hash of a session token is kept.
create table account_sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index account_sessions_account on account_sessions(account_id);

-- A draft made by a signed-in creator (null: made with the operator token).
alter table challenge_drafts add column account_id uuid references accounts(id);
create index challenge_drafts_account on challenge_drafts(account_id, created_at);
