create table if not exists public.teams (
  id integer primary key,
  name text not null,
  logo_url text,
  created_at timestamptz not null default now()
);

create unique index if not exists teams_name_idx on public.teams (name);

comment on table public.teams is 'NFL franchise reference data from API-Sports';
comment on column public.teams.id is 'API-Sports stable team identifier';
comment on column public.teams.logo_url is 'Absolute URL: https://media.api-sports.io/american-football/teams/{id}.png';

create table if not exists public.players (
  id integer primary key,
  name text not null,
  image_url text,
  created_at timestamptz not null default now()
);

comment on table public.players is 'NFL player reference data from API-Sports';
comment on column public.players.id is 'API-Sports stable player identifier';
comment on column public.players.image_url is 'Absolute URL: https://media.api-sports.io/american-football/players/{id}.png';

create table if not exists public.games (
  id integer primary key,
  season integer,
  week text,
  home_team_id integer references public.teams(id),
  away_team_id integer references public.teams(id),
  game_date timestamptz,
  venue text,
  created_at timestamptz not null default now()
);

create index if not exists games_season_idx on public.games (season);
create index if not exists games_home_team_idx on public.games (home_team_id);
create index if not exists games_away_team_idx on public.games (away_team_id);

comment on table public.games is 'NFL game metadata. Populate via /games endpoint; referenced by game_events';

create table if not exists public.game_events (
  id bigint generated always as identity primary key,
  game_id integer not null references public.games(id),
  team_id integer not null references public.teams(id),
  player_id integer references public.players(id),
  quarter text not null check (quarter in ('First', 'Second', 'Third', 'Fourth', 'OT', 'OT2')),
  minute text,
  event_type text not null check (event_type in ('TD', 'FG', 'SAF', 'PAT', '2PT')),
  comment text,
  score_home integer check (score_home >= 0),
  score_away integer check (score_away >= 0),
  created_at timestamptz not null default now()
);

create index if not exists game_events_game_id_idx on public.game_events (game_id);
create index if not exists game_events_player_id_idx on public.game_events (player_id) where player_id is not null;
create index if not exists game_events_type_idx on public.game_events (event_type);

comment on table public.game_events is 'Scoring events per game from GET /games/events';
comment on column public.game_events.quarter is 'Quarter name as returned by API: First|Second|Third|Fourth|OT';
comment on column public.game_events.minute is 'Game clock remaining in quarter as MM:SS string';
comment on column public.game_events.event_type is 'TD=touchdown, FG=field goal, SAF=safety, PAT=extra point, 2PT=two-point conversion';
comment on column public.game_events.score_home is 'Cumulative home team score AFTER this event fires';
comment on column public.game_events.score_away is 'Cumulative away team score AFTER this event fires';
