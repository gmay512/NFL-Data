import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  AnalyticsTargetError,
  createSupabaseAnalyticsDataSource,
} from '../server/analytics-service'

type Operation = { method: string; args: unknown[] }
type QueryLog = { table: string; operations: Operation[] }

const completedGame = {
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

function fakeClient(status = 'NS') {
  const logs: QueryLog[] = []
  const rows: Record<string, unknown[]> = {
    games: [{
      id: 42,
      season: 2025,
      stage: 'Regular Season',
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
    game_betting_results: [completedGame],
    game_team_stats: [],
    standings: [],
    injuries: [{ player_id: 11, team_id: 1, injury_date: '2025-10-01', status: 'Questionable', description: 'Ankle' }],
    player_season_stats: [{ team_id: 1, player_id: 11, stat_group: 'Passing', stat_name: 'yards', stat_value: '1000' }],
    players: [{ id: 11, name: 'Quarterback', position: 'QB' }],
  }

  class Query implements PromiseLike<{ data: unknown[] | unknown | null; error: null; count?: number }> {
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
    lt(...args: unknown[]) { return this.add('lt', args) }
    in(...args: unknown[]) { return this.add('in', args) }
    is(...args: unknown[]) { return this.add('is', args) }
    or(...args: unknown[]) { return this.add('or', args) }
    order(...args: unknown[]) { return this.add('order', args) }
    limit(...args: unknown[]) { return this.add('limit', args) }
    range(...args: unknown[]) { return this.add('range', args) }

    maybeSingle() {
      this.add('maybeSingle', [])
      return Promise.resolve({ data: rows[this.log.table]?.[0] ?? null, error: null })
    }

    then<TResult1 = { data: unknown[]; error: null; count?: number }, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown[]; error: null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      const data = rows[this.log.table] ?? []
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
  } as unknown as SupabaseClient
  return { client, logs }
}

function operation(log: QueryLog, method: string, firstArg: unknown) {
  return log.operations.find((entry) => entry.method === method && entry.args[0] === firstArg)
}

describe('matchup preview data loading', () => {
  it('bounds completed history before kickoff to the two target teams and loads current context', async () => {
    const { client, logs } = fakeClient()
    const source = await createSupabaseAnalyticsDataSource(client).load(
      { season: 2025, gameId: 42 },
      'matchup_preview',
    )

    assert.deepEqual(source.targetMatchup?.currentConsensusOdds, { homeSpread: 2.5, total: 47.5 })
    assert.deepEqual(source.games.map((game) => game.game_id), [10])
    const history = logs.find((log) => log.table === 'game_betting_results')!
    assert.deepEqual(operation(history, 'eq', 'season')?.args, ['season', 2025])
    assert.deepEqual(operation(history, 'lt', 'game_timestamp')?.args, ['game_timestamp', 1_759_680_000])
    assert.deepEqual(history.operations.find((entry) => entry.method === 'or')?.args, [
      'home_team_id.in.(1,2),away_team_id.in.(1,2)',
    ])
    assert.equal(operation(history, 'eq', 'game_id'), undefined)

    const teamStats = logs.find((log) => log.table === 'game_team_stats')!
    assert.deepEqual(operation(teamStats, 'in', 'game_id')?.args, ['game_id', [10]])
    assert.deepEqual(operation(teamStats, 'in', 'team_id')?.args, ['team_id', [1, 2]])
    const seasonStats = logs.find((log) => log.table === 'player_season_stats')!
    assert.deepEqual(operation(seasonStats, 'eq', 'season')?.args, ['season', 2025])
    assert.deepEqual(operation(seasonStats, 'in', 'team_id')?.args, ['team_id', [1, 2]])
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
    assert.equal(final.logs.some((log) => log.table === 'game_betting_results'), false)
  })
})
