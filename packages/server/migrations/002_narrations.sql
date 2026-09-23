-- Model rephrasings of recap lines (spec §9.2). One row per event, per animal it is told from,
-- per template/model version. Every row names its event; ungrounded rewrites are kept and
-- marked, and never shown.
create table narrations (
  event_id    text        not null,
  subject_id  text        not null,
  version     text        not null,
  text        text        not null,
  grounded    boolean     not null,
  model       text        not null,
  created_at  timestamptz not null default now(),
  primary key (event_id, subject_id, version)
);
