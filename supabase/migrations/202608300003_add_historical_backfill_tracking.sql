create table if not exists public.team_rosters (
  season integer not null,
  league_id integer not null references public.leagues(id),
  team_id integer not null references public.teams(id),
  player_id integer not null references public.players(id),
  position_group text,
  position varchar(10),
  jersey_number integer,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (season, league_id, team_id, player_id)
);

create index if not exists team_rosters_player_season_idx
  on public.team_rosters (player_id, season desc);

create index if not exists team_rosters_team_season_idx
  on public.team_rosters (team_id, season desc);

comment on table public.team_rosters is
  'Season-specific team membership observed from API-Sports player rosters';

create table if not exists public.ingest_resource_status (
  resource_type text not null,
  season integer not null,
  entity_id bigint not null,
  status text not null check (status in ('complete', 'provider_empty', 'failed')),
  response_count integer not null default 0 check (response_count >= 0),
  attempt_count integer not null default 1 check (attempt_count > 0),
  last_error text,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (resource_type, season, entity_id)
);

create index if not exists ingest_resource_status_state_idx
  on public.ingest_resource_status (status, resource_type, season);

comment on table public.ingest_resource_status is
  'Persistent completion, empty-response, and failure checkpoints for API-Sports resources';

alter table public.team_rosters enable row level security;
alter table public.ingest_resource_status enable row level security;

grant select on public.team_rosters to anon, authenticated;
grant all on public.team_rosters, public.ingest_resource_status to service_role;

drop policy if exists public_read_team_rosters on public.team_rosters;
create policy public_read_team_rosters
  on public.team_rosters for select to anon, authenticated using (true);

drop policy if exists service_all_team_rosters on public.team_rosters;
create policy service_all_team_rosters
  on public.team_rosters for all to service_role using (true) with check (true);

drop policy if exists service_all_ingest_resource_status on public.ingest_resource_status;
create policy service_all_ingest_resource_status
  on public.ingest_resource_status for all to service_role using (true) with check (true);
