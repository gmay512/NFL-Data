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
  RefreshSeasonOddsResponse,
  RefreshSeasonScheduleResponse,
  LlmHealthResponse,
  WeeklyAnalysisRunResponse,
  WeeklyAnalysisRunsResponse,
  WeeklyLossAnalysisResponse,
  WeeklyGradeResponse,
  WeeklyRunView,
  AnalyticsOverviewResponse,
  WeeklyRunSummaries,
  WeeklyRunViewResponse,
  AnalysisSessionPage,
} from './contracts'
import { analyticsKey, invalidateAnalyticsReads } from '../data/analytics-repository'

export class AppApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'AppApiError'
    this.code = code
    this.status = status
  }
}
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    if (init?.signal?.aborted) {
      const timeout = init.signal.reason instanceof DOMException && init.signal.reason.name === 'TimeoutError'
      throw new AppApiError(timeout ? 'The read timed out. Please retry.' : 'The request was cancelled.',
        timeout ? 'read_timeout' : 'cancelled', timeout ? 504 : 499)
    }
    throw new AppApiError(`Could not reach the application server: ${error instanceof Error ? error.message : String(error)}`,
      'network_unavailable', 503)
  }
  const payload = await response.json().catch(() => null) as T | ApiErrorResponse | null
  if (!response.ok) {
    throw new AppApiError(
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String(payload.error)
        : `Request failed with status ${response.status}.`,
      typeof payload === 'object' && payload !== null && 'code' in payload ? String(payload.code) : 'request_failed',
      response.status,
    )
  }
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppApiError(`Request to ${path} returned an invalid JSON response.`, 'malformed_response', 502)
  }
  return payload as T
}

async function postJson<T>(path: string, body?: unknown, options?: { signal?: AbortSignal }) {
  const result = await requestJson<T>(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options?.signal,
  })
  if (!['/api/analytics/query', '/api/analytics/overview'].includes(path)) {
    const prefix = path === '/api/analytics/analyze' ? 'sessions'
      : path.endsWith('/analyze-loss') ? 'weekly-detail'
        : path === '/api/analytics/weekly/analyze' ? 'weekly' : ''
    invalidateAnalyticsReads(prefix, { preserveData: true })
  }
  return result
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function validateRead<T>(payload: T, valid: boolean): T {
  if (!valid) throw new AppApiError('Analytics returned a malformed read response.', 'malformed_response', 502)
  return payload
}

function isWeeklyRunView(value: unknown): value is WeeklyRunView {
  return isObject(value) && typeof value.id === 'string' && Number.isInteger(value.season)
    && typeof value.week === 'string' && typeof value.model === 'string'
    && typeof value.summary === 'string' && typeof value.createdAt === 'string'
    && Array.isArray(value.suggestions) && value.suggestions.every((pick) => isObject(pick)
      && Number.isInteger(pick.id) && typeof pick.result === 'string'
      && (pick.lossAnalysis == null || (isObject(pick.lossAnalysis)
        && Array.isArray(pick.lossAnalysis.clues) && Array.isArray(pick.lossAnalysis.missingMetrics)
        && isObject(pick.lossAnalysis.evidence) && isObject(pick.lossAnalysis.evidence.metrics))))
}

