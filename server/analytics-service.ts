import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  buildAnalyticsSnapshot,
  DEFAULT_ANALYTICS_LIMITS,
  validateAnalyticsFilters,
  type AnalyticsFilters,
  type AnalyticsInjuryRow,
  type AnalyticsLimits,
  type AnalyticsPlayerRow,
  type AnalyticsPlayerStatRow,
  type AnalyticsPreset,
  type AnalyticsSnapshot,
  type AnalyticsSourceData,
  type AnalyticsStandingRow,
  type AnalyticsTargetMatchup,
  type AnalyticsTeamStatRow,
  type BettingGameRow,
} from './analytics-core'

const DATABASE_PAGE_SIZE = 1_000
const MAX_ANALYTICS_GAMES = 1_000
const POSTGREST_IN_FILTER_CHUNK_SIZE = 200
const gamePlayerStatGroups = ['Defense', 'Passing', 'Receiving', 'Rushing']
const seasonPlayerStatGroups = ['Defensive', 'Passing', 'Receiving', 'Rushing']

const bettingGameColumns = 'game_id,season,stage,week,game_date,game_timestamp,away_team_id,away_team_name,home_team_id,home_team_name,away_score,home_score,final_total,home_margin,closing_home_spread,spread_bookmaker_count,spread_delta,spread_result,closing_total,total_bookmaker_count,total_delta,total_result'
const targetGameColumns = 'id,season,stage,week,game_date,game_timestamp,venue_name,venue_city,status_short,status_long,away_team_id,home_team_id'

export type AnalyticsServiceConfig = {
  supabaseUrl: string
  serviceRoleKey: string
}

export interface AnalyticsDataSource {
  load(filters: AnalyticsFilters, preset: AnalyticsPreset): Promise<AnalyticsSourceData>
}

export class AnalyticsTargetError extends Error {
  readonly code: 'target_game_ineligible' | 'target_game_not_found'

  constructor(code: AnalyticsTargetError['code'], message: string) {
    super(message)
    this.name = 'AnalyticsTargetError'
    this.code = code
  }
}

type TargetGameRow = {
  id: number
  season: number
  stage: string | null
  week: string | null
  game_date: string | null
  game_timestamp: number | null
  venue_name: string | null
  venue_city: string | null
  status_short: string | null
  status_long: string | null
  away_team_id: number | null
  home_team_id: number | null
}

type AnalyticsServiceOptions = {
  generatedAt?: () => string
  limits?: AnalyticsLimits
}

async function fetchAllPages<T>(loadPage: (from: number, to: number) => Promise<T[]>) {
  const rows: T[] = []
  for (let from = 0; ; from += DATABASE_PAGE_SIZE) {
    const page = await loadPage(from, from + DATABASE_PAGE_SIZE - 1)
    rows.push(...page)
    if (page.length < DATABASE_PAGE_SIZE) return rows
  }
}

