-- X post drafts about challenges (docs/superpowers/plans/2026-10-10-challenges-3c-social-drafts.md): one per
-- challenge and kind, written from the challenge's own facts, posted only after the owner approves and publishes.
create table challenge_social_drafts (
  id uuid primary key,
  challenge_id bigint not null references challenges(id),
  kind text not null check (kind in ('created', 'won', 'refunded')),
  body text not null check (length(body) > 0 and length(body) <= 280),
  -- publishing: reserved just before the one call to X. unknown: that call's result is not known; never retried.
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'revoked', 'publishing', 'published', 'unknown')),
  x_post_id text check (x_post_id is null or x_post_id ~ '^[0-9]{1,30}$'),
  -- When it was reserved for posting: a reservation long past the X call's timeout can be settled by the owner.
  reserved_at timestamptz,
  note text not null default '' check (length(note) <= 500),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  published_at timestamptz,
  unique (challenge_id, kind)
);
create index challenge_social_drafts_recent on challenge_social_drafts(created_at desc);

-- Every step, kept: drafted, reviewed, reserved, what X answered, and what the owner found.
create table challenge_social_audit (
  id bigserial primary key,
  draft_id uuid not null references challenge_social_drafts(id) on delete cascade,
  action text not null check (action in ('drafted', 'redrafted', 'approved', 'rejected', 'revoked', 'reserved', 'published', 'unknown',
    'resolved_posted', 'resolved_not_posted', 'reservation_released')),
  note text not null default '' check (length(note) <= 500),
  x_post_id text,
  created_at timestamptz not null default now()
);
create index challenge_social_audit_draft on challenge_social_audit(draft_id, id);
