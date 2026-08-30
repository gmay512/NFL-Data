import { supabase } from '../lib/supabase'
import type {
  GameOddsRow,
  GamePlayerStatRow,
  GameRow,
  GameTeamStatRow,
  LatestGameEventRow,
  LeagueSeasonRow,
  PlayerRow,
  TeamRow,
} from '../types/nfl'
import { selectFirstRowsByKey } from '../lib/game-sync'

let teamsRequest: Promise<TeamRow[]> | null = null

function getClient() {
  if (!supabase) throw new Error('Database connection is not configured.')
  return supabase
}

export function invalidateReferenceData() {
  teamsRequest = null
}

export function getTeams() {
  if (teamsRequest) return teamsRequest

  const request = (async () => {
    const { data, error } = await getClient()
      .from('teams')
      .select('*')
      .order('name', { ascending: true })
    if (error) throw error
    return (data ?? []) as TeamRow[]
  })().catch((error: unknown) => {
    if (teamsRequest === request) {
        teamsRequest = null
    }
    throw error
  })
  teamsRequest = request
  return request
}

export async function getLeagueSeasons() {
  const { data, error } = await getClient()
    .from('league_seasons')
    .select('season_year, is_current')
    .order('season_year', { ascending: false })
  if (error) throw error
  return (data ?? []) as LeagueSeasonRow[]
}

export async function getDashboardMetadata() {
  const [seasons, teams] = await Promise.all([getLeagueSeasons(), getTeams()])
  return { seasons, teams }
}

export async function getSeasonGames(season: number, teamId?: number) {
  let query = getClient()
    .from('games')
    .select('*')
    .eq('season', season)
    .order('game_timestamp', { ascending: true })
  if (teamId != null) {
    query = query.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
  }
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as GameRow[]
}

export async function getGamesByIds(gameIds: number[]) {
  if (!gameIds.length) return []
  const { data, error } = await getClient().from('games').select('*').in('id', gameIds)
  if (error) throw error
  return (data ?? []) as GameRow[]
}

export async function getLatestGameEvents(gameIds: number[]) {
  if (!gameIds.length) return []
  const { data, error } = await getClient()
    .from('game_events')
    .select('game_id, team_id, player_id, quarter, minute, event_type, comment, score_home, score_away')
    .in('game_id', gameIds)
    .order('id', { ascending: false })
  if (error) throw error
  return selectFirstRowsByKey((data ?? []) as LatestGameEventRow[], 'game_id')
}

export async function getGameOdds(gameIds: number[]) {
  if (!gameIds.length) return []
  const { data, error } = await getClient()
    .from('game_consensus_odds')
    .select('game_id, home_spread, total')
    .in('game_id', gameIds)
  if (error) throw error
  return (data ?? []) as GameOddsRow[]
}

export async function getGame(gameId: number) {
  const { data, error } = await getClient().from('games').select('*').eq('id', gameId).maybeSingle()
  if (error) throw error
  return (data ?? null) as GameRow | null
}

export async function getGameTeamStats(gameId: number, teamId?: number) {
  let query = getClient().from('game_team_stats').select('*').eq('game_id', gameId)
  if (teamId != null) query = query.eq('team_id', teamId)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as GameTeamStatRow[]
}

export async function getTeamStatsForGames(teamId: number, gameIds: number[]) {
  if (!gameIds.length) return []
  const { data, error } = await getClient()
    .from('game_team_stats')
    .select('*')
    .eq('team_id', teamId)
    .in('game_id', gameIds)
  if (error) throw error
  return (data ?? []) as GameTeamStatRow[]
}

export async function getGamePlayerStats(gameId: number, teamId: number) {
  const { data, error } = await getClient()
    .from('game_player_stats')
    .select('*')
    .eq('game_id', gameId)
    .eq('team_id', teamId)
  if (error) throw error
  return (data ?? []) as GamePlayerStatRow[]
}

export async function getPlayersByIds(playerIds: number[]) {
  if (!playerIds.length) return []
  const { data, error } = await getClient()
    .from('players')
    .select('id, name, image_url, position_group, position, created_at')
    .in('id', playerIds)
  if (error) throw error
  return (data ?? []) as PlayerRow[]
}

export async function getGameOverview(gameId: number) {
  const [game, teams, teamStats, odds] = await Promise.all([
    getGame(gameId),
    getTeams(),
    getGameTeamStats(gameId),
    getGameOdds([gameId]),
  ])
  return { game, teams, teamStats, odds: odds[0] ?? null }
}

export async function getTeamGameOverview(gameId: number, teamId: number) {
  const [game, teams, teamStats, playerStats] = await Promise.all([
    getGame(gameId),
    getTeams(),
    getGameTeamStats(gameId, teamId),
    getGamePlayerStats(gameId, teamId),
  ])
  return { game, teams, teamStats: teamStats[0] ?? null, playerStats }
}
