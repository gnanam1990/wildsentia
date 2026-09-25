-- Do not backfill from current animals: that would invent historical coordinates.
alter table events add column if not exists position jsonb;

-- Timestamps alone cannot distinguish events emitted at the start of the next unsaved tick.
-- Current deterministic IDs encode a seed namespace followed by a safe integer sequence.
-- Legacy random IDs remain NULL; never guess an ordering for them.
alter table events add column if not exists event_sequence bigint
  check (event_sequence >= 0 and event_sequence <= 9007199254740991);
update events set event_sequence = ('x' || right(id, 16))::bit(64)::bigint
  where event_sequence is null and id ~ '^[a-z_]+_[0-9a-f]{24}$'
    and right(id, 16) < '0020000000000000';

-- Bound map reads to the useful event stream instead of sorting routine feeding/movement.
create index if not exists events_map_time_idx on events(world_time desc, id desc)
  where type in ('hunt', 'born', 'died');
