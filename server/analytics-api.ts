import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readJsonBody, sendJson } from './api/request'
import { getRequiredEnv, type AppEnv } from './config'
import {
  AnalyticsValidationError,
  type AnalyticsPreset,
} from './analytics-core'
import {
  createAnalyticsDataSource,
  generateAnalyticsSnapshot,
  AnalyticsTargetError,
  type AnalyticsDataSource,
} from './analytics-service'
import {
  createLlamaClient,
  LlamaClientError,
  type LlamaClient,
} from './llama-client'
import {
  createAnalysisStore,
  type AnalysisSession,
  type AnalysisStore,
} from './analysis-store'

export type AnalyticsFilterMetadata = {
  seasons: number[]
  teams: Array<{ id: number; name: string }>
  selectedSeason: number | null
  stages: string[]
  weeks: string[]
}

export type AnalyticsApiDependencies = {
  dataSource: AnalyticsDataSource
  llama: LlamaClient
  store: AnalysisStore
  loadMetadata: (season?: number) => Promise<AnalyticsFilterMetadata>
}

export class AnalyticsApiError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'AnalyticsApiError'
    this.code = code
    this.statusCode = statusCode
  }
}

const presets = new Set<AnalyticsPreset>([
  'season_overview',
  'team_analysis',
  'game_review',
  'matchup_preview',
  'trend_comparison',
])
const sessionPathPattern = /^\/api\/analytics\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const messagePathPattern = /^\/api\/analytics\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/messages$/i
const presetPrompts: Record<AnalyticsPreset, string> = {
  season_overview: 'Generate a grounded season overview.',
  team_analysis: 'Generate a grounded team analysis.',
  game_review: 'Generate a grounded completed-game review.',
  matchup_preview: 'Generate a grounded pregame matchup preview.',
  trend_comparison: 'Generate a grounded trend comparison.',
}

const dependencyCache = new WeakMap<object, AnalyticsApiDependencies>()

function parsePreset(value: unknown): AnalyticsPreset {
  if (typeof value !== 'string' || !presets.has(value as AnalyticsPreset)) {
    throw new AnalyticsApiError(400, 'invalid_preset', 'A supported analytics preset is required.')
  }
  return value as AnalyticsPreset
}

function parseTitle(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) {
    throw new AnalyticsApiError(400, 'invalid_title', 'title must contain 1 to 160 characters.')
  }
  return value.trim()
}

function parseQuestion(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4_000) {
    throw new AnalyticsApiError(400, 'invalid_question', 'question must contain 1 to 4,000 characters.')
  }
  return value.trim()
}

function parseSeason(value: string | null) {
  if (value == null || value === '') return undefined
  const season = Number(value)
  if (!Number.isInteger(season) || season < 1900 || season > 2100) {
    throw new AnalyticsApiError(400, 'invalid_season', 'season must be an integer from 1900 through 2100.')
  }
  return season
}

function llamaStatus(error: LlamaClientError) {
  if (error.code === 'timeout') return 504
  if (error.code === 'malformed_response' || error.code === 'http_error') return 502
  if (error.code === 'context_too_large' || error.code === 'configuration') return 400
  if (error.code === 'cancelled') return 499
  return 503
}

export function statusForApiError(error: unknown) {
  if (error instanceof AnalyticsApiError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message }
  }
  if (error instanceof AnalyticsValidationError) {
    return { statusCode: 400, code: 'invalid_filters', message: error.message }
  }
  if (error instanceof AnalyticsTargetError) {
    return {
      statusCode: error.code === 'target_game_not_found' ? 404 : 409,
      code: error.code,
      message: error.message,
    }
  }
  if (error instanceof LlamaClientError) {
    return { statusCode: llamaStatus(error), code: error.code, message: error.message }
  }
  return null
}

async function loadMetadata(client: SupabaseClient, requestedSeason?: number): Promise<AnalyticsFilterMetadata> {
  const [{ data: seasonData, error: seasonError }, { data: teamData, error: teamError }] = await Promise.all([
    client.from('league_seasons').select('season_year').order('season_year', { ascending: false }),
    client.from('teams').select('id,name').order('name'),
  ])
  if (seasonError) throw new Error(seasonError.message)
  if (teamError) throw new Error(teamError.message)

  const seasons = [...new Set((seasonData ?? []).map((row) => Number(row.season_year)))]
    .filter(Number.isInteger)
    .sort((left, right) => right - left)
  const selectedSeason = requestedSeason ?? seasons[0] ?? null
  let stages: string[] = []
  let weeks: string[] = []

  if (selectedSeason != null) {
    const { data, error } = await client
      .from('game_betting_results')
      .select('stage,week')
      .eq('season', selectedSeason)
      .order('game_timestamp')
      .limit(1_000)
    if (error) throw new Error(error.message)
    stages = [...new Set((data ?? []).map((row) => row.stage).filter((value): value is string => Boolean(value)))].sort()
    weeks = [...new Set((data ?? []).map((row) => row.week).filter((value): value is string => Boolean(value)))].sort()
  }

  return {
    seasons,
    teams: (teamData ?? []).map((row) => ({ id: Number(row.id), name: String(row.name) })),
    selectedSeason,
    stages,
    weeks,
  }
}

