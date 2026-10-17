import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  AnalyticsTargetError,
  createSupabaseAnalyticsDataSource,
} from '../server/analytics-service'
import { buildAnalyticsSnapshot, type BettingGameRow } from '../server/analytics-core'

type Operation = { method: string; args: unknown[] }
type QueryLog = { table: string; operations: Operation[] }
type QueryResult = { data: unknown[] | unknown | null; error: { message: string; code?: string } | null; count?: number }

const completedGame: BettingGameRow = {
  game_id: 10,
  season: 2025,
  stage: 'Regular Season',
  week: 'Week 1',
  game_date: '2025-09-01',
  game_timestamp: 1_756_700_000,
  away_team_id: 2,
  away_team_name: 'Buffalo',
  home_team_id: 3,
  home_team_name: 'Chicago',
  away_score: 24,
  home_score: 20,
  final_total: 44,
  home_margin: -4,
  closing_home_spread: 1.5,
  spread_bookmaker_count: 3,
  spread_delta: -2.5,
  spread_result: 'away_cover',
  closing_total: 45,
  total_bookmaker_count: 3,
  total_delta: -1,
  total_result: 'under',
}

function fakeClient(
  status = 'NS',
  completedGames: BettingGameRow[] = [completedGame],
  bettingError: unknown = null,
  consensusError: unknown = null,
  targetStage = 'Regular Season',
) {
  const logs: QueryLog[] = []
  const rpcCalls: Array<{ name: string; gameIds: number[] }> = []
  const recordGames = completedGames.map((game) => ({
    id: game.game_id, season: game.season, stage: game.stage, status_short: 'FT',
    game_timestamp: game.game_timestamp,
    away_team_id: game.away_team_id, home_team_id: game.home_team_id,
    away_total: game.away_score as number | null, home_total: game.home_score as number | null,
  }))
  const recordFailure: { error: { message: string; code?: string } | null } = { error: null }
  const rows: Record<string, unknown[]> = {
    games: [{
      id: 42,
      season: 2025,
      stage: targetStage,
      week: 'Week 5',
      game_date: '2025-10-05',
      game_timestamp: 1_759_680_000,
      venue_name: 'State Farm Stadium',
      venue_city: 'Glendale',
      status_short: status,
      status_long: status === 'NS' ? 'Not Started' : 'Finished',
      away_team_id: 2,
      home_team_id: 1,
    }],
    teams: [{ id: 1, name: 'Arizona' }, { id: 2, name: 'Buffalo' }],
    game_consensus_odds: [{ game_id: 42, home_spread: '2.5', total: '47.5' }],
    game_team_stats: [],
    standings: [],
    injuries: [{ player_id: 11, team_id: 1, injury_date: '2025-10-01', status: 'Questionable', description: 'Ankle' }],
    player_season_stats: [{ team_id: 1, player_id: 11, stat_group: 'Passing', stat_name: 'yards', stat_value: '1000' }],
    players: [{ id: 11, name: 'Quarterback', position: 'QB' }],
  }

  class Query implements PromiseLike<QueryResult> {
    readonly log: QueryLog

    constructor(table: string) {
      this.log = { table, operations: [] }
      logs.push(this.log)
    }

    private add(method: string, args: unknown[]) {
      this.log.operations.push({ method, args })
      return this
    }

    select(...args: unknown[]) { return this.add('select', args) }
    eq(...args: unknown[]) { return this.add('eq', args) }
    neq(...args: unknown[]) { return this.add('neq', args) }
    lt(...args: unknown[]) { return this.add('lt', args) }
    in(...args: unknown[]) { return this.add('in', args) }
    not(...args: unknown[]) { return this.add('not', args) }
    is(...args: unknown[]) { return this.add('is', args) }
    or(...args: unknown[]) { return this.add('or', args) }
    order(...args: unknown[]) { return this.add('order', args) }
    limit(...args: unknown[]) { return this.add('limit', args) }
    range(...args: unknown[]) { return this.add('range', args) }
    abortSignal(...args: unknown[]) { return this.add('abortSignal', args) }

    maybeSingle() {
      this.add('maybeSingle', [])
      return Promise.resolve({ data: rows[this.log.table]?.[0] ?? null, error: null })
    }

    then<TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      const selectedColumns = String(operation(this.log, 'select', 'id,game_timestamp,away_team_id,home_team_id,away_total,home_total')?.args[0] ?? '')
      if (this.log.table === 'games' && selectedColumns.includes('away_total')) {
        const season = operation(this.log, 'eq', 'season')?.args[1]
        const cutoff = operation(this.log, 'lt', 'game_timestamp')?.args[1]
        const teams = String(this.log.operations.find((entry) => entry.method === 'or')?.args[0] ?? '')
          .match(/home_team_id\.in\.\(([\d,]+)\)/)?.[1].split(',').map(Number) ?? []
        const range = this.log.operations.find((entry) => entry.method === 'range')?.args as number[]
        const selected = recordGames.filter((game) =>
          game.season === season && game.stage === 'Regular Season'
          && ['FT', 'AOT'].includes(game.status_short)
          && game.game_timestamp != null && game.game_timestamp < Number(cutoff)
          && (teams.includes(game.home_team_id) || teams.includes(game.away_team_id)))
          .slice(range[0], range[1] + 1)
        return Promise.resolve({ data: selected, error: recordFailure.error })
          .then(onfulfilled, onrejected)
      }
      const stage = operation(this.log, 'eq', 'stage')?.args[1]
      const excludedStages = this.log.operations.filter((entry) => entry.method === 'neq' && entry.args[0] === 'stage')
        .map((entry) => entry.args[1])
      const stageGames = stage == null
        ? completedGames
        : completedGames.filter((game) => game.stage === stage)
      const excludedGames = stageGames.filter((game) => !excludedStages.includes(game.stage))
      const season = operation(this.log, 'eq', 'season')?.args[1]
      const cutoff = operation(this.log, 'lt', 'game_timestamp')?.args[1]
      const expression = this.log.operations.find((entry) => entry.method === 'or')?.args[0]
      const teamIds = typeof expression === 'string'
        ? expression.match(/home_team_id\.in\.\(([\d,]+)\)/)?.[1].split(',').map(Number) : undefined
      const selectedGames = excludedGames.filter((game) =>
        (season == null || game.season === season)
        && (cutoff == null || (game.game_timestamp != null && game.game_timestamp < Number(cutoff)))
        && (!teamIds || teamIds.includes(game.home_team_id) || teamIds.includes(game.away_team_id)))
      const data = this.log.table === 'games'
        ? selectedGames.map((game) => ({ id: game.game_id, game_timestamp: game.game_timestamp }))
        : rows[this.log.table] ?? []
      const includeCount = this.log.operations.some(({ method, args }) =>
        method === 'select' && (args[1] as { count?: string } | undefined)?.count === 'exact')
      return Promise.resolve({ data, error: null, count: includeCount ? data.length : undefined })
        .then(onfulfilled, onrejected)
    }
  }

  const client = {
    from(table: string) {
      return new Query(table)
    },
    rpc(name: string, args: { requested_game_ids: number[] }) {
      rpcCalls.push({ name, gameIds: args.requested_game_ids })
      if (name === 'get_game_consensus_odds') {
        assert.deepEqual(args.requested_game_ids, [42])
        const result = Promise.resolve(consensusError
          ? { data: null, error: consensusError } : { data: rows.game_consensus_odds, error: null })
        return Object.assign(result, { abortSignal: () => result })
      }
      assert.equal(name, 'get_game_betting_results')
      const result = Promise.resolve(bettingError ? { data: null, error: bettingError } : {
        data: completedGames.filter((game) => args.requested_game_ids.includes(game.game_id)), error: null,
      })
      return Object.assign(result, { abortSignal: () => result })
    },
  } as unknown as SupabaseClient
  return { client, logs, rpcCalls, recordGames, recordFailure, rows }
}

