begin;

select plan(10);

select has_table(
  'public',
  'betting_suggestion_loss_analyses',
  'creates stored betting loss analyses'
);
select ok(
  not has_table_privilege('anon', 'public.betting_suggestion_loss_analyses', 'select'),
  'keeps loss analyses private'
);
select ok(
  has_table_privilege('service_role', 'public.betting_suggestion_loss_analyses', 'insert'),
  'allows service writes'
);

insert into public.betting_analysis_runs (
  id, season, stage, week, model_name, context_snapshot, summary
) values (
  '99100000-0000-4000-8000-000000000099', 2099, 'Regular Season', 'Week 1',
  'test-model', '{"matchups":[]}'::jsonb, 'Test run.'
);

insert into public.betting_suggestions (
  run_id, game_id, season, stage, week, kickoff_at,
  away_team_id, away_team_name, home_team_id, home_team_name,
  market, selection, locked_line, confidence, rationale,
  result, result_delta, final_away_score, final_home_score, graded_at
) values
(
  '99100000-0000-4000-8000-000000000099', 9101, 2099, 'Regular Season', 'Week 1', now(),
  1, 'Away', 2, 'Home', 'spread', 'away', 3.5, 60, 'Test loss.',
  'loss', -2.5, 20, 26, now()
),
(
  '99100000-0000-4000-8000-000000000099', 9102, 2099, 'Regular Season', 'Week 1', now(),
  1, 'Away', 2, 'Home', 'total', 'under', 45.5, 55, 'Test win.',
  'win', 1.5, 20, 24, now()
);

select throws_ok(
  $$
    insert into public.betting_suggestion_loss_analyses (
      suggestion_id, analysis_version, model_name, evidence_snapshot, summary, clues
    )
    select id, 1, 'test-model', '{"metrics":{}}'::jsonb, 'Invalid win analysis.',
      '[{"category":"scoring","title":"Score","explanation":"Test","metricKeys":["outcome.finalTotal"]}]'::jsonb
    from public.betting_suggestions where game_id = 9102
  $$,
  'P0001', 'Only losing betting suggestions can be analyzed.', 'rejects analysis for a winning suggestion'
);

insert into public.betting_suggestion_loss_analyses (
  suggestion_id, analysis_version, model_name, evidence_snapshot, summary, clues, missing_metrics
)
select id, 1, 'test-model',
  '{"metrics":{"outcome.resultDelta":{"label":"Suggestion result margin","value":-2.5}}}'::jsonb,
  'Turnovers and efficiency were the strongest available clues.',
  '[{"category":"efficiency","title":"Efficiency gap","explanation":"The selected team was less efficient.","metricKeys":["outcome.resultDelta"]}]'::jsonb,
  array['Away red-zone efficiency']
from public.betting_suggestions where game_id = 9101;

select is(
  (select model_name from public.betting_suggestion_loss_analyses),
  'test-model',
  'stores the model used'
);
select is(
  (select missing_metrics[1] from public.betting_suggestion_loss_analyses),
  'Away red-zone efficiency',
  'stores missing metrics'
);
select throws_ok(
  $$
    insert into public.betting_suggestion_loss_analyses (
      suggestion_id, analysis_version, model_name, evidence_snapshot, summary, clues
    )
    select id, 1, 'test-model', '{"metrics":{}}'::jsonb, 'Duplicate.',
      '[{"category":"insufficient_evidence","title":"Limited evidence","explanation":"No supported clue.","metricKeys":[]}]'::jsonb
    from public.betting_suggestions where game_id = 9101
  $$,
  '23505', null, 'allows only one current analysis per suggestion'
);
select throws_ok(
  $$update public.betting_suggestion_loss_analyses set summary = 'Changed'$$,
  'P0001', 'Betting loss analyses are immutable.', 'prevents analysis updates'
);

delete from public.betting_suggestion_loss_analyses;
select is(
  (select count(*)::integer from public.betting_suggestion_loss_analyses),
  0,
  'deletes an individual loss analysis'
);

insert into public.betting_suggestion_loss_analyses (
  suggestion_id, analysis_version, model_name, evidence_snapshot, summary, clues
)
select id, 1, 'test-model', '{"metrics":{}}'::jsonb, 'Stored again.',
  '[{"category":"insufficient_evidence","title":"Limited evidence","explanation":"No supported clue.","metricKeys":[]}]'::jsonb
from public.betting_suggestions where game_id = 9101;

delete from public.betting_analysis_runs where id = '99100000-0000-4000-8000-000000000099';
select is(
  (select count(*)::integer from public.betting_suggestion_loss_analyses),
  0,
  'cascades analysis deletion with its weekly run'
);

select * from finish();
rollback;
