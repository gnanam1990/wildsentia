create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists events (
  id             text primary key,
  type           text        not null,
  world_time     bigint      not null,
  sim_version    text        not null,
  patch_id       integer     not null,
  actors         text[]      not null,
  goal           text,
  conditions     jsonb       not null default '{}'::jsonb,
  outcome        text        not null,
  effects        jsonb       not null default '{}'::jsonb,
  causal_parents text[]      not null default '{}',
  confidence     text        not null,
  recorded_at    timestamptz not null default now()
);

create index if not exists events_world_time_idx on events (world_time);
create index if not exists events_actors_idx on events using gin (actors);
create index if not exists events_type_idx on events (type);

create table if not exists snapshots (
  id          bigserial primary key,
  world_time  bigint      not null,
  sim_version text        not null,
  payload     jsonb       not null,
  created_at  timestamptz not null default now()
);

create index if not exists snapshots_world_time_idx on snapshots (world_time desc);

create table if not exists viewers (
  viewer_id  text primary key,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create table if not exists follows (
  viewer_id  text not null references viewers(viewer_id) on delete cascade,
  actor_id   text not null,
  created_at timestamptz not null default now(),
  primary key (viewer_id, actor_id)
);

create index if not exists follows_actor_idx on follows (actor_id);
