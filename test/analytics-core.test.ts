import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AnalyticsValidationError,
  buildAnalyticsSnapshot,
  validateAnalyticsFilters,
  type AnalyticsLimits,
  type AnalyticsSourceData,
  type BettingGameRow,
} from '../server/analytics-core'
import { generateAnalyticsSnapshot, type AnalyticsDataSource } from '../server/analytics-service'

const games: BettingGameRow[] = [
  {
    game_id: 1,
    season: 2025,
    stage: 'Regular Season',
    week: 'Week 1',
    game_date: '2025-09-01',
    game_timestamp: 1_000,
    away_team_id: 2,
    away_team_name: 'Buffalo',
    home_team_id: 1,
    home_team_name: 'Arizona',
    away_score: 20,
    home_score: 27,
    final_total: 47,
    home_margin: 7,
    closing_home_spread: -3.5,
    spread_bookmaker_count: 4,
    spread_delta: 3.5,
    spread_result: 'home_cover',
    closing_total: 44.5,
    total_bookmaker_count: 5,
    total_delta: 2.5,
    total_result: 'over',
  },
  {
    game_id: 2,
    season: 2025,
    stage: 'Regular Season',
    week: 'Week 2',
    game_date: '2025-09-08',
    game_timestamp: 2_000,
    away_team_id: 1,
    away_team_name: 'Arizona',
    home_team_id: 2,
    home_team_name: 'Buffalo',
    away_score: 24,
    home_score: 20,
    final_total: 44,
    home_margin: -4,
    closing_home_spread: 2,
    spread_bookmaker_count: 3,
    spread_delta: -2,
    spread_result: 'away_cover',
    closing_total: 48,
    total_bookmaker_count: 3,
    total_delta: -4,
    total_result: 'under',
  },
  {
    game_id: 3,
    season: 2025,
    stage: 'Regular Season',
    week: 'Week 3',
    game_date: '2025-09-15',
    game_timestamp: 3_000,
    away_team_id: 3,
    away_team_name: 'Chicago',
    home_team_id: 1,
    home_team_name: 'Arizona',
    away_score: 21,
    home_score: 24,
    final_total: 45,
    home_margin: 3,
    closing_home_spread: -3,
    spread_bookmaker_count: 2,
    spread_delta: 0,
    spread_result: 'push',
    closing_total: null,
    total_bookmaker_count: null,
    total_delta: null,
    total_result: 'ungraded',
  },
]

const source: AnalyticsSourceData = {
  games,
  teamStats: [
    { game_id: 1, team_id: 1, yards_total: 400, pass_yards: 250, rush_yards: 150, turnovers_total: 1, sacks: 3 },
    { game_id: 2, team_id: 1, yards_total: 300, pass_yards: 200, rush_yards: 100, turnovers_total: 2, sacks: 1 },
  ],
  standings: [{
    team_id: 1,
    conference: 'NFC',
    division: 'NFC West',
    position: 2,
    won: 10,
    lost: 7,
    ties: 0,
    points_for: 400,
    points_against: 380,
    streak: 'W2',
  }],
  injuries: [{
    player_id: 11,
    team_id: 1,
    injury_date: '2025-09-14',
    status: 'Questionable',
    description: 'Ankle',
  }],
  playerStats: [
    {
      scope: 'season',
      team_id: 1,
      player_id: 11,
      stat_group: 'Passing',
      stat_name: 'yards',
      stat_value: '3,500',
    },
    {
      scope: 'season',
      team_id: 1,
      player_id: 12,
      stat_group: 'Passing',
      stat_name: 'attempts',
      stat_value: '500',
    },
  ],
  players: [
    { id: 11, name: 'Alex Quarterback', position: 'QB' },
    { id: 12, name: 'Ignored Player', position: 'QB' },
  ],
}

const limits: AnalyticsLimits = {
  games: 2,
  injuries: 1,
  playerStats: 1,
  standings: 1,
  teamStatTrends: 1,
  teamTrends: 1,
}

describe('analytics filter validation', () => {
  it('normalizes supported filters', () => {
    assert.deepEqual(validateAnalyticsFilters('season_overview', {
      season: '2025',
      stage: ' Regular Season ',
      week: '',
    }), {
      season: 2025,
      stage: 'Regular Season',
    })
  })

  it('requires preset-specific identifiers', () => {
    assert.throws(
      () => validateAnalyticsFilters('team_analysis', { season: 2025 }),
      AnalyticsValidationError,
    )
    assert.throws(
      () => validateAnalyticsFilters('game_review', { season: 2025 }),
      /gameId is required/,
    )
    assert.throws(
      () => validateAnalyticsFilters('trend_comparison', {
        season: 2025,
        teamId: 1,
        comparisonTeamId: 1,
      }),
      /two different teams/,
    )
  })

  it('rejects invalid seasons, identifiers, and text', () => {
    assert.throws(() => validateAnalyticsFilters('season_overview', { season: 1800 }), /season/)
    assert.throws(
      () => validateAnalyticsFilters('team_analysis', { season: 2025, teamId: -1 }),
      /positive integer/,
    )
    assert.throws(
      () => validateAnalyticsFilters('team_analysis', { season: 2025, teamId: true }),
      /positive integer/,
    )
    assert.throws(
      () => validateAnalyticsFilters('season_overview', { season: 2025, week: 10 }),
      /week must be text/,
    )
  })
})

