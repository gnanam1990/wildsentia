-- Provider-neutral, admin-only editorial outbox. Never a posting queue or ecosystem input.
create table social_drafts (
  id uuid primary key,
  seq bigserial not null unique,
  -- Deliberately no FK to events: checkpoint rollback and test truncation can remove an
  -- event. Every read/review/export re-joins and matches these immutable source facts.
  event_id text not null unique,
  event_type text not null,
  source_world_time bigint not null,
  source_patch_id integer not null,
  source_outcome text not null,
  source_conditions jsonb not null,
  -- Change detector across the complete saved event row except insertion timestamp.
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{32}$'),
  body text not null check (length(body) > 0 and length(body) <= 280),
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'revoked')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index social_drafts_status on social_drafts(status, seq desc);
create table social_audit (
  id bigserial primary key,
  draft_id uuid not null references social_drafts(id) on delete cascade,
  action text not null check (action in ('generated', 'approved', 'rejected', 'revoked')),
  note text not null default '',
  created_at timestamptz not null default now()
);
create index social_audit_draft on social_audit(draft_id, id);
create index events_social_candidates on events(world_time desc, id collate "C" desc)
  where confidence = 'authoritative' and type in
    ('born','died','hunt','human_born','human_died','human_hunt','building_rebuilt');
