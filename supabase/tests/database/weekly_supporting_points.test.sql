begin;

select plan(23);

select has_column('public', 'betting_suggestions', 'supporting_points', 'stores supporting points separately');
select ok(public.valid_weekly_supporting_points(null), 'accepts historical suggestions without points');
select ok(public.valid_weekly_supporting_points(
  '[{"text":"Away scored 24 in its prior game, supporting its offense.","evidenceIds":["game.31.score"]}]'
), 'accepts a grounded supporting point');
select ok(not public.valid_weekly_supporting_points('[]'), 'rejects empty supporting lists');
select ok(not public.valid_weekly_supporting_points('{}'), 'rejects non-array supporting points');
select ok(not public.valid_weekly_supporting_points(
  '[{"text":" ","evidenceIds":["game.31.score"]}]'
), 'rejects empty explanations');
select ok(not public.valid_weekly_supporting_points(
  jsonb_build_array(jsonb_build_object('text', repeat('x', 241), 'evidenceIds', jsonb_build_array('game.31.score')))
), 'rejects oversized explanations');
select ok(not public.valid_weekly_supporting_points(
  '[{"text":"A fact.","evidenceIds":[]}]'
), 'requires evidence references');
select ok(not public.valid_weekly_supporting_points(
  '[{"text":"A fact.","evidenceIds":["game.31.score","game.31.score"]}]'
), 'rejects duplicate evidence references');
select ok(not public.valid_weekly_supporting_points(
  '[{"text":"A fact.","evidenceIds":[31]}]'
), 'rejects non-string evidence references');
select ok(not public.valid_weekly_supporting_points(
  '[{"text":"A fact.","evidenceIds":["game.31.score"],"extra":true}]'
), 'rejects unsupported point fields');
select ok(not public.valid_weekly_supporting_points(
  '[{"text":"A fact.","evidenceIds":["game.31.score"]},{"text":"a FACT.","evidenceIds":["team.1.ats"]}]'
), 'rejects duplicate explanations');
select ok(not public.valid_weekly_supporting_points(
  jsonb_build_array(jsonb_build_object('text', E'\t', 'evidenceIds', jsonb_build_array('game.31.score')))
), 'rejects whitespace-only explanations');
select ok(not public.valid_weekly_supporting_points(
  jsonb_build_array(jsonb_build_object('text', E'One.\nTwo.', 'evidenceIds', jsonb_build_array('game.31.score')))
), 'rejects multiline explanations');
select ok(not public.valid_weekly_supporting_points(
  jsonb_build_array(jsonb_build_object('text', 'A fact.', 'evidenceIds', jsonb_build_array(E'\t')))
), 'rejects whitespace-only evidence IDs');
select ok(not public.valid_weekly_supporting_points(
  (select jsonb_agg(jsonb_build_object('text', 'Fact ' || value, 'evidenceIds', jsonb_build_array('game.31.score')))
   from generate_series(1, 5) as value)
), 'rejects more than four supporting points');

create temporary table supporting_test_run as
select public.save_weekly_betting_analysis(
  2099, 'Regular Season', 'Week 1', 'test-model', '{"matchups":[]}', 'A tracked suggestion.',
  '[{
    "game_id":9005,"kickoff_at":"2099-09-01T17:00:00Z",
    "away_team_id":1,"away_team_name":"Away","home_team_id":2,"home_team_name":"Home",
    "market":"spread","selection":"away","locked_line":3.5,"confidence":61,
    "rationale":"Existing compatible rationale.","supporting_game_ids":[31],
    "supporting_points":[{"text":"Away scored 24 in its prior game.","evidenceIds":["game.31.score"]}]
  }]'
) as id;

select is(
  (select supporting_points from public.betting_suggestions where run_id = (select id from supporting_test_run)),
  '[{"text":"Away scored 24 in its prior game.","evidenceIds":["game.31.score"]}]'::jsonb,
  'round-trips supporting points through the atomic save RPC'
);
select throws_ok(
  $$update public.betting_suggestions set supporting_points = null where run_id = (select id from supporting_test_run)$$,
  'P0001', 'Betting suggestion inputs are immutable.', 'prevents removing supporting points'
);
select throws_ok(
  $$
    update public.betting_suggestions
    set supporting_points = '[{"text":"Changed.","evidenceIds":["game.31.score"]}]'
    where run_id = (select id from supporting_test_run)
  $$,
  'P0001', 'Betting suggestion inputs are immutable.', 'prevents editing supporting points'
);
update public.betting_suggestions
set result = 'win', result_delta = 0.5, final_away_score = 20, final_home_score = 23, graded_at = now()
where run_id = (select id from supporting_test_run);
select is(
  (select result from public.betting_suggestions where run_id = (select id from supporting_test_run)),
  'win', 'still allows settlement'
);
select throws_ok(
  $$
    select public.save_weekly_betting_analysis(
      2099, 'Regular Season', 'Invalid points', 'test-model', '{}', 'Should roll back.',
      '[{
        "game_id":9006,"kickoff_at":"2099-09-01T17:00:00Z",
        "away_team_id":1,"away_team_name":"Away","home_team_id":2,"home_team_name":"Home",
        "market":"spread","selection":"away","locked_line":3.5,"confidence":61,
        "rationale":"Compatible rationale.","supporting_points":[]
      }]'
    )
  $$,
  '23514', null, 'rejects malformed stored supporting points'
);
select is(
  (select count(*)::integer from public.betting_analysis_runs where season = 2099 and week = 'Invalid points'),
  0, 'does not persist a partial run when point validation fails'
);
select public.save_weekly_betting_analysis(
  2099, 'Regular Season', 'Legacy points', 'test-model', '{}', 'Historical-compatible suggestion.',
  '[{
    "game_id":9007,"kickoff_at":"2099-09-01T17:00:00Z",
    "away_team_id":1,"away_team_name":"Away","home_team_id":2,"home_team_name":"Home",
    "market":"total","selection":"over","locked_line":44.5,"confidence":61,"rationale":"Original paragraph."
  }]'
);
select is(
  (select supporting_points from public.betting_suggestions where season = 2099 and week = 'Legacy points'),
  null::jsonb, 'preserves historical paragraphs when points are absent'
);

select * from finish();
rollback;
