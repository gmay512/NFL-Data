import type { SupabaseClient } from '@supabase/supabase-js'
import { getCurrentConsensusOdds } from '../src/data/current-consensus'
import type { PickemAnalysis, PickemGame, PickemPrediction, PickemWeek, PickemWeeksResponse } from '../src/api/pickem-contracts'
import { AnalyticsDatabaseError, readAllRows } from './analytics-reads'
import {
  isPickemStage, PickemError, pickemGameEligibility, pickemRecord, type PickemDraft, type PickemStore,
} from './pickem-analysis'

type AnalysisRow = {
  id: string; season: number; stage: string | null; week: string; revision: number
  summary: string; changes: PickemAnalysis['changes']; created_at: string; updated_at: string
}
type PredictionRow = {
  analysis_id: string; game_id: number; kickoff_at: string
  away_team_id: number; away_team_name: string; home_team_id: number; home_team_name: string
  winner_team_id: number; confidence: number; supporting_points: PickemPrediction['supportingPoints']
  risks: PickemPrediction['risks']; model_name: string; analyzed_at: string; result: PickemPrediction['result']
  source_refreshed_at: string; data_warnings: string[]
  final_away_score: number | null; final_home_score: number | null; graded_at: string | null
}
type GameRow = {
  id: number; season: number; stage: string | null; week: string | null; game_timestamp: number | null
  away_team_id: number | null; home_team_id: number | null; status_short: string | null
  away_total: number | null; home_total: number | null
}
const analysisColumns = 'id,season,stage,week,revision,summary,changes,created_at,updated_at'
const predictionColumns = 'analysis_id,game_id,kickoff_at,away_team_id,away_team_name,home_team_id,home_team_name,winner_team_id,confidence,supporting_points,risks,model_name,analyzed_at,source_refreshed_at,data_warnings,result,final_away_score,final_home_score,graded_at'
const gameColumns = 'id,season,stage,week,game_timestamp,away_team_id,home_team_id,status_short,away_total,home_total'

function check(error: { message: string; code?: string } | null) {
  if (!error) return
  if (error.code === 'P0001') throw new PickemError('pickem_conflict', error.message)
  if (error.code === '22023') throw new PickemError('invalid_pickem', error.message)
  throw new AnalyticsDatabaseError('Pickem database request failed', error)
}
function prediction(row: PredictionRow): PickemPrediction {
  return {
    gameId: row.game_id, kickoffAt: row.kickoff_at, awayTeamId: row.away_team_id,
    awayTeamName: row.away_team_name, homeTeamId: row.home_team_id, homeTeamName: row.home_team_name,
    winnerTeamId: row.winner_team_id, confidence: row.confidence, supportingPoints: row.supporting_points,
    risks: row.risks, model: row.model_name, analyzedAt: row.analyzed_at, result: row.result,
    sourceRefreshedAt: row.source_refreshed_at, dataWarnings: row.data_warnings,
    finalAwayScore: row.final_away_score, finalHomeScore: row.final_home_score, gradedAt: row.graded_at,
  }
}
function analysis(row: AnalysisRow, picks: PredictionRow[]): PickemAnalysis {
  return {
    id: row.id, season: row.season, stage: row.stage, week: row.week, revision: row.revision,
    summary: row.summary, changes: row.changes, createdAt: row.created_at, updatedAt: row.updated_at,
    predictions: picks.map(prediction),
  }
}
function key(week: PickemWeek) { return JSON.stringify([week.season, week.stage, week.week]) }
function kickoff(timestamp: number | null) {
  return timestamp != null && Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : null
}

