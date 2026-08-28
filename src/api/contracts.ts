import type { GameTeamStatRow } from '../types/nfl'

export type ApiErrorResponse = {
  error: string
}

export type HealthResponse = {
  status: 'ok'
}

export type AvailableSeason = {
  season: number
  current: boolean
  startDate: string | null
  endDate: string | null
}

export type AvailableSeasonsResponse = {
  seasons: AvailableSeason[]
}

export type IngestSummary = {
  season: number
  leagues: number
  leagueSeasons: number
  teams: number
  players: number
  games: number
  gameEvents: number
  injuries: number
  playerSeasonStats: number
  standings: number
  gameTeamStats: number
  gamePlayerStats: number
  bookmakers: number
  betTypes: number
  odds: number
}

export type RefreshSeasonScheduleResponse = {
  season: number
  teams: number
  games: number
}

export type RefreshSeasonGamesResponse = {
  season: number
  games: number
}

export type RefreshGameResponse = {
  gameId: number
}

export type RefreshGameTeamStatsResponse = {
  gameId: number
  rowsUpserted: number
  rows: Array<Omit<GameTeamStatRow, 'created_at' | 'id'>>
}

export type RefreshGameStatsResponse = {
  gameId: number
  teamStatsRowsUpserted: number
  playerStatsRowsUpserted: number
}

export type RefreshLiveGamesResponse = {
  gameIds: number[]
}
