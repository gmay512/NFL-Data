alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.game_events enable row level security;

grant usage on schema public to anon, authenticated, service_role;
grant select on public.teams, public.players, public.games, public.game_events to anon, authenticated;
grant all on public.teams, public.players, public.games, public.game_events to service_role;

drop policy if exists public_read_teams on public.teams;
create policy public_read_teams on public.teams for select to anon using (true);

drop policy if exists public_read_players on public.players;
create policy public_read_players on public.players for select to anon using (true);

drop policy if exists public_read_games on public.games;
create policy public_read_games on public.games for select to anon using (true);

drop policy if exists public_read_game_events on public.game_events;
create policy public_read_game_events on public.game_events for select to anon using (true);

drop policy if exists service_all_teams on public.teams;
create policy service_all_teams on public.teams for all to service_role using (true) with check (true);

drop policy if exists service_all_players on public.players;
create policy service_all_players on public.players for all to service_role using (true) with check (true);

drop policy if exists service_all_games on public.games;
create policy service_all_games on public.games for all to service_role using (true) with check (true);

drop policy if exists service_all_game_events on public.game_events;
create policy service_all_game_events on public.game_events for all to service_role using (true) with check (true);
