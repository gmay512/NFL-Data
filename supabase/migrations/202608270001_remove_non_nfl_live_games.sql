create temporary table non_nfl_live_team_ids on commit drop as
select home_team_id as team_id
from public.games
where league_id <> 1
union
select away_team_id
from public.games
where league_id <> 1;

delete from public.odds
where game_id in (
  select id
  from public.games
  where league_id <> 1
);

delete from public.game_events
where game_id in (
  select id
  from public.games
  where league_id <> 1
);

delete from public.games
where league_id <> 1;

delete from public.standings
where league_id <> 1;

delete from public.leagues
where id <> 1;

delete from public.teams as team
where team.id in (
  select team_id
  from non_nfl_live_team_ids
  where team_id is not null
)
and not exists (
  select 1 from public.games where home_team_id = team.id or away_team_id = team.id
)
and not exists (
  select 1 from public.game_events where team_id = team.id
)
and not exists (
  select 1 from public.game_team_stats where team_id = team.id
)
and not exists (
  select 1 from public.game_player_stats where team_id = team.id
)
and not exists (
  select 1 from public.injuries where team_id = team.id
)
and not exists (
  select 1 from public.player_season_stats where team_id = team.id
)
and not exists (
  select 1 from public.standings where team_id = team.id
);
