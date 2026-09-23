import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  WeeklyAnalysisRun,
  WeeklyAnalysisSnapshot,
  WeeklyAnalysisStore,
  WeeklyModelAnalysis,
  WeeklySuggestion,
} from './weekly-analysis'

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
  supporting_game_ids: number[]
  result: WeeklySuggestion['result']
  result_delta: number | null
  final_away_score: number | null
  final_home_score: number | null
  graded_at: string | null
  created_at: string
}

function throwError(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

function suggestion(row: SuggestionRow): WeeklySuggestion {
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
    supportingGameIds: row.supporting_game_ids ?? [],
    result: row.result,
    resultDelta: row.result_delta == null ? null : Number(row.result_delta),
    finalAwayScore: row.final_away_score,
    finalHomeScore: row.final_home_score,
    gradedAt: row.graded_at,
    createdAt: row.created_at,
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
  const list = async () => {
    const { data: runData, error: runError } = await client
      .from('betting_analysis_runs')
      .select('id,season,stage,week,model_name,context_snapshot,summary,created_at')
      .eq('stage', 'Regular Season')
      .order('created_at', { ascending: false })
      .limit(100)
    throwError(runError)
    const rows = (runData ?? []) as RunRow[]
    if (!rows.length) return []

    const { data: suggestionData, error: suggestionError } = await client
      .from('betting_suggestions')
      .select('id,run_id,game_id,season,stage,week,kickoff_at,away_team_id,away_team_name,home_team_id,home_team_name,market,selection,locked_line,confidence,rationale,supporting_game_ids,result,result_delta,final_away_score,final_home_score,graded_at,created_at')
      .in('run_id', rows.map((row) => row.id))
      .order('id')
    throwError(suggestionError)
    const byRun = new Map<string, WeeklySuggestion[]>()
    for (const row of (suggestionData ?? []) as SuggestionRow[]) {
      const items = byRun.get(row.run_id) ?? []
      items.push(suggestion(row))
      byRun.set(row.run_id, items)
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
      const runs = await list()
      const saved = runs.find((item) => item.id === data)
      if (!saved) throw new Error('Saved weekly analysis could not be reloaded.')
      return saved
    },

    list,

    async delete(id: string) {
      const { data, error } = await client
        .from('betting_analysis_runs')
        .delete()
        .eq('id', id)
        .eq('stage', 'Regular Season')
        .select('id')
      throwError(error)
      return (data?.length ?? 0) > 0
    },

    async gradePending() {
      const { data: pendingData, error: pendingError } = await client
        .from('betting_suggestions')
        .select('id,run_id,game_id,season,stage,week,kickoff_at,away_team_id,away_team_name,home_team_id,home_team_name,market,selection,locked_line,confidence,rationale,supporting_game_ids,result,result_delta,final_away_score,final_home_score,graded_at,created_at')
        .eq('result', 'ungraded')
        .eq('stage', 'Regular Season')
        .order('id')
      throwError(pendingError)
      const pending = ((pendingData ?? []) as SuggestionRow[]).map(suggestion)
      if (!pending.length) return 0

      const { data: games, error: gamesError } = await client
        .from('games')
        .select('id,status_short,away_total,home_total')
        .in('id', [...new Set(pending.map((pick) => pick.gameId))])
      throwError(gamesError)
      const completed = new Map((games ?? [])
        .filter((game) => ['FT', 'AOT'].includes(String(game.status_short).toUpperCase())
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
  }
}
