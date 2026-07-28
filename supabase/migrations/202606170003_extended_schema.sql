create table if not exists public.leagues (
  id integer primary key,
  name text not null,
  logo_url text,
  country_name text,
  country_code char(2),
  country_flag_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.league_seasons (
  id bigint generated always as identity primary key,
  league_id integer not null references public.leagues(id) on delete cascade,
  season_year integer not null,
  start_date date,
  end_date date,
  is_current boolean not null default false,
  cov_games_events boolean,
  cov_stats_teams boolean,
  cov_stats_players boolean,
  cov_season_players boolean,
  cov_players boolean,
  cov_injuries boolean,
  cov_standings boolean,
  created_at timestamptz not null default now(),
  unique (league_id, season_year)
);

create index if not exists league_seasons_league_id_idx on public.league_seasons (league_id);
create index if not exists league_seasons_current_idx on public.league_seasons (is_current) where is_current = true;

create table if not exists public.injuries (
  id bigint generated always as identity primary key,
  player_id integer not null references public.players(id),
  team_id integer references public.teams(id),
  injury_date date,
  status text,
  description text,
  created_at timestamptz not null default now(),
  unique (player_id)
);

create index if not exists injuries_team_id_idx on public.injuries (team_id);
create index if not exists injuries_injury_date_idx on public.injuries (injury_date);

create table if not exists public.player_season_stats (
  id bigint generated always as identity primary key,
  player_id integer not null references public.players(id),
  team_id integer not null references public.teams(id),
  season integer not null,
  stat_group text not null,
  stat_name text not null,
  stat_value text,
  created_at timestamptz not null default now(),
  unique (player_id, team_id, season, stat_group, stat_name)
);

create index if not exists player_season_stats_player_season_idx on public.player_season_stats (player_id, season);
create index if not exists player_season_stats_team_season_idx on public.player_season_stats (team_id, season);

create table if not exists public.standings (
  id bigint generated always as identity primary key,
  league_id integer not null references public.leagues(id),
  season integer not null,
  team_id integer not null references public.teams(id),
  conference text check (conference in ('American Football Conference', 'National Football Conference')),
  division text check (division in ('AFC East', 'AFC North', 'AFC South', 'AFC West', 'NFC East', 'NFC North', 'NFC South', 'NFC West')),
  position integer,
  won integer not null default 0,
  lost integer not null default 0,
  ties integer not null default 0,
  points_for integer,
  points_against integer,
  points_diff integer,
  record_home varchar(10),
  record_road varchar(10),
  record_conference varchar(10),
  record_division varchar(10),
  streak varchar(6),
  created_at timestamptz not null default now(),
  unique (league_id, season, team_id)
);

create index if not exists standings_league_season_idx on public.standings (league_id, season);
create index if not exists standings_team_idx on public.standings (team_id);

create table if not exists public.game_team_stats (
  id bigint generated always as identity primary key,
  game_id integer not null references public.games(id) on delete cascade,
  team_id integer not null references public.teams(id),
  fd_total integer,
  fd_passing integer,
  fd_rushing integer,
  fd_penalties integer,
  third_down_eff text,
  fourth_down_eff text,
  plays_total integer,
  yards_total integer,
  yards_per_play text,
  total_drives text,
  pass_yards integer,
  pass_comp_att text,
  pass_yards_per text,
  pass_int integer,
  sacks_yards_lost text,
  rush_yards integer,
  rush_attempts integer,
  rush_yards_per text,
  red_zone text,
  penalties text,
  turnovers_total integer,
  fumbles_lost integer,
  int_turnovers integer,
  possession text,
  def_interceptions integer,
  fumbles_recovered integer,
  sacks integer,
  safeties integer,
  int_touchdowns integer,
  points_against integer,
  created_at timestamptz not null default now(),
  unique (game_id, team_id)
);

create index if not exists game_team_stats_game_id_idx on public.game_team_stats (game_id);
create index if not exists game_team_stats_team_id_idx on public.game_team_stats (team_id);

create table if not exists public.game_player_stats (
  id bigint generated always as identity primary key,
  game_id integer not null references public.games(id) on delete cascade,
  team_id integer not null references public.teams(id),
  player_id integer not null references public.players(id),
  stat_group text not null,
  stat_name text not null,
  stat_value text,
  created_at timestamptz not null default now(),
  unique (game_id, team_id, player_id, stat_group, stat_name)
);

create index if not exists game_player_stats_game_id_idx on public.game_player_stats (game_id);
create index if not exists game_player_stats_player_id_idx on public.game_player_stats (player_id);

comment on table public.leagues is 'League reference data from GET /leagues';
comment on table public.league_seasons is 'Per-season metadata and coverage flags from leagues[].seasons';
comment on table public.injuries is 'Current injuries from GET /injuries (current state per player)';
comment on table public.player_season_stats is 'EAV player season stats from GET /players/statistics';
comment on table public.standings is 'Season standings from GET /standings';
comment on table public.game_team_stats is 'Flattened team box score stats from GET /games/statistics/teams';
comment on table public.game_player_stats is 'EAV game player stats from GET /games/statistics/players';
