-- Where each animal was and how it was, sampled every few world hours: what a life replay
-- walks along once the hourly routine events have been pruned.
create table tracks (
  actor_id    text     not null,
  world_time  bigint   not null,
  patch_id    integer  not null,
  state       text     not null,
  goal        text     not null,
  hunger      real     not null,
  thirst      real     not null,
  fatigue     real     not null,
  fear        real     not null,
  primary key (actor_id, world_time)
);
-- Housekeeping thins old samples by time across all animals.
create index tracks_world_time_idx on tracks (world_time);

-- Animals long dead or gone, released from the running world so it does not carry them in
-- memory and in every snapshot forever. Their passports are read from here.
create table animal_archive (
  id          text        primary key,
  species_id  text        not null,
  departed_at bigint      not null,
  record      jsonb       not null,
  archived_at timestamptz not null default now()
);

create index events_routine_prune_idx on events (world_time) where type in ('moved', 'fed', 'drank', 'rested', 'goal_selected', 'carcass_stage', 'nutrients_returned', 'scavenged');
