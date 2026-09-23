import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAnalyticsSnapshot, type AnalyticsTargetMatchup } from '../server/analytics-core'
import {
  parseWeeklyModelAnalysis,
  WeeklyAnalysisError,
  type WeeklyAnalysisSnapshot,
  type WeeklySuggestion,
} from '../server/weekly-analysis'
import { gradeWeeklySuggestion } from '../server/weekly-analysis-store'

const target: AnalyticsTargetMatchup = {
  gameId: 42,
  season: 2026,
  status: { short: 'NS', long: 'Not Started' },
  kickoff: { date: '2026-09-27', timestamp: 1_790_531_600 },
  stage: 'Regular Season',
  week: 'Week 4',
  venue: { name: 'Test Stadium', city: 'Test City' },
  awayTeam: { id: 2, name: 'Visitors' },
  homeTeam: { id: 1, name: 'Hosts' },
  currentConsensusOdds: { homeSpread: -3.5, total: 44.5 },
}

const historyGame = {
  game_id: 31,
  season: 2026,
  stage: 'Regular Season',
  week: 'Week 3',
  game_date: '2026-09-20',
  game_timestamp: 1_789_926_000,
  away_team_id: 2,
  away_team_name: 'Visitors',
  home_team_id: 3,
  home_team_name: 'Opponent',
  away_score: 24,
  home_score: 20,
  final_total: 44,
  home_margin: -4,
  closing_home_spread: 1.5,
  spread_bookmaker_count: 4,
  spread_delta: -2.5,
  spread_result: 'away_cover' as const,
  closing_total: 42.5,
  total_bookmaker_count: 4,
  total_delta: 1.5,
  total_result: 'over' as const,
}

const analysis = buildAnalyticsSnapshot(
  'matchup_preview',
  { season: 2026, gameId: 42 },
  {
    games: [historyGame],
    teamStats: [],
    standings: [],
    injuries: [],
    playerStats: [],
    players: [],
    targetMatchup: target,
  },
  '2026-09-22T20:00:00.000Z',
)

const snapshot: WeeklyAnalysisSnapshot = {
  schemaVersion: 1,
  generatedAt: '2026-09-22T20:00:00.000Z',
  season: 2026,
  stage: 'Regular Season',
  week: 'Week 4',
  matchups: [{
    gameId: 42,
    kickoffAt: '2026-09-27T17:00:00.000Z',
    target,
    teamTrends: analysis.teamTrends.items,
    teamStatTrends: analysis.teamStatTrends.items,
    recentGames: analysis.games.items.map((item) => ({
      gameId: item.gameId,
      gameDate: item.gameDate,
      awayTeamName: item.awayTeamName,
      awayScore: item.awayScore,
      homeTeamName: item.homeTeamName,
      homeScore: item.homeScore,
      closingHomeSpread: item.closingHomeSpread,
      spreadDelta: item.spreadDelta,
      spreadResult: item.spreadResult,
      closingTotal: item.closingTotal,
      totalDelta: item.totalDelta,
      totalResult: item.totalResult,
    })),
    standings: analysis.standings.items,
    currentInjuries: [],
    playerStats: [],
    dataQuality: analysis.dataQuality,
  }],
}

function output(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    summary: 'The supplied trends support one cautious position.',
    picks: [{
      gameId: 42,
      market: 'spread',
      selection: 'away',
      confidence: 61,
      rationale: 'Visitors covered in the cited prior game, though the sample is small.',
      supportingGameIds: [31],
      ...overrides,
    }],
  })
}

function invalidOutput(error: unknown) {
  return error instanceof WeeklyAnalysisError && error.code === 'invalid_model_output'
}

describe('weekly model analysis validation', () => {
  it('accepts exact supplied lines and cited matchup history', () => {
    assert.deepEqual(parseWeeklyModelAnalysis(output(), snapshot).picks[0], {
      gameId: 42,
      market: 'spread',
      selection: 'away',
      line: 3.5,
      confidence: 61,
      rationale: 'Visitors covered in the cited prior game, though the sample is small.',
      supportingGameIds: [31],
    })
  })

  it('allows a valid no-pick analysis', () => {
    assert.deepEqual(parseWeeklyModelAnalysis(JSON.stringify({
      summary: 'No market has sufficient supplied evidence.',
      picks: [],
    }), snapshot).picks, [])
  })

  it('omits suggestions whose market has no consensus line and reports the omission', () => {
    const withoutSpread: WeeklyAnalysisSnapshot = {
      ...snapshot,
      matchups: [{
        ...snapshot.matchups[0],
        target: {
          ...target,
          currentConsensusOdds: { ...target.currentConsensusOdds, homeSpread: null },
        },
      }],
    }
    const parsed = parseWeeklyModelAnalysis(output(), withoutSpread)
    assert.deepEqual(parsed.picks, [])
    assert.match(parsed.summary, /1 model suggestion omitted because no consensus line was available/)
  })

  it('rejects line drift, incompatible selections, and unsupported citations', () => {
    assert.throws(() => parseWeeklyModelAnalysis(output({ line: 4 }), snapshot), invalidOutput)
    assert.throws(() => parseWeeklyModelAnalysis(output({ selection: 'over' }), snapshot), invalidOutput)
    assert.throws(() => parseWeeklyModelAnalysis(output({ supportingGameIds: [999] }), snapshot), invalidOutput)
  })

  it('rejects duplicate game-market picks and non-JSON prose', () => {
    const pick = JSON.parse(output()) as { summary: string; picks: unknown[] }
    pick.picks.push(pick.picks[0])
    assert.throws(() => parseWeeklyModelAnalysis(JSON.stringify(pick), snapshot), invalidOutput)
    assert.throws(() => parseWeeklyModelAnalysis('```json\n{}\n```', snapshot), invalidOutput)
  })
})

function suggestion(overrides: Partial<WeeklySuggestion> = {}): WeeklySuggestion {
  return {
    id: 1,
    runId: 'run',
    gameId: 42,
    season: 2026,
    stage: 'Regular Season',
    week: 'Week 4',
    kickoffAt: '2026-09-27T17:00:00.000Z',
    awayTeamId: 2,
    awayTeamName: 'Visitors',
    homeTeamId: 1,
    homeTeamName: 'Hosts',
    market: 'spread',
    selection: 'home',
    lockedLine: -3.5,
    confidence: 60,
    rationale: 'Test',
    supportingGameIds: [],
    result: 'ungraded',
    resultDelta: null,
    finalAwayScore: null,
    finalHomeScore: null,
    gradedAt: null,
    createdAt: '2026-09-22T20:00:00.000Z',
    ...overrides,
  }
}

describe('weekly suggestion grading', () => {
  it('grades both sides against the locked home spread', () => {
    assert.deepEqual(gradeWeeklySuggestion(suggestion(), 20, 27), { delta: 3.5, result: 'win' })
    assert.deepEqual(
      gradeWeeklySuggestion(suggestion({ selection: 'away', lockedLine: 3.5 }), 20, 27),
      { delta: -3.5, result: 'loss' },
    )
  })

  it('grades totals and pushes against the locked total', () => {
    assert.deepEqual(
      gradeWeeklySuggestion(suggestion({ market: 'total', selection: 'over', lockedLine: 44.5 }), 20, 27),
      { delta: 2.5, result: 'win' },
    )
    assert.deepEqual(
      gradeWeeklySuggestion(suggestion({ market: 'total', selection: 'under', lockedLine: 47 }), 20, 27),
      { delta: 0, result: 'push' },
    )
  })
})