function operation(log: QueryLog, method: string, firstArg: unknown) {
  return log.operations.find((entry) => entry.method === method && entry.args[0] === firstArg)
}

describe('matchup preview data loading', () => {
  it('replaces lagging standings with all completed results including the latest game, regardless of odds', async () => {
    const latest = {
      ...completedGame, game_id: 11, game_timestamp: completedGame.game_timestamp! + 7 * 86400,
      away_team_id: 1, home_team_id: 2, away_score: 21, home_score: 21,
      closing_home_spread: null, closing_total: null, spread_result: 'ungraded' as const, total_result: 'ungraded' as const,
    }
    const fake = fakeClient('NS', [completedGame, latest])
    fake.recordGames[1].status_short = 'AOT'
    fake.rows.standings = [{
      team_id: 2, conference: 'AFC', division: 'AFC East', position: 1,
      won: 0, lost: 0, ties: 0, points_for: 0, points_against: 0, streak: 'W1',
    }]
    const source = await createSupabaseAnalyticsDataSource(fake.client).load(
      { season: 2025, gameId: 42, week: 'Week 5' }, 'matchup_preview',
    )
    const buffalo = source.standings.find((row) => row.team_id === 2)!
    assert.deepEqual([buffalo.won, buffalo.lost, buffalo.ties], [1, 0, 1])
    const arizona = source.standings.find((row) => row.team_id === 1)!
    assert.deepEqual([arizona.won, arizona.lost, arizona.ties], [0, 0, 1])
    assert.equal(buffalo.position, null)
    assert.equal(buffalo.streak, null)
    assert.equal(buffalo.points_for, 45)
    assert.equal(buffalo.recordBasis?.latestGameTimestamp, latest.game_timestamp)
    assert(!fake.logs.some((log) => log.table === 'standings'))
    const recordQuery = fake.logs.find((log) =>
      operation(log, 'select', 'id,game_timestamp,away_team_id,home_team_id,away_total,home_total'))!
    assert.deepEqual(operation(recordQuery, 'in', 'status_short')?.args, ['status_short', ['FT', 'AOT']])
    assert.equal(operation(recordQuery, 'eq', 'week'), undefined)
    assert(!recordQuery.operations.some((op) => op.method === 'not'))
  })

  it('keeps regular-season records complete despite postseason history filters, byes and truncated details', async () => {
    const regular = { ...completedGame, game_id: 9, home_team_id: 1 }
    const postseason = { ...regular, game_id: 11, stage: 'Post Season' }
    const fake = fakeClient('NS', [regular, postseason], null, null, 'Post Season')
    const source = await createSupabaseAnalyticsDataSource(fake.client).load(
      { season: 2025, gameId: 42, stage: 'Post Season' }, 'matchup_preview',
    )
    assert.deepEqual(source.games.map((game) => game.game_id), [11])
    const snapshot = buildAnalyticsSnapshot('matchup_preview', { season: 2025, gameId: 42 }, source,
      undefined, { games: 0, standings: 2, teamTrends: 2, teamStatTrends: 2, injuries: 2, playerStats: 2 })
    assert.equal(snapshot.games.items.length, 0)
    assert.deepEqual(snapshot.standings.items.map((row) => [row.team_id, row.won, row.lost, row.ties]), [
      [1, 0, 1, 0], [2, 1, 0, 0],
    ])
    assert.equal(snapshot.standings.items[1].recordBasis?.source, 'completed_regular_season_results')
  })

  it('excludes non-regular-season, incomplete, other-season, unrelated and at/after-target results', async () => {
    const fake = fakeClient()
    const base = fake.recordGames[0]
    fake.recordGames.push(
      { ...base, id: 20, stage: 'Pre Season' },
      { ...base, id: 21, stage: 'Post Season' },
      { ...base, id: 22, season: 2024 },
      { ...base, id: 23, status_short: 'Q4' },
      { ...base, id: 24, status_short: 'NS' },
      { ...base, id: 25, status_short: 'CANC' },
      { ...base, id: 26, game_timestamp: 1_759_680_000 },
      { ...base, id: 27, game_timestamp: 1_759_680_001 },
      { ...base, id: 28, home_team_id: 50, away_team_id: 51 },
    )
    const source = await createSupabaseAnalyticsDataSource(fake.client).load({ season: 2025, gameId: 42 }, 'matchup_preview')
    assert.deepEqual(source.standings.map((row) => [row.team_id, row.won, row.lost, row.ties]), [
      [1, 0, 0, 0], [2, 1, 0, 0],
    ])
    assert.equal(source.standings[0].recordBasis?.latestGameTimestamp, null)
  })

  it('paginates record results independently of bounded history', async () => {
    const fake = fakeClient('NS', [])
    fake.recordGames.push(...Array.from({ length: 1001 }, (_, index) => ({
      id: index + 1, season: 2025, stage: 'Regular Season', status_short: 'FT',
      game_timestamp: 1_750_000_000 + index, away_team_id: 2, home_team_id: 1,
      away_total: 24, home_total: 20,
    })))
    const source = await createSupabaseAnalyticsDataSource(fake.client).load({ season: 2025, gameId: 42 }, 'matchup_preview')
    assert.equal(source.standings.find((row) => row.team_id === 2)?.won, 1001)
    assert.equal(fake.logs.filter((log) =>
      operation(log, 'select', 'id,game_timestamp,away_team_id,home_team_id,away_total,home_total')).length, 2)
  })

  it('fails explicitly on incomplete scores, duplicate results and record read errors instead of showing zero records', async () => {
    for (const failure of ['score', 'duplicate', 'database'] as const) {
      const fake = fakeClient()
      if (failure === 'score') fake.recordGames[0].away_total = null
      if (failure === 'duplicate') fake.recordGames.push({ ...fake.recordGames[0] })
      if (failure === 'database') fake.recordFailure.error = { message: 'record read failed', code: '57014' }
      await assert.rejects(createSupabaseAnalyticsDataSource(fake.client).load(
        { season: 2025, gameId: 42 }, 'matchup_preview',
      ), failure === 'database' ? /record read failed/ : /duplicate or invalid result data/)
    }
  })

  it('defaults Week 4 to three regular-season appearances per team even with graded preseason games', async () => {
    const regular = [1, 2].flatMap((teamId) => Array.from({ length: 3 }, (_, index) => ({
      ...completedGame, game_id: teamId * 100 + index,
      away_team_id: teamId, home_team_id: 4 + teamId,
      game_timestamp: completedGame.game_timestamp + index,
    })))
    const excluded = [
      { ...regular[0], game_id: 900, stage: 'Pre Season' },
      { ...regular[1], game_id: 901, stage: 'Preseason' },
      { ...regular[0], game_id: 902, season: 2024 },
      { ...regular[0], game_id: 42, game_timestamp: 1_759_680_000 },
      { ...regular[0], game_id: 903, game_timestamp: 1_759_680_001 },
      { ...regular[0], game_id: 904, away_team_id: 50, home_team_id: 51 },
    ]
    const { client, logs } = fakeClient('NS', [...regular, ...excluded])
    const source = await createSupabaseAnalyticsDataSource(client).load({ season: 2025, gameId: 42 }, 'matchup_preview')
    assert.deepEqual(new Set(source.games.map((game) => game.game_id)), new Set(regular.map((game) => game.game_id)))
    assert.equal(source.games.filter((game) => game.away_team_id === 1).length, 3)
    assert.equal(source.games.filter((game) => game.away_team_id === 2).length, 3)
    assert.deepEqual(source.evidenceScope, {
      season: 2025, stage: 'Regular Season', excludedStage: null,
      beforeKickoff: 1_759_680_000, teamIds: [1, 2],
    })
    const stats = logs.find((log) => log.table === 'game_team_stats')!
    assert.equal((operation(stats, 'in', 'game_id')?.args[1] as number[]).length, 6)
  })

  it('preserves postseason history without including preseason', async () => {
    const postseason = { ...completedGame, game_id: 11, stage: 'Post Season' }
    const preseason = { ...completedGame, game_id: 9, stage: 'Pre Season' }
    const { client } = fakeClient('NS', [completedGame, postseason, preseason, {
      ...preseason, game_id: 8, stage: 'Preseason',
    }], null, null, 'Post Season')
    const source = await createSupabaseAnalyticsDataSource(client).load({ season: 2025, gameId: 42 }, 'matchup_preview')
    assert.deepEqual(source.games.map((game) => game.game_id).sort(), [10, 11])
    assert.equal(source.evidenceScope?.excludedStage, 'Pre Season')
  })

  it('bounds completed history before kickoff to the two target teams and loads current context', async () => {
    const { client, logs, rpcCalls } = fakeClient()
    const source = await createSupabaseAnalyticsDataSource(client).load(
      { season: 2025, gameId: 42 },
      'matchup_preview',
    )

    assert.deepEqual(source.targetMatchup?.currentConsensusOdds, { homeSpread: 2.5, total: 47.5 })
    assert.deepEqual(source.games.map((game) => game.game_id), [10])
    const history = logs.find((log) =>
      log.table === 'games' && log.operations.some(({ method }) => method === 'lt'))!
    assert.deepEqual(operation(history, 'eq', 'season')?.args, ['season', 2025])
    assert.deepEqual(operation(history, 'eq', 'stage')?.args, ['stage', 'Regular Season'])
    assert.deepEqual(operation(history, 'lt', 'game_timestamp')?.args, ['game_timestamp', 1_759_680_000])
    assert.deepEqual(history.operations.find((entry) => entry.method === 'or')?.args, [
      'home_team_id.in.(1,2),away_team_id.in.(1,2)',
    ])
    assert.equal(operation(history, 'eq', 'game_id'), undefined)
    assert.deepEqual(rpcCalls.at(-1), { name: 'get_game_betting_results', gameIds: [10] })

    const teamStats = logs.find((log) => log.table === 'game_team_stats')!
    assert.deepEqual(operation(teamStats, 'in', 'game_id')?.args, ['game_id', [10]])
    assert.deepEqual(operation(teamStats, 'in', 'team_id')?.args, ['team_id', [1, 2]])
    const seasonStats = logs.find((log) => log.table === 'player_season_stats')!
    assert.deepEqual(operation(seasonStats, 'eq', 'season')?.args, ['season', 2025])
    assert.deepEqual(operation(seasonStats, 'in', 'team_id')?.args, ['team_id', [1, 2]])
  })

  it('restricts matchup history and downstream game data when a stage is supplied', async () => {
    const preseasonGame: BettingGameRow = {
      ...completedGame,
      game_id: 9,
      stage: 'Preseason',
      week: 'Pre Season Week 3',
      game_timestamp: completedGame.game_timestamp - 1,
    }
    const { client, logs, rpcCalls } = fakeClient('NS', [preseasonGame, completedGame])

    const source = await createSupabaseAnalyticsDataSource(client).load(
      { season: 2025, stage: 'Regular Season', gameId: 42 },
      'matchup_preview',
    )

    assert.deepEqual(source.games.map((game) => game.game_id), [10])
    const history = logs.find((log) =>
      log.table === 'games' && log.operations.some(({ method }) => method === 'lt'))!
    assert.deepEqual(operation(history, 'eq', 'stage')?.args, ['stage', 'Regular Season'])
    assert.deepEqual(rpcCalls.at(-1), { name: 'get_game_betting_results', gameIds: [10] })
    const teamStats = logs.find((log) => log.table === 'game_team_stats')!
    assert.deepEqual(operation(teamStats, 'in', 'game_id')?.args, ['game_id', [10]])
  })

  it('keeps regular and postseason history while excluding preseason', async () => {
    const preseasonGame: BettingGameRow = {
      ...completedGame,
      game_id: 8,
      stage: 'Pre Season',
      week: 'Pre Season Week 3',
    }
    const postseasonGame: BettingGameRow = {
      ...completedGame,
      game_id: 11,
      stage: 'Post Season',
      week: 'Wild Card',
      game_timestamp: completedGame.game_timestamp + 1,
    }
    const { client, logs, rpcCalls } = fakeClient(
      'NS',
      [preseasonGame, completedGame, postseasonGame],
    )

    const source = await createSupabaseAnalyticsDataSource(client).load(
      { season: 2025, excludeStage: 'Pre Season', gameId: 42 },
      'matchup_preview',
    )

    assert.deepEqual(source.games.map((game) => game.game_id), [11, 10])
    const history = logs.find((log) =>
      log.table === 'games' && log.operations.some(({ method }) => method === 'lt'))!
    assert.deepEqual(operation(history, 'neq', 'stage')?.args, ['stage', 'Pre Season'])
    assert.deepEqual(rpcCalls.at(-1), {
      name: 'get_game_betting_results',
      gameIds: [10, 11],
    })
  })

  it('selects eligible games first and chunks bounded betting result requests', async () => {
    const completedGames = Array.from({ length: 21 }, (_, index) => ({
      ...completedGame,
      game_id: index + 1,
      game_timestamp: completedGame.game_timestamp + index,
    }))
    const { client, logs, rpcCalls } = fakeClient('NS', completedGames)

    const source = await createSupabaseAnalyticsDataSource(client).load(
      {
        season: 2025,
        stage: 'Regular Season',
        week: 'Week 1',
        teamId: 2,
        comparisonTeamId: 3,
      },
      'trend_comparison',
    )

    assert.equal(source.games.length, 21)
    assert.deepEqual(rpcCalls.filter((call) => call.name === 'get_game_betting_results'), [
      { name: 'get_game_betting_results', gameIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      { name: 'get_game_betting_results', gameIds: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
      { name: 'get_game_betting_results', gameIds: [21] },
    ])
    const selection = logs.find((log) =>
      log.table === 'games' && log.operations.some(({ method }) => method === 'limit'))!
    assert.deepEqual(operation(selection, 'in', 'status_short')?.args, ['status_short', ['FT', 'AOT']])
    assert.deepEqual(operation(selection, 'eq', 'stage')?.args, ['stage', 'Regular Season'])
    assert.deepEqual(operation(selection, 'eq', 'week')?.args, ['week', 'Week 1'])
    assert.deepEqual(selection.operations.find(({ method }) => method === 'or')?.args, [
      'home_team_id.in.(2,3),away_team_id.in.(2,3)',
    ])
  })

  it('identifies bounded odds RPC failures', async () => {
    const queryError = { code: '57014', message: 'statement timeout' }
    const betting = fakeClient('NS', [completedGame], queryError)

    await assert.rejects(
      createSupabaseAnalyticsDataSource(betting.client).load({ season: 2025 }, 'season_overview'),
      /Could not load closing betting results for games 10 \(get_game_betting_results\): statement timeout \(code=57014\)/,
    )

    const current = fakeClient('NS', [completedGame], null, queryError)
    await assert.rejects(
      createSupabaseAnalyticsDataSource(current.client).load(
        { season: 2025, gameId: 42 },
        'matchup_preview',
      ),
      /Could not load current consensus odds for game 42 \(get_game_consensus_odds\): statement timeout \(code=57014\)/,
    )
  })

  it('filters completed game reviews by the games primary key', async () => {
    const { client, logs } = fakeClient()

    await createSupabaseAnalyticsDataSource(client).load(
      { season: 2025, gameId: completedGame.game_id },
      'game_review',
    )

    const selection = logs.find((log) =>
      log.table === 'games' && log.operations.some(({ method }) => method === 'limit'))!
    assert.deepEqual(operation(selection, 'eq', 'id')?.args, ['id', completedGame.game_id])
    assert.equal(operation(selection, 'eq', 'game_id'), undefined)
  })

  it('reports missing and ineligible target games explicitly', async () => {
    const missing = fakeClient()
    const originalFrom = (missing.client as unknown as { from: (table: string) => unknown }).from
    ;(missing.client as unknown as { from: (table: string) => unknown }).from = (table) => {
      const query = originalFrom.call(missing.client, table) as { maybeSingle?: () => Promise<unknown> }
      if (table === 'games') query.maybeSingle = () => Promise.resolve({ data: null, error: null })
      return query
    }
    await assert.rejects(
      createSupabaseAnalyticsDataSource(missing.client).load({ season: 2025, gameId: 999 }, 'matchup_preview'),
      (error) => error instanceof AnalyticsTargetError && error.code === 'target_game_not_found',
    )

    const final = fakeClient('FT')
    await assert.rejects(
      createSupabaseAnalyticsDataSource(final.client).load({ season: 2025, gameId: 42 }, 'matchup_preview'),
      (error) => error instanceof AnalyticsTargetError && error.code === 'target_game_ineligible',
    )
    assert.equal(final.rpcCalls.some((call) => call.name === 'get_game_betting_results'), false)
  })
})
