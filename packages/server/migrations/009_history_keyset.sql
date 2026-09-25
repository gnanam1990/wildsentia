-- Stable pagination within retained, checkpoint-visible events; GIN actors index remains in use.
create index if not exists events_history_keyset on events (world_time, id collate "C");
