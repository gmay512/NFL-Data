import type {
  ApiErrorResponse,
  AnalysisSessionListResponse,
  AnalysisSessionResponse,
  AnalysisSessionSummaryResponse,
  AnalyticsFilterMetadata,
  AnalyticsFilters,
  AnalyticsPreset,
  AnalyticsQueryResponse,
  AvailableSeasonsResponse,
  IngestSummary,
  RefreshGameResponse,
  RefreshGameStatsResponse,
  RefreshGameTeamStatsResponse,
  RefreshLiveGamesResponse,
  RefreshSeasonGamesResponse,
  RefreshSeasonScheduleResponse,
  LlmHealthResponse,
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

export function getAnalyticsMetadata(season?: number, options?: { signal?: AbortSignal }) {
  const query = season == null ? '' : `?season=${encodeURIComponent(season)}`
  return requestJson<AnalyticsFilterMetadata>(`/api/analytics/metadata${query}`, options)
}

export function getLlmHealth(options?: { signal?: AbortSignal }) {
  return requestJson<LlmHealthResponse>('/api/analytics/llm-health', options)
}

export function queryAnalytics(preset: AnalyticsPreset, filters: AnalyticsFilters) {
  return postJson<AnalyticsQueryResponse>('/api/analytics/query', { preset, filters })
}

export function runAnalysis(title: string, preset: AnalyticsPreset, filters: AnalyticsFilters) {
  return postJson<AnalysisSessionResponse>('/api/analytics/analyze', { title, preset, filters })
}

export function listAnalysisSessions(options?: { signal?: AbortSignal }) {
  return requestJson<AnalysisSessionListResponse>('/api/analytics/sessions', options)
}

export function getAnalysisSession(id: string, options?: { signal?: AbortSignal }) {
  return requestJson<AnalysisSessionResponse>(`/api/analytics/sessions/${encodeURIComponent(id)}`, options)
}

export function renameAnalysisSession(id: string, title: string) {
  return requestJson<AnalysisSessionSummaryResponse>(`/api/analytics/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

export async function deleteAnalysisSession(id: string) {
  const response = await fetch(`/api/analytics/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) {
    const payload = await response.json() as ApiErrorResponse
    throw new Error(payload.error || `Request failed with status ${response.status}.`)
  }
}

export async function postAnalysisFollowUp(id: string, question: string, signal?: AbortSignal) {
  const response = await fetch(`/api/analytics/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
    signal,
  })
  if (!response.ok) {
    const payload = await response.json() as ApiErrorResponse
    throw new Error(payload.error || `Request failed with status ${response.status}.`)
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Analysis response did not provide an event stream.')
  }
  return response.body
}

export type AnalysisStreamEvent =
  | { type: 'content'; content: string }
  | { type: 'complete'; model: string; finishReason: string | null }
  | { type: 'error'; error: string; code: string }

export async function readAnalysisStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: AnalysisStreamEvent) => void,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim()
      const data = block.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim()
      if (!event || !data) continue
      const payload = JSON.parse(data) as Record<string, unknown>
      if (event === 'content' && typeof payload.content === 'string') {
        onEvent({ type: 'content', content: payload.content })
      } else if (event === 'complete') {
        onEvent({
          type: 'complete',
          model: typeof payload.model === 'string' ? payload.model : '',
          finishReason: typeof payload.finishReason === 'string' ? payload.finishReason : null,
        })
      } else if (event === 'error') {
        onEvent({
          type: 'error',
          error: typeof payload.error === 'string' ? payload.error : 'Analysis stream failed.',
          code: typeof payload.code === 'string' ? payload.code : 'stream_error',
        })
      }
    }
    if (done) break
  }
}