function readOptions(options?: { signal?: AbortSignal }, timeout = 15_000) {
  const deadline = AbortSignal.timeout(timeout)
  return { signal: options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline }
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

export function refreshSeasonOdds(season: number, options?: { signal?: AbortSignal }) {
  return postJson<RefreshSeasonOddsResponse>('/api/refresh-season-odds', { season }, options)
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
  return requestJson<AnalyticsFilterMetadata>(`/api/analytics/metadata${query}`, readOptions(options))
}

export function getLlmHealth(options?: { signal?: AbortSignal }) {
  return requestJson<LlmHealthResponse>('/api/analytics/llm-health', readOptions(options, 5_000))
}

export function queryAnalytics(preset: AnalyticsPreset, filters: AnalyticsFilters, options?: { signal?: AbortSignal }) {
  return postJson<AnalyticsQueryResponse>('/api/analytics/query', { preset, filters }, readOptions(options))
}

export async function queryAnalyticsOverview(preset: AnalyticsPreset, filters: AnalyticsFilters, options?: { signal?: AbortSignal }) {
  const payload = await postJson<AnalyticsOverviewResponse>('/api/analytics/overview', { preset, filters }, readOptions(options))
  const snapshot = payload.snapshot
  return validateRead(payload, Boolean(snapshot && isObject(snapshot.summary)
    && Number.isInteger(snapshot.summary.games) && isObject(snapshot.games) && Array.isArray(snapshot.games.items)
    && isObject(snapshot.teamTrends) && Array.isArray(snapshot.teamTrends.items) && isObject(snapshot.dataQuality)))
}

export function runAnalysis(title: string, preset: AnalyticsPreset, filters: AnalyticsFilters, options?: { signal?: AbortSignal }) {
  return postJson<AnalysisSessionResponse>('/api/analytics/analyze', { title, preset, filters }, options)
}

export async function listWeeklySummaries(
  values: { season?: number; week?: string; before?: { createdAt: string; id: string } } = {},
  options?: { signal?: AbortSignal },
) {
  const query = new URLSearchParams()
  if (values.season) query.set('season', String(values.season))
  if (values.week) query.set('week', values.week)
  if (values.before) query.set('before', JSON.stringify(values.before))
  const payload = await requestJson<WeeklyRunSummaries>(`/api/analytics/weekly/summaries?${query}`, readOptions(options))
  return validateRead(payload, Array.isArray(payload.runs) && Array.isArray(payload.weeks)
    && payload.weeks.every((week) => typeof week === 'string') && isObject(payload.record)
    && Number.isInteger(payload.total) && payload.runs.every((run) => isObject(run)
      && typeof run.id === 'string' && typeof run.week === 'string' && typeof run.isFinal === 'boolean'
      && Number.isInteger(run.picks) && isObject(run.record)))
}

export async function getWeeklyRun(id: string, options?: { signal?: AbortSignal }) {
  const payload = await requestJson<WeeklyRunViewResponse>(`/api/analytics/weekly/runs/${encodeURIComponent(id)}`, readOptions(options))
  return validateRead(payload, isWeeklyRunView(payload.run))
}

export function listWeeklyAnalysisRuns(options?: { signal?: AbortSignal }) {
  return requestJson<WeeklyAnalysisRunsResponse>('/api/analytics/weekly/runs', readOptions(options))
}

export async function deleteWeeklyAnalysisRun(id: string) {
  const response = await fetch(`/api/analytics/weekly/runs/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as ApiErrorResponse | null
    throw new Error(payload?.error || `Request failed with status ${response.status}.`)
  }
  invalidateAnalyticsReads('weekly-summary', { preserveData: true })
  invalidateAnalyticsReads(analyticsKey('weekly-detail', { id }))
}

export function runWeeklyAnalysis(season: number) {
  return postJson<WeeklyAnalysisRunResponse>('/api/analytics/weekly/analyze', { season })
}

export async function postWeeklyAnalysisStream(season: number, signal?: AbortSignal) {
  const response = await fetch('/api/analytics/weekly/analyze-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ season }),
    signal,
  })
  if (!response.ok) {
    const payload = await response.json() as ApiErrorResponse
    throw new Error(payload.error || `Request failed with status ${response.status}.`)
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Weekly analysis did not provide an event stream.')
  }
  return response.body
}

export type WeeklyAnalysisStreamEvent =
  | { type: 'progress'; stage: string; message: string }
  | { type: 'complete'; run: WeeklyRunView }
  | { type: 'error'; error: string; code: string }

export async function readWeeklyAnalysisStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: WeeklyAnalysisStreamEvent) => void,
  signal?: AbortSignal,
) {
    for await (const { event, payload } of readSse(stream, signal)) {
      if (event === 'progress') {
        onEvent({
          type: 'progress',
          stage: typeof payload.stage === 'string' ? payload.stage : '',
          message: typeof payload.message === 'string' ? payload.message : 'Analyzing upcoming week…',
        })
      } else if (event === 'complete') {
        if (!isWeeklyRunView(payload.run)) throw new AppApiError('Weekly analysis returned a malformed completion.', 'malformed_response', 502)
        invalidateAnalyticsReads('weekly', { preserveData: true })
        onEvent({ type: 'complete', run: payload.run })
        return
      } else if (event === 'error') {
        onEvent({
          type: 'error',
          error: typeof payload.error === 'string' ? payload.error : 'Weekly analysis failed.',
          code: typeof payload.code === 'string' ? payload.code : 'stream_error',
        })
        return
      }
    }
    throw new Error('Weekly analysis stream ended before completion.')
}

export function gradeWeeklySuggestions() {
  return postJson<WeeklyGradeResponse>('/api/analytics/weekly/grade')
}

export function analyzeWeeklySuggestionLoss(suggestionId: number, options?: { signal?: AbortSignal }) {
  return postJson<WeeklyLossAnalysisResponse>(
    `/api/analytics/weekly/suggestions/${encodeURIComponent(suggestionId)}/analyze-loss`,
    undefined, options,
  )
}

export async function deleteWeeklyLossAnalysis(id: number) {
  const response = await fetch(
    `/api/analytics/weekly/loss-analyses/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as ApiErrorResponse | null
    throw new Error(payload?.error || `Request failed with status ${response.status}.`)
  }
  invalidateAnalyticsReads('weekly-detail', { preserveData: true })
}

export function listAnalysisSessions(options?: { signal?: AbortSignal }) {
  return requestJson<AnalysisSessionListResponse>('/api/analytics/sessions', readOptions(options))
}

export function listAnalysisSessionPage(before?: { updatedAt: string; id: string }, options?: { signal?: AbortSignal }) {
  const query = new URLSearchParams({ paged: 'true' })
  if (before) query.set('before', JSON.stringify(before))
  return requestJson<AnalysisSessionPage>(`/api/analytics/sessions?${query}`, readOptions(options))
}

export function getAnalysisSession(id: string, options?: { signal?: AbortSignal; beforeMessage?: number }) {
  const query = new URLSearchParams({ paged: 'true' })
  if (options?.beforeMessage) query.set('beforeMessage', String(options.beforeMessage))
  return requestJson<AnalysisSessionResponse>(`/api/analytics/sessions/${encodeURIComponent(id)}?${query}`, readOptions(options))
}

export async function renameAnalysisSession(id: string, title: string) {
  const result = await requestJson<AnalysisSessionSummaryResponse>(`/api/analytics/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  invalidateAnalyticsReads('sessions', { preserveData: true })
  return result
}

export async function deleteAnalysisSession(id: string) {
  const response = await fetch(`/api/analytics/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) {
    const payload = await response.json() as ApiErrorResponse
    throw new Error(payload.error || `Request failed with status ${response.status}.`)
  }
  invalidateAnalyticsReads('sessions', { preserveData: true })
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
  signal?: AbortSignal,
) {
  for await (const { event, payload } of readSse(stream, signal)) {
    if (event === 'content' && typeof payload.content === 'string') {
      onEvent({ type: 'content', content: payload.content })
    } else if (event === 'complete' && typeof payload.model === 'string') {
      invalidateAnalyticsReads('sessions', { preserveData: true })
      onEvent({
        type: 'complete', model: payload.model,
        finishReason: typeof payload.finishReason === 'string' ? payload.finishReason : null,
      })
      return
    } else if (event === 'error') {
      onEvent({
        type: 'error',
        error: typeof payload.error === 'string' ? payload.error : 'Analysis stream failed.',
        code: typeof payload.code === 'string' ? payload.code : 'stream_error',
      })
      return
    }
  }
  throw new Error('Analysis stream ended before saving was confirmed.')
}

async function* readSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const abort = () => { void reader.cancel().catch((error: unknown) => console.error('Could not cancel Analytics stream reader.', error)) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > 2_000_000) throw new Error('Analytics stream event exceeded the size limit.')
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      if (done && buffer.trim()) blocks.push(buffer)
      for (const block of blocks) {
        const lines = block.split(/\r?\n/)
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (!event || !data) continue
        const payload: unknown = JSON.parse(data)
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('Analytics stream returned an invalid event.')
        }
        yield { event, payload: payload as Record<string, unknown> }
      }
      if (done) return
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}
