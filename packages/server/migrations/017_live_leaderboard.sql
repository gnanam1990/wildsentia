-- Each agent's finished time with an animal, for the leaderboard (longest life, animals lost).
create table live_lives (
  id bigserial primary key,
  agent_id text not null references live_agents(id) on delete cascade,
  animal_id text not null,
  species_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null check (ended_at >= started_at),
  how text not null check (how in ('died', 'caught', 'birth', 'idle', 'released'))
);
create index live_lives_agent on live_lives(agent_id, ended_at);
