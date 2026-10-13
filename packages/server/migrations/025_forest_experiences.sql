create table experience_jobs (
  id uuid primary key,
  owner_hash text not null,
  kind text not null check (kind in ('league', 'lab')),
  status text not null check (status in ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  request jsonb not null,
  progress jsonb not null default '{"percent":0}',
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index experience_jobs_owner on experience_jobs (owner_hash, created_at desc);
create table experience_follows (
  owner_hash text not null,
  world_id text not null,
  animal_id text not null,
  nickname text not null default '',
  seen_sequence bigint not null default 0,
  created_at timestamptz not null default now(),
  primary key (owner_hash, world_id, animal_id)
);
create table experience_budgets (
  day date not null,
  kind text not null,
  used bigint not null default 0 check (used >= 0),
  primary key (day, kind)
);
create table experience_scores (
  season text not null,
  mission text not null,
  species text not null,
  player_id text not null,
  player_label text not null,
  matches integer not null default 0,
  wins integer not null default 0,
  points bigint not null default 0,
  primary key (season, mission, species, player_id)
);
