-- Congo 1C: a sim animal id is unique within its world, not across worlds: a new world can name
-- an animal as an old world once did, and that old life must never speak for it.
alter table animal_lives drop constraint animal_lives_animal_id_key;
create unique index animal_lives_world_animal on animal_lives(world_id, animal_id);
