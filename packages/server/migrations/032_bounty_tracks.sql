-- Bounty clues (spec §6): each active target's sampled track log, kept so that a restart does not
-- wipe the trail. Six world hours per bounty are kept; older samples are pruned as new ones land.
create table bounty_tracks (
  bounty_id uuid not null references bounties(bounty_id),
  world_time double precision not null,
  x real not null,
  z real not null,
  state text not null,
  primary key (bounty_id, world_time)
);
