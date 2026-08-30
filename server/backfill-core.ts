import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  refreshCurrentInjuries,
  refreshGameEventsByGameId,
  refreshGamePlayerStatsByGameId,
  refreshGameTeamStatsByGameId,
  refreshLeagueMetadata,
  refreshPlayerSeasonStats,
  refreshSeasonOdds,
  refreshSeasonPlayers,
  refreshSeasonSchedule,
  refreshSeasonStandings,
  type IngestConfig,
} from './ingest-core'

const playedStatuses = ['Q1', 'Q2', 'Q3', 'Q4', 'OT', 'HT', 'FT', 'AOT']
const terminalStates = new Set(['complete', 'provider_empty'])

export type ApiUsage = {
  current: number
  limitDay: number
}

type ResourceType =
  | 'league_metadata'
  | 'schedule'
  | 'odds'
  | 'injuries'
  | 'roster'
  | 'standings'
  | 'player_season_stats'
  | 'game_events'
  | 'game_team_stats'
  | 'game_player_stats'

type Checkpoint = {
  resource_type: ResourceType
  season: number
  entity_id: number
  status: 'complete' | 'provider_empty' | 'failed'
  response_count: number
  attempt_count: number
}

type GameRow = {
  id: number
  season: number
  home_team_id: number | null
  away_team_id: number | null
  game_date: string | null
}

type PlannedResource = {
  type: ResourceType
  season: number
  entityId: number
}

type FilterQuery = {
  gte: (column: string, value: unknown) => FilterQuery
  lte: (column: string, value: unknown) => FilterQuery
  in: (column: string, values: readonly unknown[]) => FilterQuery
  order: (column: string, options?: { ascending?: boolean }) => FilterQuery
}

export type BackfillPlan = {
  startSeason: number
  endSeason: number
  estimatedRequests: number
  resources: PlannedResource[]
  gameGaps: Record<'events' | 'teamStats' | 'playerStats', number>
}

export type BackfillSummary = {
  plan: BackfillPlan
  startingUsage: ApiUsage
  endingUsage: ApiUsage
  callsMade: number
  complete: number
  providerEmpty: number
  failed: number
}

export class ApiQuotaBudgetError extends Error {}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error)
    } catch {
      return Object.prototype.toString.call(error)
    }
  }
  return String(error)
}

function asPositiveInteger(value: unknown, label: string) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`API-Sports status returned an invalid ${label}.`)
  }
  return parsed
}

export function parseApiUsage(payload: unknown): ApiUsage {
  if (!payload || typeof payload !== 'object') {
    throw new Error('API-Sports status response is not an object.')
  }
  const root = payload as Record<string, unknown>
  const response = root.response
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('API-Sports status response is missing response.requests.')
  }
  const requests = (response as Record<string, unknown>).requests
  if (!requests || typeof requests !== 'object' || Array.isArray(requests)) {
    throw new Error('API-Sports status response is missing response.requests.')
  }
  const values = requests as Record<string, unknown>
  const current = asPositiveInteger(values.current, 'current request count')
  const limitDay = asPositiveInteger(values.limit_day, 'daily request limit')
  if (limitDay <= 0 || current > limitDay) {
    throw new Error('API-Sports status returned inconsistent request limits.')
  }
  return { current, limitDay }
}

export async function fetchApiUsage(config: IngestConfig): Promise<ApiUsage> {
  const baseUrl = config.apiBaseUrl ?? 'https://v1.american-football.api-sports.io'
  const host = config.apiHost ?? 'v1.american-football.api-sports.io'
  const response = await fetch(`${baseUrl}/status`, {
    headers: {
      'x-apisports-key': config.apiKey,
      'x-rapidapi-key': config.apiKey,
      'x-rapidapi-host': host,
    },
  })
  if (!response.ok) {
    throw new Error(`API-Sports status request failed with HTTP ${response.status}.`)
  }
  return parseApiUsage(await response.json())
}

async function fetchPaged<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  configure?: (query: FilterQuery) => FilterQuery,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += 1_000) {
    let query = supabase.from(table).select(columns)
    if (configure) query = configure(query as unknown as FilterQuery) as unknown as typeof query
    const { data, error } = await query.range(from, from + 999)
    if (error) throw error
    rows.push(...((data ?? []) as T[]))
    if ((data ?? []).length < 1_000) return rows
  }
}

function checkpointKey(type: ResourceType, season: number, entityId: number) {
  return `${type}:${season}:${entityId}`
}

async function loadCheckpoints(
  supabase: SupabaseClient,
  startSeason: number,
  endSeason: number,
) {
  const rows = await fetchPaged<Checkpoint>(
    supabase,
    'ingest_resource_status',
    'resource_type,season,entity_id,status,response_count,attempt_count',
    (query) => query
      .gte('season', startSeason)
      .lte('season', endSeason)
      .order('resource_type')
      .order('season')
      .order('entity_id'),
  )
  return new Map(rows.map((row) => [
    checkpointKey(row.resource_type, row.season, row.entity_id),
    row,
  ]))
}

