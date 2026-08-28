-- Grant read access to authenticated users on all data tables.
-- Without these policies, authenticated users receive empty results for SELECT queries
-- because RLS evaluates as the authenticated role when a session exists.

grant select on public.teams to authenticated;
grant select on public.players to authenticated;
grant select on public.games to authenticated;
grant select on public.game_events to authenticated;

create policy public_read_teams_auth
  on public.teams for select to authenticated using (true);
create policy public_read_players_auth
  on public.players for select to authenticated using (true);
create policy public_read_games_auth
  on public.games for select to authenticated using (true);
create policy public_read_game_events_auth
  on public.game_events for select to authenticated using (true);

grant select on public.leagues to authenticated;
grant select on public.league_seasons to authenticated;
grant select on public.injuries to authenticated;
grant select on public.player_season_stats to authenticated;
grant select on public.standings to authenticated;
grant select on public.game_team_stats to authenticated;
grant select on public.game_player_stats to authenticated;

create policy public_read_leagues_auth
  on public.leagues for select to authenticated using (true);
create policy public_read_league_seasons_auth
  on public.league_seasons for select to authenticated using (true);
create policy public_read_injuries_auth
  on public.injuries for select to authenticated using (true);
create policy public_read_player_season_stats_auth
  on public.player_season_stats for select to authenticated using (true);
create policy public_read_standings_auth
  on public.standings for select to authenticated using (true);
create policy public_read_game_team_stats_auth
  on public.game_team_stats for select to authenticated using (true);
create policy public_read_game_player_stats_auth
  on public.game_player_stats for select to authenticated using (true);