export function createPickemStore(client: SupabaseClient): PickemStore {
  const readAnalysis = async (week: PickemWeek, signal?: AbortSignal) => {
    let query = client.from('pickem_analyses').select(analysisColumns).eq('season', week.season).eq('week', week.week)
    query = week.stage == null ? query.is('stage', null) : query.eq('stage', week.stage)
    if (signal) query = query.abortSignal(signal)
    const { data, error } = await query.maybeSingle()
    check(error)
    if (!data) return null
    let picksQuery = client.from('pickem_predictions').select(predictionColumns).eq('analysis_id', data.id).order('kickoff_at').order('game_id')
    if (signal) picksQuery = picksQuery.abortSignal(signal)
    const { data: picks, error: picksError } = await picksQuery
    check(picksError)
    return analysis(data as AnalysisRow, (picks ?? []) as PredictionRow[])
  }
  return {
    async weeks(season, now, signal) {
      const [games, analyses] = await Promise.all([
        readAllRows<GameRow>((from, to) => {
          let query = client.from('games').select(gameColumns).eq('season', season).order('game_timestamp').order('id').range(from, to)
          if (signal) query = query.abortSignal(signal)
          return query
        }, 'Could not load Pickem weeks'),
        readAllRows<Pick<AnalysisRow, 'id' | 'season' | 'stage' | 'week' | 'revision'>>((from, to) => {
          let query = client.from('pickem_analyses').select('id,season,stage,week,revision').eq('season', season).order('id').range(from, to)
          if (signal) query = query.abortSignal(signal)
          return query
        }, 'Could not load Pickem summaries'),
      ])
      const groups = new Map<string, PickemWeeksResponse['weeks'][number]>()
      for (const game of games.filter((item) => isPickemStage(item.stage) && item.week)) {
        const week = { season, stage: game.stage, week: game.week! }
        const existing = groups.get(key(week))
        const date = kickoff(game.game_timestamp)
        groups.set(key(week), {
          ...week, firstKickoff: existing?.firstKickoff ?? date,
          analysisId: null, revision: 0,
        })
      }
      const predictions: Array<Pick<PickemPrediction, 'result'>> = []
      for (const row of analyses) {
        const week = { season, stage: row.stage, week: row.week }
        const existing = groups.get(key(week))
        groups.set(key(week), { ...week, firstKickoff: existing?.firstKickoff ?? null, analysisId: row.id, revision: row.revision })
        const saved = await readAllRows<Pick<PickemPrediction, 'result'>>((from, to) => {
          let query = client.from('pickem_predictions').select('result').eq('analysis_id', row.id).order('game_id').range(from, to)
          if (signal) query = query.abortSignal(signal)
          return query
        }, 'Could not load Pickem record')
        predictions.push(...saved)
      }
      const upcoming = games.filter((game) => isPickemStage(game.stage) && game.week && game.status_short === 'NS'
        && game.game_timestamp != null && game.game_timestamp * 1000 > Date.parse(now))
        .sort((a, b) => a.game_timestamp! - b.game_timestamp! || a.id - b.id)[0]
      const weeks = [...groups.values()].sort((a, b) =>
        (a.firstKickoff ?? '9999').localeCompare(b.firstKickoff ?? '9999') || key(a).localeCompare(key(b)))
      return {
        weeks, defaultWeek: upcoming ? { season, stage: upcoming.stage, week: upcoming.week! } : weeks.at(-1) ?? null,
        record: pickemRecord(predictions),
      }
    },

    async week(week, now, signal) {
      let query = client.from('games').select(gameColumns).eq('season', week.season).eq('week', week.week)
        .order('game_timestamp').order('id')
      query = week.stage == null ? query.is('stage', null) : query.eq('stage', week.stage)
      if (signal) query = query.abortSignal(signal)
      const [result, saved] = await Promise.all([query, readAnalysis(week, signal)])
      check(result.error)
      const rows = (result.data ?? []) as GameRow[]
      const teamIds = [...new Set(rows.flatMap((row) => [row.away_team_id, row.home_team_id]).filter((id): id is number => id != null))]
      let teamQuery = client.from('teams').select('id,name').in('id', teamIds)
      if (signal) teamQuery = teamQuery.abortSignal(signal)
      const [teams, odds] = await Promise.all([
        teamIds.length ? teamQuery : Promise.resolve({ data: [], error: null }),
        rows.length ? getCurrentConsensusOdds(client, rows.map((row) => row.id), undefined, signal) : Promise.resolve([]),
      ])
      check(teams.error)
      const names = new Map((teams.data ?? []).map((row) => [Number(row.id), String(row.name)]))
      const spreads = new Map(odds.map((row) => [Number(row.game_id), row.home_spread]))
      const games: PickemGame[] = rows.map((row) => {
        const pick = saved?.predictions.find((item) => item.gameId === row.id)
        const game = {
          gameId: row.id, kickoffAt: kickoff(row.game_timestamp), status: row.status_short,
          awayTeamId: row.away_team_id, awayTeamName: names.get(row.away_team_id ?? 0) ?? pick?.awayTeamName ?? 'Away team unavailable',
          homeTeamId: row.home_team_id, homeTeamName: names.get(row.home_team_id ?? 0) ?? pick?.homeTeamName ?? 'Home team unavailable',
          homeSpread: spreads.get(row.id) ?? null, awayScore: row.away_total, homeScore: row.home_total,
        }
        return { ...game, ...pickemGameEligibility(game, now, pick) }
      })
      for (const pick of saved?.predictions ?? []) {
        if (!games.some((game) => game.gameId === pick.gameId)) {
          games.push({
            gameId: pick.gameId, kickoffAt: pick.kickoffAt, status: null,
            awayTeamId: pick.awayTeamId, awayTeamName: pick.awayTeamName,
            homeTeamId: pick.homeTeamId, homeTeamName: pick.homeTeamName, homeSpread: null,
            awayScore: pick.finalAwayScore, homeScore: pick.finalHomeScore, eligible: false,
            locked: Date.parse(pick.kickoffAt) <= Date.parse(now) || pick.result !== 'pending',
          })
        }
      }
      games.sort((a, b) => (a.kickoffAt ?? '9999').localeCompare(b.kickoffAt ?? '9999') || a.gameId - b.gameId)
      return { ...week, games, analysis: saved, record: pickemRecord(saved?.predictions ?? []) }
    },

    async save(week, revision, drafts: PickemDraft[]) {
      const { data, error } = await client.rpc('save_pickem_analysis', {
        requested_season: week.season, requested_stage: week.stage, requested_week: week.week,
        expected_revision: revision,
        requested_predictions: drafts.map((draft) => {
          const target = draft.evidence.snapshot.targetMatchup!
          return {
            game_id: draft.gameId, kickoff_at: new Date(target.kickoff.timestamp * 1000).toISOString(),
            away_team_id: target.awayTeam.id, away_team_name: target.awayTeam.name,
            home_team_id: target.homeTeam.id, home_team_name: target.homeTeam.name,
            winner_team_id: draft.winnerTeamId, confidence: draft.confidence,
            supporting_points: draft.supportingPoints, risks: draft.risks,
            model_name: draft.model, analyzed_at: draft.analyzedAt,
            source_refreshed_at: draft.evidence.refreshedAt, data_warnings: draft.evidence.warnings,
            evidence_snapshot: draft.evidence, evidence_key: draft.evidence.material,
          }
        }),
      })
      check(error)
      const saved = await readAnalysis(week)
      if (!saved || saved.id !== data) throw new PickemError('pickem_conflict', 'Saved Pickem analysis could not be reloaded.')
      return saved
    },

    async pendingGameIds(week, now, signal) {
      const saved = await readAnalysis(week, signal)
      return [...new Set(saved?.predictions.filter((pick) => pick.result === 'pending'
        && Date.parse(pick.kickoffAt) <= Date.parse(now)).map((pick) => pick.gameId) ?? [])]
    },

    async grade(week) {
      const saved = await readAnalysis(week)
      if (!saved) return 0
      const { data, error } = await client.rpc('grade_pickem_analysis', { requested_id: saved.id })
      check(error)
      return Number(data)
    },
  }
}