function throwQueryError(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

function selectedTeamIds(filters: AnalyticsFilters, games: BettingGameRow[]) {
  const explicitlySelected = [filters.teamId, filters.comparisonTeamId]
    .filter((teamId): teamId is number => teamId != null)
  if (explicitlySelected.length) return [...new Set(explicitlySelected)].sort((left, right) => left - right)

  return [...new Set(games.flatMap((game) => [game.away_team_id, game.home_team_id]))]
    .sort((left, right) => left - right)
}

async function loadGames(client: SupabaseClient, filters: AnalyticsFilters) {
  let query = client
    .from('game_betting_results')
    .select(bettingGameColumns, { count: 'exact' })
    .eq('season', filters.season)
    .order('game_timestamp', { ascending: false })
    .order('game_id', { ascending: false })
    .limit(MAX_ANALYTICS_GAMES)

  if (filters.stage) query = query.eq('stage', filters.stage)
  if (filters.week) query = query.eq('week', filters.week)
  if (filters.gameId) query = query.eq('game_id', filters.gameId)
  if (filters.comparisonTeamId && filters.teamId) {
    const teamIds = `${filters.teamId},${filters.comparisonTeamId}`
    query = query.or(`home_team_id.in.(${teamIds}),away_team_id.in.(${teamIds})`)
  } else if (filters.teamId) {
    query = query.or(`home_team_id.eq.${filters.teamId},away_team_id.eq.${filters.teamId}`)
  }

  const { data, error, count } = await query
  throwQueryError(error)
  if ((count ?? 0) > MAX_ANALYTICS_GAMES) {
    throw new Error(`Analytics selection exceeds ${MAX_ANALYTICS_GAMES} games; narrow the filters.`)
  }
  if (count != null && (data ?? []).length !== count) {
    throw new Error(`Analytics query returned ${(data ?? []).length} of ${count} games; narrow the filters.`)
  }
  return (data ?? []) as BettingGameRow[]
}

async function loadMatchupTarget(
  client: SupabaseClient,
  filters: AnalyticsFilters,
): Promise<AnalyticsTargetMatchup> {
  const { data, error } = await client
    .from('games')
    .select(targetGameColumns)
    .eq('id', filters.gameId!)
    .eq('season', filters.season)
    .maybeSingle()
  throwQueryError(error)
  if (!data) {
    throw new AnalyticsTargetError(
      'target_game_not_found',
      `Game ${filters.gameId} was not found in season ${filters.season}.`,
    )
  }

  const game = data as TargetGameRow
  const status = game.status_short?.trim().toUpperCase()
  if (
    status !== 'NS'
    || game.game_timestamp == null
    || !Number.isFinite(Number(game.game_timestamp))
    || game.away_team_id == null
    || game.home_team_id == null
  ) {
    throw new AnalyticsTargetError(
      'target_game_ineligible',
      `Game ${filters.gameId} is not an eligible scheduled matchup.`,
    )
  }

  const teamIds = [Number(game.away_team_id), Number(game.home_team_id)]
  const [{ data: teamData, error: teamError }, { data: oddsData, error: oddsError }] = await Promise.all([
    client.from('teams').select('id,name').in('id', teamIds).order('id'),
    client
      .from('game_consensus_odds')
      .select('game_id,home_spread,total')
      .eq('game_id', game.id)
      .maybeSingle(),
  ])
  throwQueryError(teamError)
  throwQueryError(oddsError)
  const teamNames = new Map((teamData ?? []).map((team) => [Number(team.id), String(team.name)]))
  if (!teamNames.has(teamIds[0]) || !teamNames.has(teamIds[1])) {
    throw new AnalyticsTargetError(
      'target_game_ineligible',
      `Game ${filters.gameId} is missing participating team data.`,
    )
  }

  return {
    gameId: Number(game.id),
    season: Number(game.season),
    status: { short: status, long: game.status_long },
    kickoff: {
      date: game.game_date,
      timestamp: Number(game.game_timestamp),
    },
    stage: game.stage,
    week: game.week,
    venue: { name: game.venue_name, city: game.venue_city },
    awayTeam: { id: teamIds[0], name: teamNames.get(teamIds[0])! },
    homeTeam: { id: teamIds[1], name: teamNames.get(teamIds[1])! },
    currentConsensusOdds: {
      homeSpread: oddsData?.home_spread == null ? null : Number(oddsData.home_spread),
      total: oddsData?.total == null ? null : Number(oddsData.total),
    },
  }
}

async function loadMatchupHistory(
  client: SupabaseClient,
  season: number,
  kickoffTimestamp: number,
  teamIds: number[],
) {
  const joinedTeamIds = teamIds.join(',')
  const { data, error, count } = await client
    .from('game_betting_results')
    .select(bettingGameColumns, { count: 'exact' })
    .eq('season', season)
    .lt('game_timestamp', kickoffTimestamp)
    .or(`home_team_id.in.(${joinedTeamIds}),away_team_id.in.(${joinedTeamIds})`)
    .order('game_timestamp', { ascending: false })
    .order('game_id', { ascending: false })
    .limit(MAX_ANALYTICS_GAMES)
  throwQueryError(error)
  if ((count ?? 0) > MAX_ANALYTICS_GAMES) {
    throw new Error(`Analytics selection exceeds ${MAX_ANALYTICS_GAMES} games; narrow the filters.`)
  }
  if (count != null && (data ?? []).length !== count) {
    throw new Error(`Analytics query returned ${(data ?? []).length} of ${count} games; narrow the filters.`)
  }
  return (data ?? []) as BettingGameRow[]
}

async function loadTeamStats(client: SupabaseClient, gameIds: number[], teamIds: number[]) {
  if (!gameIds.length || !teamIds.length) return []
  const rows: AnalyticsTeamStatRow[] = []
  for (let index = 0; index < gameIds.length; index += POSTGREST_IN_FILTER_CHUNK_SIZE) {
    const gameIdChunk = gameIds.slice(index, index + POSTGREST_IN_FILTER_CHUNK_SIZE)
    rows.push(...await fetchAllPages<AnalyticsTeamStatRow>(async (from, to) => {
      const { data, error } = await client
        .from('game_team_stats')
        .select('game_id,team_id,yards_total,pass_yards,rush_yards,turnovers_total,sacks')
        .in('game_id', gameIdChunk)
        .in('team_id', teamIds)
        .order('game_id')
        .order('team_id')
        .range(from, to)
      throwQueryError(error)
      return (data ?? []) as AnalyticsTeamStatRow[]
    }))
  }
  return rows.sort((left, right) => left.game_id - right.game_id || left.team_id - right.team_id)
}

async function loadStandings(client: SupabaseClient, season: number, teamIds: number[]) {
  if (!teamIds.length) return []
  const { data, error } = await client
    .from('standings')
    .select('team_id,conference,division,position,won,lost,ties,points_for,points_against,streak')
    .eq('season', season)
    .in('team_id', teamIds)
    .order('position')
  throwQueryError(error)
  return (data ?? []) as AnalyticsStandingRow[]
}

async function loadInjuries(client: SupabaseClient, teamIds: number[]) {
  if (!teamIds.length) return []
  return fetchAllPages<AnalyticsInjuryRow>(async (from, to) => {
    const { data, error } = await client
      .from('injuries')
      .select('player_id,team_id,injury_date,status,description')
      .in('team_id', teamIds)
      .is('resolved_at', null)
      .order('injury_date', { ascending: false })
      .order('player_id')
      .range(from, to)
    throwQueryError(error)
    return (data ?? []) as AnalyticsInjuryRow[]
  })
}

async function loadPlayerStats(
  client: SupabaseClient,
  preset: AnalyticsPreset,
  filters: AnalyticsFilters,
  gameIds: number[],
  teamIds: number[],
) {
  if (preset === 'season_overview' || !teamIds.length) return []

  if (preset === 'game_review') {
    if (!gameIds.length) return []
    return fetchAllPages<AnalyticsPlayerStatRow>(async (from, to) => {
      const { data, error } = await client
        .from('game_player_stats')
        .select('game_id,team_id,player_id,stat_group,stat_name,stat_value')
        .in('game_id', gameIds)
        .in('team_id', teamIds)
        .in('stat_group', gamePlayerStatGroups)
        .order('game_id')
        .order('team_id')
        .order('player_id')
        .range(from, to)
      throwQueryError(error)
      return (data ?? []).map((row) => ({ ...row, scope: 'game' as const })) as AnalyticsPlayerStatRow[]
    })
  }

  return fetchAllPages<AnalyticsPlayerStatRow>(async (from, to) => {
    const { data, error } = await client
      .from('player_season_stats')
      .select('team_id,player_id,stat_group,stat_name,stat_value')
      .eq('season', filters.season)
      .in('team_id', teamIds)
      .in('stat_group', seasonPlayerStatGroups)
      .order('team_id')
      .order('player_id')
      .range(from, to)
    throwQueryError(error)
    return (data ?? []).map((row) => ({ ...row, scope: 'season' as const })) as AnalyticsPlayerStatRow[]
  })
}

async function loadPlayers(client: SupabaseClient, playerIds: number[]) {
  if (!playerIds.length) return []
  return fetchAllPages<AnalyticsPlayerRow>(async (from, to) => {
    const { data, error } = await client
      .from('players')
      .select('id,name,position')
      .in('id', playerIds)
      .order('id')
      .range(from, to)
    throwQueryError(error)
    return (data ?? []) as AnalyticsPlayerRow[]
  })
}

export function createSupabaseAnalyticsDataSource(client: SupabaseClient): AnalyticsDataSource {
  return {
    async load(filters, preset) {
      const targetMatchup = preset === 'matchup_preview'
        ? await loadMatchupTarget(client, filters)
        : null
      const targetTeamIds = targetMatchup
        ? [targetMatchup.awayTeam.id, targetMatchup.homeTeam.id].sort((left, right) => left - right)
        : null
      const games = targetMatchup
        ? await loadMatchupHistory(client, filters.season, targetMatchup.kickoff.timestamp, targetTeamIds!)
        : await loadGames(client, filters)
      const gameIds = games.map((game) => game.game_id)
      const teamIds = targetTeamIds ?? selectedTeamIds(filters, games)
      const [teamStats, standings, injuries, playerStats] = await Promise.all([
        loadTeamStats(client, gameIds, teamIds),
        loadStandings(client, filters.season, teamIds),
        loadInjuries(client, teamIds),
        loadPlayerStats(client, preset, filters, gameIds, teamIds),
      ])
      const playerIds = [...new Set([
        ...injuries.map((injury) => injury.player_id),
        ...playerStats.map((stat) => stat.player_id),
      ])].sort((left, right) => left - right)
      const players = await loadPlayers(client, playerIds)

      return { games, teamStats, standings, injuries, playerStats, players, targetMatchup }
    },
  }
}

export function createAnalyticsDataSource(config: AnalyticsServiceConfig) {
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('Analytics requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
  }
  return createSupabaseAnalyticsDataSource(createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false },
  }))
}

export async function generateAnalyticsSnapshot(
  dataSource: AnalyticsDataSource,
  preset: AnalyticsPreset,
  filterInput: unknown,
  options: AnalyticsServiceOptions = {},
): Promise<AnalyticsSnapshot> {
  const filters = validateAnalyticsFilters(preset, filterInput)
  const source = await dataSource.load(filters, preset)
  return buildAnalyticsSnapshot(
    preset,
    filters,
    source,
    options.generatedAt?.() ?? new Date().toISOString(),
    options.limits ?? DEFAULT_ANALYTICS_LIMITS,
  )
}
