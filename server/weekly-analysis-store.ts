import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  WeeklyAnalysisRun,
  WeeklyAnalysisSnapshot,
  WeeklyAnalysisStore,
  WeeklyModelAnalysis,
  WeeklySuggestion,
  WeeklyRunView,
  WeeklyRunSummaries,
} from './weekly-analysis'
import {
  WEEKLY_LOSS_ANALYSIS_VERSION,
  WeeklyLossAnalysisError,
  type GameTeamStatRow,
  type WeeklyLossAnalysis,
  type WeeklyLossEvidence,
} from './weekly-loss-analysis'
import { AnalyticsDatabaseError, readAllRows } from './analytics-reads'

type RunRow = {
  id: string
  season: number
  stage: string | null
  week: string
  model_name: string
  context_snapshot: WeeklyAnalysisSnapshot
  summary: string
  created_at: string
}

type SuggestionRow = {
  id: number
  run_id: string
  game_id: number
  season: number
  stage: string | null
  week: string
  kickoff_at: string
  away_team_id: number
  away_team_name: string
  home_team_id: number
  home_team_name: string
  market: WeeklySuggestion['market']
  selection: WeeklySuggestion['selection']
  locked_line: number
  confidence: number
  rationale: string
  supporting_points: WeeklySuggestion['supportingPoints']
  supporting_game_ids: number[]
  result: WeeklySuggestion['result']
  result_delta: number | null
  final_away_score: number | null
  final_home_score: number | null
  graded_at: string | null
  created_at: string
}

type LossAnalysisRow = {
  id: number
  suggestion_id: number
  analysis_version: number
  model_name: string
  evidence_snapshot: WeeklyLossEvidence
  summary: string
  clues: WeeklyLossAnalysis['clues']
  missing_metrics: string[]
  created_at: string
}

function throwError(error: { message: string } | null) {
  if (error) throw new AnalyticsDatabaseError('Weekly database request failed', error)
}

function lossMetadata(row: Omit<LossAnalysisRow, 'evidence_snapshot'>) {
  return {
    id: Number(row.id),
    suggestionId: Number(row.suggestion_id),
    analysisVersion: Number(row.analysis_version),
    model: row.model_name,
    summary: row.summary,
    clues: row.clues,
    missingMetrics: row.missing_metrics ?? [],
    createdAt: row.created_at,
  }
}

function lossAnalysis(row: LossAnalysisRow): WeeklyLossAnalysis {
  return { ...lossMetadata(row), evidence: row.evidence_snapshot }
}

function suggestion(row: SuggestionRow, analysis: WeeklyLossAnalysis | null = null): WeeklySuggestion {
  return {
    id: Number(row.id),
    runId: row.run_id,
    gameId: Number(row.game_id),
    season: Number(row.season),
    stage: row.stage,
    week: row.week,
    kickoffAt: row.kickoff_at,
    awayTeamId: Number(row.away_team_id),
    awayTeamName: row.away_team_name,
    homeTeamId: Number(row.home_team_id),
    homeTeamName: row.home_team_name,
    market: row.market,
    selection: row.selection,
    lockedLine: Number(row.locked_line),
    confidence: Number(row.confidence),
    rationale: row.rationale,
    supportingPoints: row.supporting_points ?? null,
    supportingGameIds: row.supporting_game_ids ?? [],
    result: row.result,
    resultDelta: row.result_delta == null ? null : Number(row.result_delta),
    finalAwayScore: row.final_away_score,
    finalHomeScore: row.final_home_score,
    gradedAt: row.graded_at,
    createdAt: row.created_at,
    lossAnalysis: analysis,
  }
}

function run(row: RunRow, suggestions: WeeklySuggestion[]): WeeklyAnalysisRun {
  return {
    id: row.id,
    season: Number(row.season),
    stage: row.stage,
    week: row.week,
    model: row.model_name,
    context: row.context_snapshot,
    summary: row.summary,
    createdAt: row.created_at,
    suggestions,
  }
}

const suggestionColumns = 'id,run_id,game_id,season,stage,week,kickoff_at,away_team_id,away_team_name,home_team_id,home_team_name,market,selection,locked_line,confidence,rationale,supporting_points,supporting_game_ids,result,result_delta,final_away_score,final_home_score,graded_at,created_at'
const lossColumns = 'id,suggestion_id,analysis_version,model_name,evidence_snapshot,summary,clues,missing_metrics,created_at'
const lossViewColumns = 'id,suggestion_id,analysis_version,model_name,metrics:evidence_snapshot->metrics,summary,clues,missing_metrics,created_at'
const runColumns = 'id,season,stage,week,model_name,summary,created_at'

