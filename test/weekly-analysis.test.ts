import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildAnalyticsSnapshot, type AnalyticsTargetMatchup } from '../server/analytics-core'
import {
  buildWeeklyMessages,
  buildUpcomingWeekSnapshot,
  buildWeeklyTeamPerformance,
  buildWeeklyMatchups,
  mapInBatches,
  parseWeeklyModelAnalysis,
  WeeklyAnalysisError,
  type WeeklyAnalysisSnapshot,
  type WeeklySuggestion,
} from '../server/weekly-analysis'
import { createWeeklyAnalysisStore, gradeWeeklySuggestion } from '../server/weekly-analysis-store'

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

const recentGames = analysis.games.items.map((item) => ({
  gameId: item.gameId,
  gameDate: item.gameDate,
  awayTeamId: item.awayTeamId,
  awayTeamName: item.awayTeamName,
  awayScore: item.awayScore,
  homeTeamId: item.homeTeamId,
  homeTeamName: item.homeTeamName,
  homeScore: item.homeScore,
  finalTotal: item.finalTotal,
  closingHomeSpread: item.closingHomeSpread,
  spreadDelta: item.spreadDelta,
  spreadResult: item.spreadResult,
  closingTotal: item.closingTotal,
  totalDelta: item.totalDelta,
  totalResult: item.totalResult,
}))

const snapshot: WeeklyAnalysisSnapshot = {
  schemaVersion: 2,
  generatedAt: '2026-09-22T20:00:00.000Z',
  season: 2026,
  stage: 'Regular Season',
  week: 'Week 4',
  matchups: [{
    gameId: 42,
    kickoffAt: '2026-09-27T17:00:00.000Z',
    target,
    teamTrends: analysis.teamTrends.items,
    teamPerformance: buildWeeklyTeamPerformance(target, analysis.teamTrends.items, recentGames),
    teamStatTrends: analysis.teamStatTrends.items,
    recentGames,
    standings: analysis.standings.items,
    currentInjuries: [],
    playerStats: [],
    dataQuality: analysis.dataQuality,
  }],
}

