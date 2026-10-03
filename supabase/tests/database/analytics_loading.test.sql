begin;
select plan(14);

insert into public.betting_analysis_runs
  (id, season, stage, week, model_name, context_snapshot, summary, created_at)
select ('99000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  2099, 'Regular Season', case when n = 121 then 'Week 2' else 'Week 1' end,
  'test-model', '{"privateGrounding":"must not be listed"}'::jsonb, 'Test summary',
  '2099-09-01'::timestamptz + n * interval '1 second'
from generate_series(1, 121) n;

insert into public.betting_suggestions (
  run_id, game_id, season, stage, week, kickoff_at,
  away_team_id, away_team_name, home_team_id, home_team_name,
  market, selection, locked_line, confidence, rationale
)
select '99000000-0000-4000-8000-000000000001'::uuid, 1000000 + n, 2099,
  'Regular Season', 'Week 1', '2099-09-01'::timestamptz,
  1, 'Away', 2, 'Home', 'spread', 'home', -3.5, 60, 'Test rationale'
from generate_series(1, 1500) n;

select ok(has_function_privilege('service_role',
  'public.get_weekly_analysis_summaries(integer,text,timestamptz,uuid,integer)', 'execute'),
  'allows service-role summary reads');
select ok(not has_function_privilege('anon',
  'public.get_weekly_analysis_summaries(integer,text,timestamptz,uuid,integer)', 'execute'),
  'keeps summaries private');
select is(jsonb_array_length(public.get_weekly_analysis_summaries(2099)->'runs'), 26,
  'returns only a bounded page and continuation witness');
select is((public.get_weekly_analysis_summaries(2099)->>'total')::integer, 121,
  'counts saved history beyond the old 100-run limit');
select is((public.get_weekly_analysis_summaries(2099)->'record'->>'pending')::integer, 1500,
  'counts suggestions beyond the PostgREST row limit');
select is(jsonb_array_length(public.get_weekly_analysis_summaries(2099)->'weeks'), 2,
  'keeps week options independent of the selected page');
select is((public.get_weekly_analysis_summaries(2099, 'Week 2')->'record'->>'pending')::integer, 1500,
  'keeps the complete season record when filtering a week');
select ok(not (public.get_weekly_analysis_summaries(2099)::text like '%privateGrounding%'),
  'does not transfer grounding snapshots');
select is(
  (public.get_weekly_analysis_summaries(2099, null,
    '2099-09-01'::timestamptz + 96 * interval '1 second',
    '99000000-0000-4000-8000-000000000096')->'runs'->0->>'id'),
  '99000000-0000-4000-8000-000000000095',
  'continues with a stable descending cursor');
select is((public.get_weekly_analysis_summaries(2098)->>'total')::integer, 0,
  'does not mix seasons');
select is((public.get_weekly_analysis_summaries(2098)->>'selectedSeason')::integer, 2098,
  'retains an explicitly requested season even when its history is empty');
select ok((public.get_weekly_analysis_summaries(2099)->'runs'->0->>'isFinal')::boolean,
  'marks the newest run in its week final before pagination');
select ok(not (public.get_weekly_analysis_summaries(2099, null,
  '2099-09-01'::timestamptz + 96 * interval '1 second',
  '99000000-0000-4000-8000-000000000096')->'runs' @> '[{"isFinal":true}]'::jsonb),
  'does not promote an older page to final');
select is((public.get_weekly_analysis_summaries()->>'total')::integer, 0,
  'uses the current season rather than mixing all stored seasons by default');

select * from finish();
rollback;
