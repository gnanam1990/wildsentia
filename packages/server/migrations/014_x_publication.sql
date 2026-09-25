-- One durable create attempt per approved draft. A lost response is never retried blindly.
create table x_publications (
  draft_id uuid primary key references social_drafts(id),
  plan_fingerprint text not null check (plan_fingerprint ~ '^[0-9a-f]{64}$'),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{32}$'),
  account_id text not null check (account_id ~ '^[0-9]{1,30}$'),
  status text not null check (status in ('sending', 'unknown', 'published')),
  x_post_id text unique check (x_post_id ~ '^[0-9]{1,30}$'),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status = 'published') = (x_post_id is not null))
);

create table x_publication_audit (
  id bigint generated always as identity primary key,
  draft_id uuid not null references x_publications(draft_id),
  action text not null check (action in ('reserved', 'confirmed', 'unknown', 'reconciled')),
  x_post_id text,
  created_at timestamptz not null default now()
);
create index x_publication_audit_draft on x_publication_audit(draft_id,id desc);
