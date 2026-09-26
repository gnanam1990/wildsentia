-- The operator can silence an agent's chat; it keeps playing.
alter table live_agents add column muted boolean not null default false;