describe('deterministic analytics snapshot', () => {
  const snapshot = buildAnalyticsSnapshot(
    'team_analysis',
    { season: 2025, teamId: 1 },
    source,
    '2025-10-01T00:00:00.000Z',
    limits,
  )

  it('calculates spread and total summaries outside the LLM', () => {
    assert.deepEqual(snapshot.summary, {
      games: 3,
      spread: {
        graded: 3,
        homeCovers: 1,
        awayCovers: 1,
        pushes: 1,
        ungraded: 0,
        homeCoverRate: 0.5,
        averageDelta: 0.5,
      },
      totals: {
        graded: 2,
        overs: 1,
        unders: 1,
        pushes: 0,
        ungraded: 1,
        overRate: 0.5,
        averageDelta: -0.75,
      },
    })
  })

  it('calculates team-perspective ATS records and deltas', () => {
    assert.deepEqual(snapshot.teamTrends.items, [{
      teamId: 1,
      teamName: 'Arizona',
      games: 3,
      atsWins: 2,
      atsLosses: 0,
      atsPushes: 1,
      atsUngraded: 0,
      atsWinRate: 1,
      overs: 1,
      unders: 1,
      totalPushes: 0,
      totalsUngraded: 1,
      overRate: 0.5,
      averageTeamSpreadDelta: 1.833,
    }])
  })

  it('aggregates team statistics and reports missing team box scores', () => {
    assert.deepEqual(snapshot.teamStatTrends.items, [{
      teamId: 1,
      teamName: 'Arizona',
      games: 2,
      averageTotalYards: 350,
      averagePassYards: 225,
      averageRushYards: 125,
      averageTurnovers: 1.5,
      averageSacks: 2,
    }])
    assert.equal(snapshot.dataQuality.gamesMissingRequiredTeamStats, 1)
  })

  it('whitelists player statistics and resolves player and team names', () => {
    assert.deepEqual(snapshot.playerStats.items, [{
      scope: 'season',
      team_id: 1,
      player_id: 11,
      stat_group: 'Passing',
      stat_name: 'yards',
      stat_value: '3,500',
      playerName: 'Alex Quarterback',
      position: 'QB',
    }])
    assert.equal(snapshot.currentInjuries.items[0].playerName, 'Alex Quarterback')
    assert.equal(snapshot.currentInjuries.items[0].teamName, 'Arizona')
    assert.equal(snapshot.standings.items[0].teamName, 'Arizona')
  })

  it('sorts details deterministically and reports truncation', () => {
    assert.deepEqual(snapshot.games.items.map((game) => game.gameId), [3, 2])
    assert.deepEqual(
      { total: snapshot.games.total, included: snapshot.games.included, truncated: snapshot.games.truncated },
      { total: 3, included: 2, truncated: true },
    )
    assert.equal(snapshot.playerStats.total, 1)
    assert.equal(snapshot.generatedAt, '2025-10-01T00:00:00.000Z')
    assert.equal(snapshot.schemaVersion, 1)
  })

  it('balances bounded player detail across stat categories', () => {
    const balanced = buildAnalyticsSnapshot(
      'team_analysis',
      { season: 2025, teamId: 1 },
      {
        ...source,
        playerStats: [
          ...source.playerStats,
          {
            scope: 'season',
            team_id: 1,
            player_id: 12,
            stat_group: 'Defensive',
            stat_name: 'sacks',
            stat_value: '8',
          },
        ],
      },
      '2025-10-01T00:00:00.000Z',
      { ...limits, playerStats: 2 },
    )

    assert.deepEqual(
      balanced.playerStats.items.map((stat) => `${stat.stat_group}:${stat.stat_name}`),
      ['Defensive:sacks', 'Passing:yards'],
    )
  })
})

describe('analytics service orchestration', () => {
  it('loads normalized filters and uses an injectable clock and data source', async () => {
    let received: unknown
    const dataSource: AnalyticsDataSource = {
      async load(filters, preset) {
        received = { filters, preset }
        return { games: [], teamStats: [], standings: [], injuries: [], playerStats: [], players: [] }
      },
    }

    const snapshot = await generateAnalyticsSnapshot(
      dataSource,
      'game_review',
      { season: '2025', gameId: '42' },
      { generatedAt: () => '2025-10-02T00:00:00.000Z' },
    )

    assert.deepEqual(received, {
      filters: { season: 2025, gameId: 42 },
      preset: 'game_review',
    })
    assert.equal(snapshot.generatedAt, '2025-10-02T00:00:00.000Z')
    assert.equal(snapshot.summary.games, 0)
  })
})