async function loadGameIds(supabase: SupabaseClient, table: string) {
  const rows = await fetchPaged<{ game_id: number }>(
    supabase,
    table,
    'game_id,id',
    (query) => query.order('game_id').order('id'),
  )
  return new Set(rows.map((row) => row.game_id))
}

function isTerminal(
  checkpoints: Map<string, Checkpoint>,
  type: ResourceType,
  season: number,
  entityId: number,
) {
  return terminalStates.has(checkpoints.get(checkpointKey(type, season, entityId))?.status ?? '')
}

export async function planHistoricalBackfill(
  config: IngestConfig,
  startSeason = 2020,
  endSeason = 2026,
): Promise<BackfillPlan> {
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('Missing production Supabase configuration.')
  }
  if (startSeason > endSeason) throw new Error('startSeason must not exceed endSeason.')
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false },
  })
  const [games, checkpoints, eventGameIds] = await Promise.all([
    fetchPaged<GameRow>(
      supabase,
      'games',
      'id,season,home_team_id,away_team_id,game_date',
      (query) => {
        return query
          .gte('season', startSeason)
          .lte('season', endSeason)
          .in('status_short', playedStatuses)
          .order('season', { ascending: false })
          .order('id')
      },
    ),
    loadCheckpoints(supabase, startSeason, endSeason),
    loadGameIds(supabase, 'game_events'),
  ])

  const resources: PlannedResource[] = []
  const add = (type: ResourceType, season: number, entityId: number) => {
    if (!isTerminal(checkpoints, type, season, entityId)) {
      resources.push({ type, season, entityId })
    }
  }

  for (let season = endSeason; season >= startSeason; season -= 1) {
    add('schedule', season, config.leagueId ?? 1)
  }
  add('league_metadata', endSeason, config.leagueId ?? 1)
  resources.push({ type: 'odds', season: endSeason, entityId: config.leagueId ?? 1 })
  add('injuries', endSeason, config.leagueId ?? 1)

  const teamsBySeason = new Map<number, Set<number>>()
  for (const game of games) {
    const ids = teamsBySeason.get(game.season) ?? new Set<number>()
    if (game.home_team_id) ids.add(game.home_team_id)
    if (game.away_team_id) ids.add(game.away_team_id)
    teamsBySeason.set(game.season, ids)
  }

  for (let season = endSeason; season >= startSeason; season -= 1) {
    add('roster', season, config.leagueId ?? 1)
    add('standings', season, config.leagueId ?? 1)
    if (season >= 2022) add('player_season_stats', season, config.leagueId ?? 1)
  }

  let eventGaps = 0
  let teamStatGaps = 0
  let playerStatGaps = 0
  for (const game of games) {
    if (!eventGameIds.has(game.id) && !isTerminal(checkpoints, 'game_events', game.season, game.id)) {
      resources.push({ type: 'game_events', season: game.season, entityId: game.id })
      eventGaps += 1
    }
    if (!isTerminal(checkpoints, 'game_team_stats', game.season, game.id)) {
      resources.push({ type: 'game_team_stats', season: game.season, entityId: game.id })
      teamStatGaps += 1
    }
    if (!isTerminal(checkpoints, 'game_player_stats', game.season, game.id)) {
      resources.push({ type: 'game_player_stats', season: game.season, entityId: game.id })
      playerStatGaps += 1
    }
  }

  const oddsStart = new Date()
  oddsStart.setUTCDate(oddsStart.getUTCDate() - 7)
  const oddsEnd = new Date()
  oddsEnd.setUTCDate(oddsEnd.getUTCDate() + 7)
  const { count: eligibleOddsGames, error: oddsCountError } = await supabase
    .from('games')
    .select('id', { count: 'exact', head: true })
    .eq('season', endSeason)
    .gte('game_date', oddsStart.toISOString())
    .lte('game_date', oddsEnd.toISOString())
  if (oddsCountError) throw oddsCountError
  const teamScopedRequests = (season: number) => (teamsBySeason.get(season)?.size ?? 32) + 1
  const estimatedRequests = resources.reduce((total, resource) => {
    if (resource.type === 'roster' || resource.type === 'player_season_stats') {
      return total + teamScopedRequests(resource.season)
    }
    if (resource.type === 'injuries') return total + teamScopedRequests(endSeason)
    if (resource.type === 'odds') return total + 2 + (eligibleOddsGames ?? 0)
    if (resource.type === 'schedule') return total + 2
    return total + 1
  }, 0)

  return {
    startSeason,
    endSeason,
    estimatedRequests,
    resources,
    gameGaps: {
      events: eventGaps,
      teamStats: teamStatGaps,
      playerStats: playerStatGaps,
    },
  }
}

