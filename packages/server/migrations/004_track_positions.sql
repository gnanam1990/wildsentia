-- Nullable for historical patch-only tracks; never fabricate precise past locations.
alter table tracks add column position_x double precision;
alter table tracks add column position_z double precision;
alter table tracks add column heading double precision;
alter table tracks add constraint track_position_complete check (
  (position_x is null and position_z is null and heading is null)
  or (position_x is not null and position_z is not null and heading is not null
    and position_x >= -150 and position_x < 5850
    and position_z >= -150 and position_z < 5850
    and heading >= -pi() and heading <= pi())
);
