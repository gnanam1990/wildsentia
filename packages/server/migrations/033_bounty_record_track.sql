-- Bounty replay (spec §5 Records and replay): a decided bounty's record keeps the target's path
-- from its track log, thinned to at most 2,000 samples, so the forest viewer can replay it.
alter table bounty_records add column track jsonb not null default '[]'::jsonb;
