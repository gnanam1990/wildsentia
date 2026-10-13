-- Congo 1A.4: a track position may lie anywhere on the largest world served, the 48 km Congo
-- forest (160 x 160 patches of 300 m), not only on the 6 km island. LifeStore still checks each
-- position against its own world's grid before writing. Every existing row met the narrower
-- island bound, so the wider check is added NOT VALID: new rows are checked, and startup does not
-- scan a long-running world's whole tracks table under the migration's lock.
alter table tracks drop constraint track_position_complete;
alter table tracks add constraint track_position_complete check (
  (position_x is null and position_z is null and heading is null)
  or (position_x is not null and position_z is not null and heading is not null
    and position_x >= -150 and position_x < 47850
    and position_z >= -150 and position_z < 47850
    and heading >= -pi() and heading <= pi())
) not valid;
