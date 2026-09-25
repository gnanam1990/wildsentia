-- Old events deliberately have no invented trajectory.
alter table events add column if not exists encounter jsonb;
alter table events add constraint events_encounter_object check (
  encounter is null or (jsonb_typeof(encounter) = 'object' and coalesce(encounter->>'version' = '1', false))
);