function output(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    picks: [{
      gameId: 42,
      market: 'spread',
      selection: 'away',
      confidence: 61,
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
      rationale: 'Visitors beat Opponent 24-20; Visitors 1-0 ATS; Hosts 0-0 ATS; Visitors avg 24 PF/20 PA',
      supportingGameIds: [31],
    })
  })

  it('allows a valid no-pick analysis', () => {
    assert.deepEqual(parseWeeklyModelAnalysis(JSON.stringify({
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

  it('omits model suggestions when a matchup has no prior games', () => {
    const withoutHistory: WeeklyAnalysisSnapshot = {
      ...snapshot,
      matchups: [{
        ...snapshot.matchups[0],
        teamPerformance: snapshot.matchups[0].teamPerformance.map((team) => ({
          ...team,
          games: 0,
          averagePointsFor: null,
          averagePointsAgainst: null,
          recentGames: [],
        })),
        recentGames: [],
      }],
    }
    const parsed = parseWeeklyModelAnalysis(output({ supportingGameIds: [] }), withoutHistory)
    assert.deepEqual(parsed.picks, [])
    assert.match(parsed.summary, /1 model suggestion omitted because no prior non-preseason games were available/)
  })

  it('rejects line drift, incompatible selections, and unsupported citations', () => {
    assert.throws(() => parseWeeklyModelAnalysis(output({ line: 4 }), snapshot), invalidOutput)
    assert.throws(() => parseWeeklyModelAnalysis(output({ selection: 'over' }), snapshot), invalidOutput)
    assert.throws(() => parseWeeklyModelAnalysis(output({ supportingGameIds: [999] }), snapshot), invalidOutput)
    assert.throws(() => parseWeeklyModelAnalysis(output({ supportingGameIds: [] }), snapshot), invalidOutput)
    assert.throws(() => parseWeeklyModelAnalysis(output({ supportingGameIds: [31, 31] }), snapshot), invalidOutput)
  })

  it('rejects duplicate game-market picks and non-JSON prose', () => {
    const pick = JSON.parse(output()) as { picks: unknown[] }
    pick.picks.push(pick.picks[0])
    assert.throws(() => parseWeeklyModelAnalysis(JSON.stringify(pick), snapshot), invalidOutput)
    assert.throws(() => parseWeeklyModelAnalysis('```json\n{}\n```', snapshot), invalidOutput)
  })

  it('keeps the model contract free of factual prose and within the payload guard', () => {
    const messages = buildWeeklyMessages(snapshot)
    assert.doesNotMatch(messages.at(-1)?.content ?? '', /"(?:rationale|summary)"/)
    assert.ok(messages.reduce((total, message) => total + message.content.length, 0) < 240_000)
  })
})

describe('weekly team evidence', () => {
  it('keeps Seattle points scored and allowed in the correct perspective', () => {
    const seattleTarget: AnalyticsTargetMatchup = {
      ...target,
      awayTeam: { id: 23, name: 'Seattle Seahawks' },
      homeTeam: { id: 18, name: 'Washington Commanders' },
    }
    const seattleGames = [
      {
        ...historyGame,
        game_id: 21541,
        game_date: '2026-09-20',
        game_timestamp: 1_790_000_200,
        away_team_id: 23,
        away_team_name: 'Seattle Seahawks',
        away_score: 31,
        home_team_id: 11,
        home_team_name: 'Arizona Cardinals',
        home_score: 7,
        final_total: 38,
        total_result: 'under' as const,
      },
      {
        ...historyGame,
        game_id: 21513,
        game_date: '2026-09-13',
        game_timestamp: 1_789_000_200,
        away_team_id: 3,
        away_team_name: 'San Francisco 49ers',
        away_score: 10,
        home_team_id: 23,
        home_team_name: 'Seattle Seahawks',
        home_score: 13,
        final_total: 23,
        total_result: 'under' as const,
      },
    ]
    const seattleAnalysis = buildAnalyticsSnapshot(
      'matchup_preview',
      { season: 2026, gameId: 42 },
      {
        games: seattleGames,
        teamStats: [],
        standings: [],
        injuries: [],
        playerStats: [],
        players: [],
        targetMatchup: seattleTarget,
      },
      '2026-09-22T20:00:00.000Z',
    )
    const games = seattleAnalysis.games.items.map((item) => ({
      gameId: item.gameId,
      gameDate: item.gameDate,
      awayTeamId: item.awayTeamId,
      awayTeamName: item.awayTeamName,
      awayScore: item.awayScore,
      homeTeamId: item.homeTeamId,
      homeTeamName: item.homeTeamName,
      homeScore: item.homeScore,
      finalTotal: item.finalTotal,
      closingHomeSpread: item.closingHomeSpread,
      spreadDelta: item.spreadDelta,
      spreadResult: item.spreadResult,
      closingTotal: item.closingTotal,
      totalDelta: item.totalDelta,
      totalResult: item.totalResult,
    }))
    const teamPerformance = buildWeeklyTeamPerformance(
      seattleTarget,
      seattleAnalysis.teamTrends.items,
      games,
    )
    const seattle = teamPerformance.find((team) => team.teamId === 23)!
    assert.equal(seattle.averagePointsFor, 22)
    assert.equal(seattle.averagePointsAgainst, 8.5)
    assert.deepEqual(seattle.recentGames.map((game) => [game.pointsFor, game.pointsAgainst]), [
      [31, 7],
      [13, 10],
    ])

    const parsed = parseWeeklyModelAnalysis(JSON.stringify({
      picks: [{
        gameId: 42,
        market: 'total',
        selection: 'over',
        confidence: 55,
        supportingGameIds: [21541, 21513],
      }],
    }), {
      ...snapshot,
      matchups: [{
        ...snapshot.matchups[0],
        target: seattleTarget,
        teamTrends: seattleAnalysis.teamTrends.items,
        teamPerformance,
        recentGames: games,
      }],
    })
    assert.match(parsed.picks[0].rationale, /Seattle Seahawks avg 22 PF\/8\.5 PA/)
    assert.doesNotMatch(parsed.picks[0].rationale, /allowed 31|31 PA/)
  })
})

describe('weekly matchup batching', () => {
  it('skips earlier preseason games and builds only the next regular-season week', async () => {
    const operations: Array<[string, unknown]> = []
    const rows = [
      { id: 10, season: 2026, stage: 'Pre Season', week: 'Pre Season Week 3', game_timestamp: 1_790_000_000, status_short: 'NS' },
      { id: 42, season: 2026, stage: 'Regular Season', week: 'Week 1', game_timestamp: 1_791_000_000, status_short: 'NS' },
      { id: 43, season: 2026, stage: 'Regular Season', week: 'Week 1', game_timestamp: 1_791_003_600, status_short: 'NS' },
      { id: 50, season: 2026, stage: 'Post Season', week: 'Wild Card', game_timestamp: 1_800_000_000, status_short: 'NS' },
    ]
    const receivedFilters: Array<{ gameId?: number; stage?: string }> = []
    class Query implements PromiseLike<{ data: typeof rows; error: null }> {
      private result = [...rows]
      private maximum: number | null = null
      select() { return this }
      eq(column: string, value: unknown) {
        operations.push([column, value])
        this.result = this.result.filter((row) => row[column as keyof typeof row] === value)
        return this
      }
      neq(column: string, value: unknown) {
        operations.push([`not:${column}`, value])
        this.result = this.result.filter((row) => row[column as keyof typeof row] !== value)
        return this
      }
      gt(column: string, value: number) {
        this.result = this.result.filter((row) => Number(row[column as keyof typeof row]) > value)
        return this
      }
      not(column: string) {
        this.result = this.result.filter((row) => row[column as keyof typeof row] != null)
        return this
      }
      order(column: string) {
        this.result.sort((left, right) => Number(left[column as keyof typeof left]) - Number(right[column as keyof typeof right]))
        return this
      }
      limit(value: number) {
        this.maximum = value
        return this
      }
      then<TResult1 = { data: typeof rows; error: null }, TResult2 = never>(
        onfulfilled?: ((value: { data: typeof rows; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve({
          data: this.maximum == null ? this.result : this.result.slice(0, this.maximum),
          error: null,
        }).then(onfulfilled, onrejected)
      }
    }
    const client = { from: () => new Query() } as unknown as SupabaseClient
    const dataSource = {
      async load(filters: { gameId?: number; stage?: string }) {
        receivedFilters.push(filters)
        const gameId = Number(filters.gameId)
        return {
          games: [],
          teamStats: [],
          standings: [],
          injuries: [],
          playerStats: [],
          players: [],
          targetMatchup: {
            ...target,
            gameId,
            kickoff: {
              date: '2026-09-27',
              timestamp: rows.find((row) => row.id === gameId)?.game_timestamp ?? target.kickoff.timestamp,
            },
            week: 'Week 1',
          },
        }
      },
    }

    const result = await buildUpcomingWeekSnapshot(
      client,
      dataSource,
      2026,
      '2026-09-01T00:00:00.000Z',
    )

    assert.equal(result.stage, 'Regular Season')
    assert.equal(result.week, 'Week 1')
    assert.deepEqual(result.matchups.map((matchup) => matchup.gameId), [42, 43])
    assert.deepEqual(receivedFilters, [
      { season: 2026, excludeStage: 'Pre Season', gameId: 42 },
      { season: 2026, excludeStage: 'Pre Season', gameId: 43 },
    ])
    assert.equal(operations.filter(([column, value]) => column === 'not:stage' && value === 'Pre Season').length, 1)
    assert.equal(operations.filter(([column, value]) => column === 'stage' && value === 'Regular Season').length, 1)

    const postseason = await buildUpcomingWeekSnapshot(
      client,
      dataSource,
      2026,
      new Date(1_795_000_000 * 1_000).toISOString(),
    )
    assert.equal(postseason.stage, 'Post Season')
    assert.equal(postseason.week, 'Wild Card')
    assert.deepEqual(postseason.matchups.map((matchup) => matchup.gameId), [50])
    assert.deepEqual(receivedFilters.at(-1), {
      season: 2026,
      excludeStage: 'Pre Season',
      gameId: 50,
    })
  })

  it('limits workers to two while preserving input order', async () => {
    let active = 0
    let peak = 0
    const completed: number[] = []
    const results = await mapInBatches([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, value % 2 ? 8 : 1))
      completed.push(value)
      active -= 1
      return value * 10
    })

    assert.equal(peak, 2)
    assert.deepEqual(results, [10, 20, 30, 40, 50])
    assert.notDeepEqual(completed, [1, 2, 3, 4, 5])
  })

  it('attributes matchup context failures to the game and does not return partial context', async () => {
    await assert.rejects(
      buildWeeklyMatchups(
        [{ id: 42 }, { id: 43 }],
        {
          async load() {
            throw new Error('canceling statement due to statement timeout')
          },
        },
        2026,
        '2026-09-22T20:00:00.000Z',
      ),
      (error) => error instanceof WeeklyAnalysisError
        && error.code === 'context_unavailable'
        && /game 42/.test(error.message)
        && /statement timeout/.test(error.message),
    )
  })
})

describe('weekly analysis history', () => {
  it('excludes only preseason from saved-run listing, deletion, and grading', async () => {
    const operations: Array<[string, unknown]> = []
    class Query implements PromiseLike<{ data: []; error: null }> {
      select() { return this }
      delete() { return this }
      eq(column: string, value: unknown) {
        operations.push([column, value])
        return this
      }
      neq(column: string, value: unknown) {
        operations.push([`not:${column}`, value])
        return this
      }
      order() { return this }
      limit() { return this }
      then<TResult1 = { data: []; error: null }, TResult2 = never>(
        onfulfilled?: ((value: { data: []; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve({ data: [], error: null }).then(onfulfilled, onrejected)
      }
    }
    const client = { from: () => new Query() } as unknown as SupabaseClient
    const store = createWeeklyAnalysisStore(client)

    assert.deepEqual(await store.list(), [])
    assert.equal(await store.delete('99000000-0000-4000-8000-000000000001'), false)
    assert.equal(await store.gradePending(), 0)
    assert.equal(
      operations.filter(([column, value]) => column === 'not:stage' && value === 'Pre Season').length,
      3,
    )
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