export function gradeWeeklySuggestion(
  pick: WeeklySuggestion,
  awayScore: number,
  homeScore: number,
) {
  const spreadDelta = pick.selection === 'home'
    ? homeScore - awayScore + pick.lockedLine
    : awayScore - homeScore + pick.lockedLine
  const totalDelta = homeScore + awayScore - pick.lockedLine
  const delta = pick.market === 'spread'
    ? spreadDelta
    : pick.selection === 'over' ? totalDelta : -totalDelta
  return {
    delta: delta === 0 ? 0 : delta,
    result: delta > 0 ? 'win' as const : delta < 0 ? 'loss' as const : 'push' as const,
  }
}

export function createWeeklyAnalysisStore(client: SupabaseClient): WeeklyAnalysisStore {
  const get = async (id: string, signal?: AbortSignal) => {
    let query = client.from('betting_analysis_runs')
      .select(`${runColumns},context_snapshot`).eq('id', id)
    if (signal) query = query.abortSignal(signal)
    const { data, error } = await query.maybeSingle()
    throwError(error)
    if (!data) return null
    const suggestions = await readSuggestions([id], signal)
    return run(data as RunRow, suggestions)
  }

  const readSuggestionRows = (ids: string[], signal?: AbortSignal) =>
    readAllRows<SuggestionRow>((from, to) => {
      let query = client.from('betting_suggestions').select(suggestionColumns)
        .in('run_id', ids).order('id').range(from, to)
      if (signal) query = query.abortSignal(signal)
      return query
    }, 'Could not load weekly picks')

  const readLossRows = async <T>(rows: SuggestionRow[], columns: string, signal?: AbortSignal) => {
    const analyses: T[] = []
    for (let index = 0; index < rows.length; index += 200) {
      analyses.push(...await readAllRows<T>(async (from, to) => {
        let query = client.from('betting_suggestion_loss_analyses').select(columns)
          .in('suggestion_id', rows.slice(index, index + 200).map((row) => row.id)).order('id').range(from, to)
        if (signal) query = query.abortSignal(signal)
        const { data, error } = await query
        return { data: data as T[] | null, error }
      }, 'Could not load saved loss analyses'))
    }
    return analyses
  }

  const readSuggestions = async (ids: string[], signal?: AbortSignal) => {
    const rows = await readSuggestionRows(ids, signal)
    const analyses = await readLossRows<LossAnalysisRow>(rows, lossColumns, signal)
    const bySuggestion = new Map(analyses.map((row) => [Number(row.suggestion_id), lossAnalysis(row)]))
    return rows.map((row) => suggestion(row, bySuggestion.get(Number(row.id)) ?? null))
  }

  const list = async () => {
    const { data: runData, error: runError } = await client
      .from('betting_analysis_runs')
      .select('id,season,stage,week,model_name,context_snapshot,summary,created_at')
      .neq('stage', 'Pre Season')
      .order('created_at', { ascending: false })
      .limit(100)
    throwError(runError)
    const rows = (runData ?? []) as RunRow[]
    if (!rows.length) return []

    const byRun = new Map<string, WeeklySuggestion[]>()
    for (const pick of await readSuggestions(rows.map((row) => row.id))) {
      const items = byRun.get(pick.runId) ?? []
      items.push(pick)
      byRun.set(pick.runId, items)
    }
    return rows.map((row) => run(row, byRun.get(row.id) ?? []))
  }

  return {
    async save(snapshot: WeeklyAnalysisSnapshot, model: string, analysis: WeeklyModelAnalysis) {
      const suggestions = analysis.picks.map((pick) => {
        const matchup = snapshot.matchups.find((item) => item.gameId === pick.gameId)!
        const target = matchup.target
        return {
          game_id: pick.gameId,
          kickoff_at: matchup.kickoffAt,
          away_team_id: target.awayTeam.id,
          away_team_name: target.awayTeam.name,
          home_team_id: target.homeTeam.id,
          home_team_name: target.homeTeam.name,
          market: pick.market,
          selection: pick.selection,
          locked_line: pick.line,
          confidence: pick.confidence,
          rationale: pick.rationale,
          supporting_points: pick.supportingPoints ?? null,
          supporting_game_ids: pick.supportingGameIds,
        }
      })
      const { data, error } = await client.rpc('save_weekly_betting_analysis', {
        requested_season: snapshot.season,
        requested_stage: snapshot.stage,
        requested_week: snapshot.week,
        requested_model: model,
        requested_context: snapshot,
        requested_summary: analysis.summary,
        requested_suggestions: suggestions,
      })
      throwError(error)
      const saved = await get(String(data))
      if (!saved) throw new Error('Saved weekly analysis could not be reloaded.')
      return saved
    },

    list,
    get,

    async summaries(options) {
      const limit = options.limit ?? 25
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Weekly summary page size must be from 1 through 100.')
      let query = client.rpc('get_weekly_analysis_summaries', {
        requested_season: options.season ?? null,
        requested_week: options.week ?? null,
        before_created_at: options.before?.createdAt ?? null,
        before_id: options.before?.id ?? null,
        page_size: limit,
      })
      if (options.signal) query = query.abortSignal(options.signal)
      const { data, error } = await query
      throwError(error)
      if (!data || typeof data !== 'object' || !Array.isArray(data.runs)
        || !Array.isArray(data.weeks) || !data.record) {
        throw new Error('Weekly summaries returned an invalid response.')
      }
      const payload = data as Omit<WeeklyRunSummaries, 'next'>
      const rows = payload.runs.slice(0, limit)
      const last = rows.at(-1)
      return { ...payload, runs: rows, next: payload.runs.length > limit && last
        ? { createdAt: last.createdAt, id: last.id } : null }
    },

    async view(id, signal) {
      let query = client.from('betting_analysis_runs').select(runColumns).eq('id', id)
      if (signal) query = query.abortSignal(signal)
      const { data, error } = await query.maybeSingle()
      throwError(error)
      if (!data) return null
      const row = data as Omit<RunRow, 'context_snapshot'>
      let latestQuery = client.from('betting_analysis_runs').select('id')
        .eq('season', row.season).eq('week', row.week)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1)
      latestQuery = row.stage == null ? latestQuery.is('stage', null) : latestQuery.eq('stage', row.stage)
      if (signal) latestQuery = latestQuery.abortSignal(signal)
      const [rows, latest] = await Promise.all([readSuggestionRows([id], signal), latestQuery])
      throwError(latest.error)
      const analyses = await readLossRows<Omit<LossAnalysisRow, 'evidence_snapshot'> & {
        metrics: WeeklyLossEvidence['metrics']
      }>(rows, lossViewColumns, signal)
      const bySuggestion = new Map(analyses.map((analysis) => [Number(analysis.suggestion_id), {
        ...lossMetadata(analysis), evidence: { metrics: analysis.metrics },
      }]))
      const view: WeeklyRunView = {
        id: row.id, season: Number(row.season), stage: row.stage, week: row.week,
        model: row.model_name, summary: row.summary, createdAt: row.created_at,
        isFinal: latest.data?.[0]?.id === id,
        suggestions: rows.map((pick) => ({
          ...suggestion(pick), lossAnalysis: bySuggestion.get(Number(pick.id)) ?? null,
        })),
      }
      return view
    },

    async delete(id: string) {
      const { data, error } = await client
        .from('betting_analysis_runs')
        .delete()
        .eq('id', id)
        .neq('stage', 'Pre Season')
        .select('id')
      throwError(error)
      return (data?.length ?? 0) > 0
    },

    async listPendingGameIds(through: string) {
      const data = await readAllRows<{ game_id: number }>((from, to) => client
        .from('betting_suggestions')
        .select('game_id')
        .eq('result', 'ungraded')
        .neq('stage', 'Pre Season')
        .lte('kickoff_at', through)
        .order('game_id')
        .order('id').range(from, to), 'Could not load pending games')
      return [...new Set((data ?? []).map((row) => Number(row.game_id)))]
    },

    async gradePending() {
      const pendingData = await readAllRows<SuggestionRow>((from, to) => client
        .from('betting_suggestions')
        .select(suggestionColumns)
        .eq('result', 'ungraded')
        .neq('stage', 'Pre Season')
        .order('id')
        .range(from, to), 'Could not load pending suggestions')
      const pending = pendingData.map((row) => suggestion(row))
      if (!pending.length) return 0

      const ids = [...new Set(pending.map((pick) => pick.gameId))]
      const games: Array<{ id: number; status_short: string | null; away_total: number | null; home_total: number | null }> = []
      for (let index = 0; index < ids.length; index += 200) {
        const { data, error } = await client.from('games').select('id,status_short,away_total,home_total')
          .in('id', ids.slice(index, index + 200))
        throwError(error)
        games.push(...data ?? [])
      }
      const completed = new Map((games ?? [])
        .filter((game) => ['FT', 'AOT'].includes(String(game.status_short).toUpperCase())
          && game.away_total != null && game.home_total != null
          && Number.isFinite(Number(game.away_total))
          && Number.isFinite(Number(game.home_total)))
        .map((game) => [Number(game.id), {
          awayScore: Number(game.away_total),
          homeScore: Number(game.home_total),
        }]))
      let graded = 0
      for (const pick of pending) {
        const game = completed.get(pick.gameId)
        if (!game) continue
        const outcome = gradeWeeklySuggestion(pick, game.awayScore, game.homeScore)
        const { data, error } = await client
          .from('betting_suggestions')
          .update({
            result: outcome.result,
            result_delta: outcome.delta,
            final_away_score: game.awayScore,
            final_home_score: game.homeScore,
            graded_at: new Date().toISOString(),
          })
          .eq('id', pick.id)
          .eq('result', 'ungraded')
          .select('id')
        throwError(error)
        graded += data?.length ?? 0
      }
      return graded
    },

    async getLossAnalysisInput(suggestionId: number) {
      const { data: suggestionData, error: suggestionError } = await client
        .from('betting_suggestions')
        .select(suggestionColumns)
        .eq('id', suggestionId)
        .neq('stage', 'Pre Season')
        .maybeSingle()
      throwError(suggestionError)
      if (!suggestionData) return null
      const row = suggestionData as SuggestionRow

      const { data: analysisData, error: analysisError } = await client
        .from('betting_suggestion_loss_analyses')
        .select('id,suggestion_id,analysis_version,model_name,evidence_snapshot,summary,clues,missing_metrics,created_at')
        .eq('suggestion_id', suggestionId)
        .maybeSingle()
      throwError(analysisError)

      const { data: runData, error: runError } = await client
        .from('betting_analysis_runs')
        .select('context_snapshot')
        .eq('id', row.run_id)
        .maybeSingle()
      throwError(runError)
      if (!runData) return null
      const context = runData.context_snapshot as WeeklyAnalysisSnapshot
      const matchup = context.matchups.find((item) => item.gameId === Number(row.game_id))
      if (!matchup) throw new Error(`Saved weekly context is missing game ${row.game_id}.`)

      const { data: teamStatsData, error: teamStatsError } = await client
        .from('game_team_stats')
        .select('team_id,fd_total,third_down_eff,fourth_down_eff,plays_total,yards_total,yards_per_play,total_drives,pass_yards,rush_yards,red_zone,penalties,turnovers_total,possession,sacks')
        .eq('game_id', row.game_id)
        .in('team_id', [row.away_team_id, row.home_team_id])
        .order('team_id')
      throwError(teamStatsError)

      return {
        suggestion: suggestion(
          row,
          analysisData ? lossAnalysis(analysisData as LossAnalysisRow) : null,
        ),
        matchup,
        teamStats: (teamStatsData ?? []) as GameTeamStatRow[],
      }
    },

    async saveLossAnalysis(input) {
      const { data, error } = await client
        .from('betting_suggestion_loss_analyses')
        .insert({
          suggestion_id: input.suggestionId,
          analysis_version: WEEKLY_LOSS_ANALYSIS_VERSION,
          model_name: input.model,
          evidence_snapshot: input.evidence,
          summary: input.summary,
          clues: input.clues,
          missing_metrics: input.evidence.missingMetrics,
        })
        .select('id,suggestion_id,analysis_version,model_name,evidence_snapshot,summary,clues,missing_metrics,created_at')
        .single()
      if (error?.code === '23505') {
        throw new WeeklyLossAnalysisError('analysis_exists', 'This loss already has a stored analysis.')
      }
      throwError(error)
      if (!data) throw new Error('Saved loss analysis could not be reloaded.')
      return lossAnalysis(data as LossAnalysisRow)
    },

    async deleteLossAnalysis(id: number) {
      const { data, error } = await client
        .from('betting_suggestion_loss_analyses')
        .delete()
        .eq('id', id)
        .select('id')
      throwError(error)
      return (data?.length ?? 0) > 0
    },
  }
}
