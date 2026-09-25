-- Executed, person-specific human trajectories. Rows may precede a snapshot write,
-- but readers additionally require the published checkpoint boundary. Recovery
-- removes rows beyond the latest durable snapshot before serving requests.
create table if not exists human_motion (
  person_id text not null,
  start_world_time bigint not null,
  end_world_time bigint not null,
  samples jsonb not null,
  recorded_at timestamptz not null default now(),
  primary key (person_id, start_world_time),
  constraint human_motion_positive_interval check (end_world_time > start_world_time and end_world_time - start_world_time <= 3600),
  constraint human_motion_samples_array check (jsonb_typeof(samples) = 'array')
);
create index if not exists human_motion_person_recent on human_motion (person_id, start_world_time desc);
create index if not exists human_motion_end_time on human_motion (end_world_time);
