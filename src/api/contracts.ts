import type { GameTeamStatRow } from '../types/nfl'
import type {
  AnalyticsFilters,
  AnalyticsPreset,
  AnalyticsSnapshot,
} from '../../server/analytics-core'
import type {
  AnalysisSession,
  AnalysisSessionSummary,
} from '../../server/analysis-store'

export type ApiErrorResponse = {
  error: string
  code?: string
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

export type {
  AnalysisSession,
  AnalysisSessionSummary,
  AnalyticsFilters,
  AnalyticsPreset,
  AnalyticsSnapshot,
}

export type AnalyticsFilterMetadata = {
  seasons: number[]
  teams: Array<{ id: number; name: string }>
  selectedSeason: number | null
  stages: string[]
  weeks: string[]
}

export type AnalyticsQueryResponse = {
  snapshot: AnalyticsSnapshot
}

export type AnalysisSessionResponse = {
  session: AnalysisSession
}

export type AnalysisSessionSummaryResponse = {
  session: AnalysisSessionSummary
}

export type AnalysisSessionListResponse = {
  sessions: AnalysisSessionSummary[]
}

export type LlmHealthResponse =
  | { status: 'available'; model: string; models: string[] }
  | { status: 'unavailable'; code: string; message: string }
