-- Private record of non-empty manual export page retrievals, not publication receipts.
-- A repeated identical page increments its count instead of creating unbounded retry rows.
create table social_export_audit (
  id bigserial primary key,
  response_fingerprint text not null unique check (response_fingerprint ~ '^[0-9a-f]{64}$'),
  source_world_time bigint not null,
  source_next_sequence bigint not null,
  requested_cursor text,
  next_cursor text,
  draft_ids uuid[] not null,
  item_count integer not null check (item_count between 1 and 100),
  first_fetched_at timestamptz not null default now(),
  last_fetched_at timestamptz not null default now(),
  fetch_count bigint not null default 1 check (fetch_count > 0),
  check (cardinality(draft_ids) = item_count)
);
