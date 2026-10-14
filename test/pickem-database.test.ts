import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'

const container = process.env.PICKEM_TEST_CONTAINER
const database = process.env.PICKEM_TEST_DATABASE ?? 'pickem_checked'
function query(sql: string) {
  assert(container?.startsWith('pickem-test-'), 'SQL race tests require an explicitly named isolated pickem-test- container')
  const process = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At'])
  let output = ''
  let error = ''
  let signal: () => void = () => {}
  const locked = new Promise<void>((resolve) => { signal = resolve })
  process.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('LOCK_HELD')) signal() })
  process.stderr.on('data', (chunk: Buffer) => { error += chunk.toString() })
  const done = new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
    process.once('error', reject)
    process.once('close', (code) => { signal(); resolve({ code, output, error }) })
  })
  process.stdin.end(sql)
  return { locked, done }
}
const gameId = 2000002001
const input = `(select jsonb_agg(jsonb_build_object(
  'game_id',id,'kickoff_at',to_timestamp(game_timestamp),
  'away_team_id',away_team_id,'away_team_name','Pickem Race Away',
  'home_team_id',home_team_id,'home_team_name','Pickem Race Home','winner_team_id',home_team_id,
  'confidence',60,'supporting_points','[{"text":"Limited home evidence.","evidenceIds":["home"]}]'::jsonb,
  'risks','[{"text":"Uncertain outcome.","evidenceIds":["risk"]}]'::jsonb,
  'model_name','test','analyzed_at',now(),'source_refreshed_at',now(),
  'evidence_snapshot','{}'::jsonb,'evidence_key','{}'::jsonb
)) from public.games where id=${gameId})`

describe('Pickem PostgreSQL concurrent saves', { skip: !container }, () => {
  for (const initialRevision of [0, 1]) {
    it(`serializes concurrent ${initialRevision ? 'reruns' : 'first saves'} without overwriting a newer result`, { timeout: 15000 }, async () => {
      const week = `Race ${initialRevision}`
      const setup = await query(`
        insert into public.teams(id,name) values (2000002001,'Pickem Race Away'),(2000002002,'Pickem Race Home') on conflict do nothing;
        insert into public.games(id,season,stage,week,away_team_id,home_team_id,game_timestamp,status_short)
          values (${gameId},2088,'Regular Season','${week}',2000002001,2000002002,extract(epoch from now()+interval '3 hours'),'NS')
          on conflict(id) do update set week=excluded.week;
        ${initialRevision ? `select public.save_pickem_analysis(2088,'Regular Season','${week}',0,${input});` : ''}
      `).done
      assert.equal(setup.code, 0, setup.error)
      const save = `select public.save_pickem_analysis(2088,'Regular Season','${week}',${initialRevision},${input});`
      try {
        const first = query(`begin;${save}select 'LOCK_HELD';select pg_sleep(1);commit;`)
        await first.locked
        const second = query(save)
        const [accepted, rejected] = await Promise.all([first.done, second.done])
        assert.equal(accepted.code, 0, accepted.error)
        assert.notEqual(rejected.code, 0)
        assert.match(rejected.error, /Pickem changed while analysis was running/)
        const counts = await query(`select count(*),max(revision) from public.pickem_analyses where season=2088 and week='${week}';`).done
        assert.equal(counts.output.trim(), `1|${initialRevision + 1}`)
      } finally {
        const cleanup = await query(`delete from public.pickem_analyses where season=2088 and week='${week}';delete from public.games where id=${gameId};`).done
        assert.equal(cleanup.code, 0, cleanup.error)
      }
    })
  }
  it('preserves a concurrently settled locked game while updating future predictions', { timeout: 15000 }, async () => {
    const week = 'Grade race'
    const secondGameId = gameId + 1
    const initialInput = input.replace(`where id=${gameId}`, `where id in (${gameId},${secondGameId})`)
    const futureInput = input.replace(`where id=${gameId}`, `where id=${secondGameId}`)
    const savedId = `(select id from public.pickem_analyses where season=2088 and week='${week}')`
    const setup = await query(`
      insert into public.teams(id,name) values (2000002001,'Pickem Race Away'),(2000002002,'Pickem Race Home') on conflict do nothing;
      insert into public.games(id,season,stage,week,away_team_id,home_team_id,game_timestamp,status_short) values
        (${gameId},2088,'Regular Season','${week}',2000002001,2000002002,extract(epoch from now()+interval '3 hours'),'NS'),
        (${secondGameId},2088,'Regular Season','${week}',2000002001,2000002002,extract(epoch from now()+interval '4 hours'),'NS');
      select public.save_pickem_analysis(2088,'Regular Season','${week}',0,${initialInput});
      update public.games set status_short='FT',away_total=20,home_total=21,game_timestamp=extract(epoch from now()-interval '1 hour') where id=${gameId};
    `).done
    assert.equal(setup.code, 0, setup.error)
    try {
      const grading = query(`begin;select public.grade_pickem_analysis(${savedId});select 'LOCK_HELD';select pg_sleep(1);commit;`)
      await grading.locked
      const updating = query(`select public.save_pickem_analysis(2088,'Regular Season','${week}',1,${futureInput});`)
      const [gradeResult, updateResult] = await Promise.all([grading.done, updating.done])
      assert.equal(gradeResult.code, 0, gradeResult.error)
      assert.equal(updateResult.code, 0, updateResult.error)
      const retained = await query(`select p.result,a.revision,p.winner_team_id from public.pickem_predictions p
        join public.pickem_analyses a on a.id=p.analysis_id where p.analysis_id=${savedId} and p.game_id=${gameId};`).done
      assert.equal(retained.output.trim(), 'win|2|2000002002')
    } finally {
      const cleanup = await query(`delete from public.pickem_analyses where season=2088 and week='${week}';
        delete from public.games where id in (${gameId},${secondGameId});`).done
      assert.equal(cleanup.code, 0, cleanup.error)
    }
  })
})
