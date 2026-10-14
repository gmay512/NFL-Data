begin;
select plan(45);

select has_table('public', 'pickem_analyses', 'creates canonical Pickem analyses');
select has_table('public', 'pickem_predictions', 'creates outright predictions');
select ok(not has_table_privilege('anon', 'public.pickem_predictions', 'select'), 'predictions are private');
select ok(not has_function_privilege('authenticated', 'public.save_pickem_analysis(integer,text,text,integer,jsonb)', 'execute'), 'browser cannot save directly');
select ok(has_function_privilege('service_role', 'public.grade_pickem_analysis(uuid)', 'execute'), 'service can grade');

insert into public.teams (id, name) values (2000001001, 'Pickem Test Away'), (2000001002, 'Pickem Test Home');
insert into public.games (id, season, stage, week, away_team_id, home_team_id, game_timestamp, status_short)
values
  (2000001001, 2099, 'Regular Season', 'Week 1', 2000001001, 2000001002, extract(epoch from now() + interval '3 hours'), 'NS'),
  (2000001002, 2099, 'Regular Season', 'Week 1', 2000001001, 2000001002, extract(epoch from now() + interval '4 hours'), 'NS'),
  (2000001003, 2099, 'Post Season', 'Week 1', 2000001001, 2000001002, extract(epoch from now() + interval '5 hours'), 'NS');

create function pg_temp.pickem_input(ids integer[]) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object(
    'game_id', id, 'kickoff_at', to_timestamp(game_timestamp),
    'away_team_id', away_team_id, 'away_team_name', 'Pickem Test Away',
    'home_team_id', home_team_id, 'home_team_name', 'Pickem Test Home',
    'winner_team_id', home_team_id, 'confidence', 60,
    'supporting_points', '[{"text":"Home scoring offers limited support.","evidenceIds":["scoring"]}]'::jsonb,
    'risks', '[{"text":"Sparse evidence creates uncertainty.","evidenceIds":["limitations"]}]'::jsonb,
    'model_name', 'test-model', 'analyzed_at', now(),
    'source_refreshed_at', now(), 'data_warnings', '[]'::jsonb,
    'evidence_snapshot', '{"facts":{}}'::jsonb, 'evidence_key', '{"spread":-7}'::jsonb
  ) order by id) from public.games where id = any(ids)
$$;
create temporary table pickem_test_id (id uuid);
insert into pickem_test_id select public.save_pickem_analysis(
  2099, 'Regular Season', 'Week 1', 0, pg_temp.pickem_input(array[2000001001,2000001002]));
select is((select count(*)::integer from public.pickem_analyses where season=2099), 1, 'one analysis initially');
select is((select count(*)::integer from public.pickem_predictions where analysis_id=(select id from pickem_test_id)), 2, 'covers every eligible game');
select is((select revision from public.pickem_analyses where id=(select id from pickem_test_id)), 1, 'initial revision');
select is((select jsonb_array_length(changes) from public.pickem_analyses where id=(select id from pickem_test_id)),0,'first analysis does not carry redundant change evidence');
select throws_ok($$select public.save_pickem_analysis(2099,'Regular Season','Week 1',0,pg_temp.pickem_input(array[2000001001,2000001002]))$$,
  'P0001', 'Pickem changed while analysis was running. Reload the week and retry.', 'stale initial save cannot create a duplicate');
select throws_ok($$select public.save_pickem_analysis(2099,'Regular Season','Week 1',1,pg_temp.pickem_input(array[2000001001]))$$,
  'P0001', 'The eligible Pickem slate changed or kickoff passed. Reload the week and retry.', 'incomplete slate rolls back');

select is(public.save_pickem_analysis(2099,'Regular Season','Week 1',1,
  jsonb_set(pg_temp.pickem_input(array[2000001001,2000001002]), '{0,winner_team_id}', '2000001001')), (select id from pickem_test_id), 'rerun retains canonical ID');
select is((select revision from public.pickem_analyses where id=(select id from pickem_test_id)), 2, 'rerun advances revision');
select is((select changes->0->'before'->>'winnerTeamName' from public.pickem_analyses where id=(select id from pickem_test_id)),
  'Pickem Test Home', 'retains preceding winner');
select is((select changes->0->'after'->>'winnerTeamName' from public.pickem_analyses where id=(select id from pickem_test_id)),
  'Pickem Test Away', 'highlights new winner');
select is((select jsonb_array_length(changes) from public.pickem_analyses where id=(select id from pickem_test_id)), 1, 'only changed game highlighted');
select is((select changes->0->'before'->'evidence' from public.pickem_analyses where id=(select id from pickem_test_id)),
  '{}'::jsonb,'winner-only changes omit unchanged evidence from browser payload');

select public.save_pickem_analysis(2099,'Regular Season','Week 1',2,
  jsonb_set(pg_temp.pickem_input(array[2000001001,2000001002]), '{0,winner_team_id}', '2000001001'));
select is((select jsonb_array_length(changes) from public.pickem_analyses where id=(select id from pickem_test_id)), 0, 'unchanged rerun clears old highlights');
select is((select summary from public.pickem_analyses where id=(select id from pickem_test_id)), 'No prediction changes.', 'reports unchanged rerun');

update public.games set status_short='FT', game_timestamp=extract(epoch from now()-interval '1 hour'),
  away_total=20, home_total=21 where id=2000001001;
