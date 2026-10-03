import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { it } from 'node:test'

it('prunes every dependency atomically while preserving current/future data and allowing reloads', {
  skip: process.env.NFL_CLEANUP_TEST !== '1' ? 'Set NFL_CLEANUP_TEST=1 with local Supabase running.' : false,
}, () => {
  const container = 'supabase_db_NFL_Data'
  const database = `nfl_cleanup_test_${process.pid}`
  function query(sql: string, db = database, apply = 'off', allowFailure = false) {
    const result = spawnSync('docker', [
      'exec', '-i', container, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1',
      '-v', 'keep_from=2026', '-v', `apply=${apply}`, '-U', 'postgres', '-d', db,
    ], { input: sql, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    if (!allowFailure) assert.equal(result.status, 0, result.stderr)
    return result
  }
  query(`create database ${database};`, 'postgres')
  try {
    const migrations = readdirSync('supabase/migrations').filter((file) => file.endsWith('.sql')).sort()
    query(`begin;\n${migrations.map((file) => readFileSync(`supabase/migrations/${file}`, 'utf8')).join('\n')}\ncommit;`)
    query(`
      insert into public.leagues(id,name) values (1,'NFL');
      insert into public.teams(id,name) values (1,'Away'),(2,'Home');
      insert into public.players(id,name) values (1,'Player');
      insert into public.bookmakers(id,name) values (1,'Book');
      insert into public.bet_types(id,name) values (1,'Asian Handicap');
      insert into public.games(id,season,game_date,home_team_id,away_team_id)
        values (1,2025,'2026-01-20',2,1),(2,2026,'2026-09-01',2,1),(3,2027,'2027-09-01',2,1);
      insert into public.game_events(game_id,team_id,quarter,event_type) values (1,1,'First','TD'),(2,1,'First','TD');
      insert into public.odds(game_id,bookmaker_id,bet_id,bet_value,odd,provider_updated_at)
        values (1,1,1,'Home -3',1.91,now()),(2,1,1,'Home -3',1.91,now());
      insert into public.game_team_stats(game_id,team_id) values (1,1),(2,1);
      insert into public.game_player_stats(game_id,team_id,player_id,stat_group,stat_name)
        values (1,1,1,'passing','yards'),(2,1,1,'passing','yards');
      insert into public.player_season_stats(player_id,team_id,season,stat_group,stat_name)
        values (1,1,2025,'passing','yards'),(1,1,2026,'passing','yards');
      insert into public.standings(league_id,season,team_id) values (1,2025,1),(1,2026,1);
      insert into public.team_rosters(season,league_id,team_id,player_id) values (2025,1,1,1),(2026,1,1,1);
      insert into public.league_seasons(league_id,season_year) values (1,2025),(1,2026);
      insert into public.ingest_resource_status(resource_type,season,entity_id,status)
        values ('schedule',2025,1,'complete'),('schedule',2026,1,'complete');
      insert into public.injuries(player_id,injury_date,status,resolved_at)
        values (1,'2025-10-01','resolved',now()),(1,'2025-10-02','active',null),(1,'2026-09-01','resolved',now());
      insert into public.analysis_sessions(id,title,preset_type,filter_snapshot,context_snapshot,model_name)
        values
          ('00000000-0000-4000-8000-000000000001','Old','season_overview','{"season":2025}','{}','test'),
          ('00000000-0000-4000-8000-000000000002','Current','season_overview','{"season":2026}','{}','test'),
          ('00000000-0000-4000-8000-000000000003','Mixed','season_overview','{"season":2026}','{"games":{"items":[{"gameId":1}]}}','test');
      insert into public.analysis_messages(session_id,role,content)
        select id,'assistant','Saved output' from public.analysis_sessions;
      insert into public.betting_analysis_runs(id,season,week,model_name,context_snapshot,summary)
        values
          ('00000000-0000-4000-8000-000000000001',2025,'Week 1','test','{}','Old'),
          ('00000000-0000-4000-8000-000000000002',2026,'Week 1','test','{}','Current');
      insert into public.betting_suggestions(run_id,game_id,season,stage,week,kickoff_at,away_team_id,
        away_team_name,home_team_id,home_team_name,market,selection,locked_line,confidence,rationale,
        result,result_delta,final_away_score,final_home_score,graded_at)
        values ('00000000-0000-4000-8000-000000000001',1,2025,'Regular Season','Week 1',now(),1,'Away',2,'Home',
          'spread','home',-3,60,'Grounded','loss',-3,20,20,now());
      insert into public.betting_suggestion_loss_analyses(suggestion_id,analysis_version,model_name,evidence_snapshot,summary,clues)
        select id,1,'test','{}','Loss explanation','["clue"]' from public.betting_suggestions;
    `)
    const cleanup = readFileSync('scripts/prune-season-data.sql', 'utf8')
    query(cleanup)
    assert.equal(query('select count(*) from public.games;').stdout.trim(), '3')
    query(cleanup, database, 'on')
    assert.equal(query("select string_agg(season::text,',' order by season) from public.games;").stdout.trim(), '2026,2027')
    for (const table of ['game_events', 'odds', 'game_team_stats', 'game_player_stats', 'player_season_stats',
      'standings', 'team_rosters', 'league_seasons', 'ingest_resource_status', 'analysis_sessions', 'analysis_messages',
      'betting_analysis_runs']) {
      assert.equal(query(`select count(*) from public.${table};`).stdout.trim(), '1', table)
    }
    for (const table of ['betting_suggestions', 'betting_suggestion_loss_analyses']) {
      assert.equal(query(`select count(*) from public.${table};`).stdout.trim(), '0', table)
    }
    assert.equal(query('select count(*) from public.injuries;').stdout.trim(), '2')
    assert.equal(query('select count(*) from public.injuries where resolved_at is null;').stdout.trim(), '1')
    assert.equal(query('select count(*) from public.players;').stdout.trim(), '1')
    query(cleanup, database, 'on')
    query("insert into public.games(id,season) values (4,2025); insert into public.injuries(player_id,status,resolved_at) values (1,'unknown',now());")
    const failed = query(cleanup, database, 'on', true)
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /Undated resolved injuries require review/)
    assert.equal(query('select count(*) from public.games where season=2025;').stdout.trim(), '1')
    query('delete from public.injuries where injury_date is null;')
    query(cleanup, database, 'on')
    assert.equal(query('select count(*) from public.games;').stdout.trim(), '2')
  } finally {
    query(`drop database ${database};`, 'postgres')
  }
})
