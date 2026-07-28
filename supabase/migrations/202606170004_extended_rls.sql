alter table public.leagues enable row level security;
alter table public.league_seasons enable row level security;
alter table public.injuries enable row level security;
alter table public.player_season_stats enable row level security;
alter table public.standings enable row level security;
alter table public.game_team_stats enable row level security;
alter table public.game_player_stats enable row level security;

grant select on public.leagues, public.league_seasons, public.injuries, public.player_season_stats, public.standings, public.game_team_stats, public.game_player_stats to anon, authenticated;
grant all on public.leagues, public.league_seasons, public.injuries, public.player_season_stats, public.standings, public.game_team_stats, public.game_player_stats to service_role;

drop policy if exists public_read_leagues on public.leagues;
create policy public_read_leagues on public.leagues for select to anon using (true);

drop policy if exists public_read_league_seasons on public.league_seasons;
create policy public_read_league_seasons on public.league_seasons for select to anon using (true);

drop policy if exists public_read_injuries on public.injuries;
create policy public_read_injuries on public.injuries for select to anon using (true);

drop policy if exists public_read_player_season_stats on public.player_season_stats;
create policy public_read_player_season_stats on public.player_season_stats for select to anon using (true);

drop policy if exists public_read_standings on public.standings;
create policy public_read_standings on public.standings for select to anon using (true);

drop policy if exists public_read_game_team_stats on public.game_team_stats;
create policy public_read_game_team_stats on public.game_team_stats for select to anon using (true);

drop policy if exists public_read_game_player_stats on public.game_player_stats;
create policy public_read_game_player_stats on public.game_player_stats for select to anon using (true);

drop policy if exists service_all_leagues on public.leagues;
create policy service_all_leagues on public.leagues for all to service_role using (true) with check (true);

drop policy if exists service_all_league_seasons on public.league_seasons;
create policy service_all_league_seasons on public.league_seasons for all to service_role using (true) with check (true);

drop policy if exists service_all_injuries on public.injuries;
create policy service_all_injuries on public.injuries for all to service_role using (true) with check (true);

drop policy if exists service_all_player_season_stats on public.player_season_stats;
create policy service_all_player_season_stats on public.player_season_stats for all to service_role using (true) with check (true);

drop policy if exists service_all_standings on public.standings;
create policy service_all_standings on public.standings for all to service_role using (true) with check (true);

drop policy if exists service_all_game_team_stats on public.game_team_stats;
create policy service_all_game_team_stats on public.game_team_stats for all to service_role using (true) with check (true);

drop policy if exists service_all_game_player_stats on public.game_player_stats;
create policy service_all_game_player_stats on public.game_player_stats for all to service_role using (true) with check (true);
