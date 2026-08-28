import type {
  ApiErrorResponse,
  AvailableSeasonsResponse,
  IngestSummary,
  RefreshGameResponse,
  RefreshGameStatsResponse,
  RefreshGameTeamStatsResponse,
  RefreshLiveGamesResponse,
  RefreshSeasonGamesResponse,
  RefreshSeasonScheduleResponse,
} from './contracts'

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const payload = await response.json() as T | ApiErrorResponse
  if (!response.ok) {
    throw new Error(
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String(payload.error)
        : `Request failed with status ${response.status}.`,
    )
  }
  return payload as T
}

function postJson<T>(path: string, body?: unknown) {
  return requestJson<T>(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function getAvailableSeasons(options?: { signal?: AbortSignal }) {
  return requestJson<AvailableSeasonsResponse>('/api/seasons', options)
}

export function ingestSeason(season: number) {
  return postJson<IngestSummary>('/api/ingest-season', { season })
}

export function refreshSeasonSchedule(season: number) {
  return postJson<RefreshSeasonScheduleResponse>('/api/refresh-season-schedule', { season })
}

export function refreshSeasonGames(season: number, gameIds?: number[]) {
  return postJson<RefreshSeasonGamesResponse>('/api/refresh-season-games', { season, gameIds })
}

export function refreshGame(gameId: number) {
  return postJson<RefreshGameResponse>('/api/refresh-game', { gameId })
}

export function refreshGameTeamStats(gameId: number) {
  return postJson<RefreshGameTeamStatsResponse>('/api/refresh-game-team-stats', { gameId })
}

export function refreshGameStats(
  gameId: number,
  teamId: number,
  options: { loadPlayerStats: boolean; loadTeamStats: boolean },
) {
  return postJson<RefreshGameStatsResponse>('/api/refresh-game-stats', { gameId, teamId, ...options })
}

export function refreshLiveGames() {
  return postJson<RefreshLiveGamesResponse>('/api/live-games')
}