function createDependencies(env: AppEnv) {
  const supabaseUrl = getRequiredEnv(env, 'SUPABASE_URL', 'VITE_SUPABASE_URL')
  const serviceRoleKey = getRequiredEnv(env, 'SUPABASE_SERVICE_ROLE_KEY')
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  return {
    dataSource: createAnalyticsDataSource({ supabaseUrl, serviceRoleKey }),
    llama: createLlamaClient(env),
    store: createAnalysisStore(client),
    loadMetadata: (season?: number) => loadMetadata(client, season),
  } satisfies AnalyticsApiDependencies
}

function getDependencies(env: AppEnv, injected?: AnalyticsApiDependencies) {
  if (injected) return injected
  const cached = dependencyCache.get(env)
  if (cached) return cached
  const dependencies = createDependencies(env)
  dependencyCache.set(env, dependencies)
  return dependencies
}

function writeSse(response: ServerResponse, event: string, payload: unknown) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

async function streamFollowUp(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: AnalyticsApiDependencies,
  session: AnalysisSession,
  question: string,
) {
  const controller = new AbortController()
  const abort = () => {
    if (!response.writableEnded) controller.abort()
  }
  request.once('aborted', abort)
  response.once('close', abort)
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  try {
    for await (const event of dependencies.llama.stream(session.context, {
      history: session.messages.map((message) => ({ role: message.role, content: message.content })),
      question,
    }, controller.signal)) {
      if (event.type === 'content') {
        writeSse(response, 'content', { content: event.content })
        continue
      }
      if (controller.signal.aborted) return
      await dependencies.store.appendExchange(session.id, question, event)
      writeSse(response, 'complete', {
        model: event.model,
        finishReason: event.finishReason,
        usage: event.usage,
        latencyMs: event.latencyMs,
      })
    }
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return
    const mapped = statusForApiError(error)
    writeSse(response, 'error', {
      error: mapped?.message ?? (error instanceof Error ? error.message : String(error)),
      code: mapped?.code ?? 'internal_error',
    })
  } finally {
    request.removeListener('aborted', abort)
    response.removeListener('close', abort)
    if (!response.writableEnded && !response.destroyed) response.end()
  }
}

export async function handleAnalyticsApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  env: AppEnv,
  injected?: AnalyticsApiDependencies,
) {
  if (!requestUrl.pathname.startsWith('/api/analytics')) return false
  const dependencies = getDependencies(env, injected)

  if (request.method === 'GET' && requestUrl.pathname === '/api/analytics/metadata') {
    sendJson(response, 200, await dependencies.loadMetadata(parseSeason(requestUrl.searchParams.get('season'))))
    return true
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/analytics/llm-health') {
    try {
      sendJson(response, 200, await dependencies.llama.checkHealth())
    } catch (error) {
      const mapped = statusForApiError(error)
      sendJson(response, 200, {
        status: 'unavailable',
        code: mapped?.code ?? 'internal_error',
        message: mapped?.message ?? (error instanceof Error ? error.message : String(error)),
      })
    }
    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/analytics/query') {
    const body = await readJsonBody(request)
    const snapshot = await generateAnalyticsSnapshot(
      dependencies.dataSource,
      parsePreset(body.preset),
      body.filters,
    )
    sendJson(response, 200, { snapshot })
    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/analytics/analyze') {
    const body = await readJsonBody(request)
    const preset = parsePreset(body.preset)
    const title = parseTitle(body.title)
    const snapshot = await generateAnalyticsSnapshot(dependencies.dataSource, preset, body.filters)
    const completion = await dependencies.llama.complete(snapshot)
    const session = await dependencies.store.saveInitial({
      title,
      preset,
      filters: snapshot.filters,
      context: snapshot,
      model: completion.model,
      prompt: presetPrompts[preset],
      completion,
    })
    sendJson(response, 201, { session })
    return true
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/analytics/sessions') {
    sendJson(response, 200, { sessions: await dependencies.store.list() })
    return true
  }

  const sessionMatch = requestUrl.pathname.match(sessionPathPattern)
  if (sessionMatch && request.method === 'GET') {
    const session = await dependencies.store.get(sessionMatch[1])
    if (!session) throw new AnalyticsApiError(404, 'session_not_found', 'Analysis session was not found.')
    sendJson(response, 200, { session })
    return true
  }
  if (sessionMatch && request.method === 'PATCH') {
    const body = await readJsonBody(request)
    const session = await dependencies.store.rename(sessionMatch[1], parseTitle(body.title))
    if (!session) throw new AnalyticsApiError(404, 'session_not_found', 'Analysis session was not found.')
    sendJson(response, 200, { session })
    return true
  }
  if (sessionMatch && request.method === 'DELETE') {
    if (!await dependencies.store.delete(sessionMatch[1])) {
      throw new AnalyticsApiError(404, 'session_not_found', 'Analysis session was not found.')
    }
    response.writeHead(204).end()
    return true
  }

  const messageMatch = requestUrl.pathname.match(messagePathPattern)
  if (messageMatch && request.method === 'POST') {
    const body = await readJsonBody(request, 16_000)
    const question = parseQuestion(body.question)
    const session = await dependencies.store.get(messageMatch[1])
    if (!session) throw new AnalyticsApiError(404, 'session_not_found', 'Analysis session was not found.')
    await streamFollowUp(request, response, dependencies, session, question)
    return true
  }

  throw new AnalyticsApiError(404, 'route_not_found', 'Analytics API route not found.')
}