select is(public.grade_pickem_analysis((select id from pickem_test_id)), 1, 'grades only final games');
select is((select result from public.pickem_predictions where game_id=2000001001), 'loss', 'away pick loses outright despite home failing to cover');
select is(public.grade_pickem_analysis((select id from pickem_test_id)), 0, 'grading is idempotent');
select throws_ok($$update public.pickem_predictions set winner_team_id=home_team_id where game_id=2000001001$$,
  'P0001', 'Started Pickem predictions are locked.', 'direct updates cannot edit a started pick');
select is(public.save_pickem_analysis(2099,'Regular Season','Week 1',3,
  jsonb_set(pg_temp.pickem_input(array[2000001002]), '{0,confidence}', '65')),
  (select id from pickem_test_id), 'partly started week can update remaining game');
select is((select winner_team_id from public.pickem_predictions where game_id=2000001001), 2000001001, 'locked winner retained');
select is((select result from public.pickem_predictions where game_id=2000001001), 'loss', 'locked grade retained');
select is((select confidence from public.pickem_predictions where game_id=2000001002), 65::smallint, 'future confidence updated');

update public.games set status_short='AOT', away_total=24, home_total=24 where id=2000001002;
select is(public.grade_pickem_analysis((select id from pickem_test_id)), 1, 'grades overtime final');
select is((select result from public.pickem_predictions where game_id=2000001002), 'tie', 'ties are separate from losses');
select lives_ok($$select public.save_pickem_analysis(2099,'Post Season','Week 1',0,pg_temp.pickem_input(array[2000001003]))$$,
  'same week label in playoffs is independent');
update public.games set status_short='CANC' where id=2000001003;
select is(public.grade_pickem_analysis((select id from public.pickem_analyses where season=2099 and stage='Post Season')), 1, 'grades cancellation');
select is((select result from public.pickem_predictions where game_id=2000001003), 'void', 'cancelled prediction is void');
select is((select count(*)::integer from public.pickem_analyses where season=2099 and stage='Regular Season'), 1, 'reruns never duplicate weekly record');

insert into public.games (id, season, stage, week, away_team_id, home_team_id, game_timestamp, status_short)
values
  (2000001004,2099,'Regular Season','Week 2',2000001001,2000001002,extract(epoch from now()+interval '6 hours'),'NS'),
  (2000001005,2099,'Regular Season','Week 2',2000001001,2000001002,extract(epoch from now()+interval '7 hours'),'NS'),
  (2000001006,2098,'Regular Season','Week 1',2000001001,2000001002,extract(epoch from now()+interval '8 hours'),'NS');
select throws_ok($$select public.save_pickem_analysis(2099,'Regular Season','Week 2',0,
  jsonb_set(pg_temp.pickem_input(array[2000001004,2000001005]),'{1,winner_team_id}','99'))$$,
  '23514',null,'invalid later prediction rolls back the whole slate');
select is((select count(*)::integer from public.pickem_analyses where season=2099 and week='Week 2'),0,'failure leaves no partial analysis');
create temporary table pickem_second_id(id uuid);
insert into pickem_second_id select public.save_pickem_analysis(2099,'Regular Season','Week 2',0,
  pg_temp.pickem_input(array[2000001004,2000001005]));
update public.games set status_short='CANC' where id=2000001004;
select is(public.save_pickem_analysis(2099,'Regular Season','Week 2',1,pg_temp.pickem_input(array[2000001005])),
  (select id from pickem_second_id),'cancellation is reconciled in the same analysis');
select is((select count(*)::integer from public.pickem_predictions where analysis_id=(select id from pickem_second_id)),1,'removed future game is not an active pick');
select is((select changes->0->>'kind' from public.pickem_analyses where id=(select id from pickem_second_id)),'removed','removal is highlighted');
select is((select changes->0->'before'->>'winnerTeamName' from public.pickem_analyses where id=(select id from pickem_second_id)),
  'Pickem Test Home','removed prediction remains in latest before/after detail');
update public.games set game_timestamp=extract(epoch from now()-interval '1 minute') where id=2000001005;
select throws_ok($$select public.save_pickem_analysis(2099,'Regular Season','Week 2',2,pg_temp.pickem_input(array[2000001005]))$$,
  'P0001','The eligible Pickem slate changed or kickoff passed. Reload the week and retry.','stale NS status cannot allow a post-kickoff update');
select is((select revision from public.pickem_analyses where id=(select id from pickem_second_id)),2,'kickoff conflict preserves the last revision');
select public.save_pickem_analysis(2098,'Regular Season','Week 1',0,pg_temp.pickem_input(array[2000001006]));
select is((select count(*)::integer from public.pickem_analyses where season=2098 and week='Week 1'),1,'same stage/week in another season is independent');
update public.games set status_short='FT',away_total=20,home_total=21 where id=2000001006;
select public.grade_pickem_analysis((select id from public.pickem_analyses where season=2098 and week='Week 1'));
select is((select result from public.pickem_predictions where game_id=2000001006),'win','home pick wins outright without covering its minus-seven spread');
update public.games set status_short='FT',away_total=null,home_total=null where id=2000001005;
select is(public.grade_pickem_analysis((select id from pickem_second_id)),0,'missing final scores are not graded');
select is((select result from public.pickem_predictions where game_id=2000001005),'pending','missing scores remain pending');

select * from finish();
rollback;
