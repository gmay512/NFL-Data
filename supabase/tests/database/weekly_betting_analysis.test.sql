begin;

select plan(12);

select has_table('public', 'betting_analysis_runs', 'creates weekly analysis runs');
select has_table('public', 'betting_suggestions', 'creates tracked suggestions');
select ok(not has_table_privilege('anon', 'public.betting_suggestions', 'select'), 'keeps suggestions private');
select ok(has_table_privilege('service_role', 'public.betting_suggestions', 'insert'), 'allows service writes');

insert into public.betting_analysis_runs (
  id, season, stage, week, model_name, context_snapshot, summary
) values (
  '99000000-0000-4000-8000-000000000099', 2099, 'Regular Season', 'Week 1',
  'test-model', '{"games":[]}'::jsonb, 'No strong totals positions.'
);

select throws_ok(
  $$
    update public.betting_analysis_runs
    set summary = 'Changed'
    where id = '99000000-0000-4000-8000-000000000099'
  $$,
  'P0001', 'Betting analysis runs are immutable.', 'keeps run context immutable'
);

insert into public.betting_suggestions (
  run_id, game_id, season, stage, week, kickoff_at,
  away_team_id, away_team_name, home_team_id, home_team_name,
  market, selection, locked_line, confidence, rationale
) values (
  '99000000-0000-4000-8000-000000000099', 9001, 2099, 'Regular Season', 'Week 1',
  '2099-09-01 17:00:00+00', 1, 'Away', 2, 'Home',
  'spread', 'home', -3.5, 62, 'Supported by the supplied ATS sample.'
);

select is((select locked_line from public.betting_suggestions where game_id = 9001), -3.5::numeric, 'locks the line');
select is((select result from public.betting_suggestions where game_id = 9001), 'ungraded', 'starts ungraded');

select throws_ok(
  $$update public.betting_suggestions set locked_line = -4 where game_id = 9001$$,
  'P0001', 'Betting suggestion inputs are immutable.', 'prevents line edits'
);

update public.betting_suggestions
set result = 'win', result_delta = 3.5, final_away_score = 20, final_home_score = 27, graded_at = now()
where game_id = 9001;

select is((select result from public.betting_suggestions where game_id = 9001), 'win', 'allows settlement');

select throws_ok(
  $$
    insert into public.betting_suggestions (
      run_id, game_id, season, week, kickoff_at,
      away_team_id, away_team_name, home_team_id, home_team_name,
      market, selection, locked_line, confidence, rationale
    ) values (
      '99000000-0000-4000-8000-000000000099', 9002, 2099, 'Week 1', now(),
      1, 'Away', 2, 'Home', 'total', 'home', 44.5, 50, 'Invalid selection'
    )
  $$,
  '23514', null, 'rejects market-incompatible selections'
);

delete from public.betting_analysis_runs where id = '99000000-0000-4000-8000-000000000099';
select is((select count(*)::integer from public.betting_suggestions where game_id = 9001), 0, 'deletes picks with their run');
select is((select count(*)::integer from public.games where id = 9001), 0, 'does not require a game row');

select * from finish();
rollback;