async function saveCheckpoint(
  supabase: SupabaseClient,
  checkpoints: Map<string, Checkpoint>,
  resource: PlannedResource,
  status: Checkpoint['status'],
  responseCount: number,
  errorMessage: string | null,
) {
  const key = checkpointKey(resource.type, resource.season, resource.entityId)
  const previous = checkpoints.get(key)
  const now = new Date().toISOString()
  const row: Checkpoint & { last_error: string | null; completed_at: string | null; updated_at: string } = {
    resource_type: resource.type,
    season: resource.season,
    entity_id: resource.entityId,
    status,
    response_count: responseCount,
    attempt_count: (previous?.attempt_count ?? 0) + 1,
    last_error: errorMessage,
    completed_at: status === 'failed' ? null : now,
    updated_at: now,
  }
  const { error } = await supabase
    .from('ingest_resource_status')
    .upsert(row, { onConflict: 'resource_type,season,entity_id' })
  if (error) throw error
  checkpoints.set(key, row)
}

export async function runHistoricalBackfill(
  config: IngestConfig,
  plan: BackfillPlan,
  dailyCeiling = 7_000,
): Promise<BackfillSummary> {
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('Missing production Supabase configuration.')
  }
  const startingUsage = await fetchApiUsage(config)
  if (dailyCeiling > startingUsage.limitDay) {
    throw new Error(`Daily ceiling ${dailyCeiling} exceeds provider limit ${startingUsage.limitDay}.`)
  }
  if (startingUsage.current + plan.estimatedRequests > dailyCeiling) {
    throw new ApiQuotaBudgetError(
      `Backfill needs approximately ${plan.estimatedRequests} requests, but only `
      + `${dailyCeiling - startingUsage.current} are available before the configured ceiling.`,
    )
  }

  let callsMade = 0
  const guardedConfig: IngestConfig = {
    ...config,
    beforeApiRequest: async (path) => {
      if (startingUsage.current + callsMade >= dailyCeiling) {
        throw new ApiQuotaBudgetError(`Daily API request ceiling reached before ${path}.`)
      }
      callsMade += 1
      await config.beforeApiRequest?.(path)
    },
  }
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false },
  })
  const checkpoints = await loadCheckpoints(supabase, plan.startSeason, plan.endSeason)
  let complete = 0
  let providerEmpty = 0
  let failed = 0

  const processResources = async (resources: PlannedResource[]) => {
    for (const resource of resources) {
    try {
      let responseCount = 0
      switch (resource.type) {
        case 'schedule': {
          const result = await refreshSeasonSchedule(guardedConfig, resource.season)
          responseCount = result.games
          break
        }
        case 'league_metadata': {
          const result = await refreshLeagueMetadata(guardedConfig)
          responseCount = result.leagues + result.leagueSeasons
          break
        }
        case 'odds': {
          const result = await refreshSeasonOdds(guardedConfig, resource.season)
          responseCount = result.odds
          break
        }
        case 'injuries': {
          const result = await refreshCurrentInjuries(guardedConfig, resource.season)
          if (result.failedIds.length) throw new Error(`Injury requests failed for teams: ${result.failedIds.join(', ')}`)
          responseCount = result.rowsUpserted
          break
        }
        case 'roster':
          responseCount = await refreshSeasonPlayers(guardedConfig, resource.season)
          break
        case 'standings':
          responseCount = await refreshSeasonStandings(guardedConfig, resource.season)
          break
        case 'player_season_stats': {
          const result = await refreshPlayerSeasonStats(guardedConfig, resource.season)
          if (result.failedIds.length) {
            throw new Error(`Player season stat requests failed for teams: ${result.failedIds.join(', ')}`)
          }
          responseCount = result.rowsUpserted
          break
        }
        case 'game_events':
          responseCount = await refreshGameEventsByGameId(guardedConfig, resource.entityId)
          break
        case 'game_team_stats':
          responseCount = (await refreshGameTeamStatsByGameId(guardedConfig, resource.entityId)).length
          break
        case 'game_player_stats':
          responseCount = (await refreshGamePlayerStatsByGameId(guardedConfig, resource.entityId)).length
          break
      }
      const status = responseCount === 0 ? 'provider_empty' : 'complete'
      await saveCheckpoint(supabase, checkpoints, resource, status, responseCount, null)
      if (status === 'complete') complete += 1
      else providerEmpty += 1
    } catch (error) {
      if (error instanceof ApiQuotaBudgetError) throw error
      const message = describeError(error)
      await saveCheckpoint(supabase, checkpoints, resource, 'failed', 0, message)
      failed += 1
      console.error(`[Backfill] ${resource.type} ${resource.season}/${resource.entityId} failed: ${message}`)
    }
    }
  }

  const scheduleResources = plan.resources.filter((resource) => resource.type === 'schedule')
  await processResources(scheduleResources)
  const refreshedPlan = await planHistoricalBackfill(guardedConfig, plan.startSeason, plan.endSeason)
  if (startingUsage.current + callsMade + refreshedPlan.estimatedRequests > dailyCeiling) {
    throw new ApiQuotaBudgetError(
      `Refreshed backfill needs approximately ${refreshedPlan.estimatedRequests} more requests, but only `
      + `${dailyCeiling - startingUsage.current - callsMade} remain before the configured ceiling.`,
    )
  }
  await processResources(refreshedPlan.resources)

  const endingUsage = await fetchApiUsage(config)
  return {
    plan: refreshedPlan,
    startingUsage,
    endingUsage,
    callsMade,
    complete,
    providerEmpty,
    failed,
  }
}
