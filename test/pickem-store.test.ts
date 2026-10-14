import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createPickemStore } from '../server/pickem-store'
import { buildPickemEvidence, PickemError, type PickemDraft } from '../server/pickem-analysis'
import { matchupSnapshot } from './matchup-report-fixtures'
import { pickemAnalysis, pickemWeek } from './pickem-fixtures'

const pick = pickemAnalysis.predictions[0]
const row = {
  id: pickemAnalysis.id, season: pickemWeek.season, stage: pickemWeek.stage, week: pickemWeek.week,
  revision: 1, summary: pickemAnalysis.summary, changes: [], created_at: pickemAnalysis.createdAt, updated_at: pickemAnalysis.updatedAt,
}
const predictionRow = {
  analysis_id: row.id, game_id: pick.gameId, kickoff_at: pick.kickoffAt,
  away_team_id: pick.awayTeamId, away_team_name: pick.awayTeamName, home_team_id: pick.homeTeamId, home_team_name: pick.homeTeamName,
  winner_team_id: pick.winnerTeamId, confidence: pick.confidence, supporting_points: pick.supportingPoints,
  risks: pick.risks, model_name: pick.model, analyzed_at: pick.analyzedAt,
  source_refreshed_at: pick.sourceRefreshedAt, data_warnings: pick.dataWarnings,
  result: pick.result, final_away_score: null, final_home_score: null, graded_at: null,
}
const gameRow = {
  id: pick.gameId, season: pickemWeek.season, stage: pickemWeek.stage, week: pickemWeek.week,
  game_timestamp: Date.parse(pick.kickoffAt) / 1000, status_short: 'NS',
  away_team_id: 29, home_team_id: 26, away_total: null, home_total: null,
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
})
function client(fetcher: (url: URL, init?: RequestInit) => Promise<Response>) {
  return createClient('http://localhost:9999', 'test-key', {
    global: { fetch: (input, init) => fetcher(new URL(String(input)), init) },
  })
}
function readResponse(url: URL) {
  if (url.pathname.endsWith('/pickem_analyses')) return json(url.searchParams.has('week') ? row : [row])
  if (url.pathname.endsWith('/pickem_predictions')) return json([predictionRow])
  if (url.pathname.endsWith('/games')) return json([gameRow])
  if (url.pathname.endsWith('/teams')) return json([{ id: 29, name: 'Dallas' }, { id: 26, name: 'Houston' }])
  if (url.pathname.endsWith('/get_game_consensus_odds')) return json([{ game_id: pick.gameId, home_spread: -7, total: 44 }])
  throw new Error(`Unexpected database request ${url}`)
}
describe('Pickem Supabase persistence adapter', () => {
  it('loads saved predictions with grading and original evidence-refresh provenance but no raw evidence snapshot', async () => {
    const paths: URL[] = []
    const store = createPickemStore(client(async (url) => { paths.push(url); return readResponse(url) }))
    const view = await store.week(pickemWeek, '2026-09-24T12:00:00Z')
    assert.deepEqual(view.analysis, pickemAnalysis)
    assert.equal(view.games[0].eligible, true)
    assert.equal(view.games[0].homeSpread, -7)
    assert(paths.every((url) => !url.searchParams.get('select')?.includes('evidence_snapshot')))
  })
  it('orders Week 9 before Week 10 by kickoff, excludes preseason, and chooses remaining games in a partly started week', async () => {
    const rows = [
      { ...gameRow, id: 1, stage: 'Pre Season', week: 'Week 1', game_timestamp: Date.parse('2026-08-01') / 1000 },
      { ...gameRow, id: 2, week: 'Week 9', status_short: 'FT', game_timestamp: Date.parse('2026-11-01') / 1000 },
      { ...gameRow, id: 3, week: 'Week 9', game_timestamp: Date.parse('2026-11-02') / 1000 },
      { ...gameRow, id: 4, week: 'Week 10', game_timestamp: Date.parse('2026-11-10') / 1000 },
    ]
    const store = createPickemStore(client(async (url) => {
      if (url.pathname.endsWith('/games')) return json(rows)
      if (url.pathname.endsWith('/pickem_analyses')) return json([])
      return readResponse(url)
    }))
    const weeks = await store.weeks(2026, '2026-11-01T12:00:00Z')
    assert.deepEqual(weeks.weeks.map((week) => week.week), ['Week 9', 'Week 10'])
    assert.equal(weeks.defaultWeek?.week, 'Week 9')
  })
  it('computes season records from lean result projections, counting canonical picks once', async () => {
    const selectors: string[] = []
    const store = createPickemStore(client(async (url) => {
      selectors.push(url.searchParams.get('select') ?? '')
      if (url.pathname.endsWith('/pickem_predictions')) return json([{ result: 'win' }, { result: 'tie' }, { result: 'void' }])
      return readResponse(url)
    }))
    const weeks = await store.weeks(2026, '2026-09-24T12:00:00Z')
    assert.deepEqual(weeks.record, { wins: 1, losses: 0, ties: 1, pending: 0, void: 1 })
    assert(selectors.includes('result'))
    assert(selectors.every((fields) => !fields.includes('supporting_points') && !fields.includes('changes')))
  })
  it('keeps a started saved game visible when the schedule row disappears', async () => {
    const store = createPickemStore(client(async (url) => {
      if (url.pathname.endsWith('/games')) return json([])
      return readResponse(url)
    }))
    const view = await store.week(pickemWeek, '2026-10-05T12:00:00Z')
    assert.equal(view.games[0].gameId, pick.gameId)
    assert.equal(view.games[0].status, null)
    assert.equal(view.games[0].locked, true)
    assert.equal(view.games[0].eligible, false)
  })
  it('saves only fresh validated predictions with the expected revision and per-game provenance', async () => {
    let payload: Record<string, unknown> | null = null
    const store = createPickemStore(client(async (url, init) => {
      if (url.pathname.endsWith('/save_pickem_analysis')) {
        payload = JSON.parse(String(init?.body)) as Record<string, unknown>
        return json(row.id)
      }
      return readResponse(url)
    }))
    const draft: PickemDraft = {
      gameId: pick.gameId, winnerTeamId: pick.winnerTeamId, confidence: pick.confidence,
      supportingPoints: pick.supportingPoints, risks: pick.risks, model: pick.model,
      analyzedAt: pick.analyzedAt, evidence: buildPickemEvidence(matchupSnapshot, [], pick.sourceRefreshedAt),
    }
    assert.equal((await store.save(pickemWeek, 1, [draft])).id, row.id)
    assert(payload)
    assert.equal(Reflect.get(payload, 'expected_revision'), 1)
    const inputs = Reflect.get(payload, 'requested_predictions') as Array<Record<string, unknown>>
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].winner_team_id, 29)
    assert.equal(inputs[0].source_refreshed_at, pick.sourceRefreshedAt)
    assert(!Object.hasOwn(inputs[0], 'locked_line'))
  })
  it('surfaces database conflicts instead of returning success-shaped saved content', async () => {
    const store = createPickemStore(client(async () => json({ code: 'P0001', message: 'Kickoff passed' }, 400)))
    await assert.rejects(store.save(pickemWeek, 1, []), (error) => error instanceof PickemError && error.code === 'pickem_conflict')
  })
})
