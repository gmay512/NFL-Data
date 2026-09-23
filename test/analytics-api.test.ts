import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { handleApiRequest } from '../server/api-handler'
import { buildAnalyticsSnapshot, type AnalyticsSourceData } from '../server/analytics-core'
import {
  loadAnalyticsMetadata,
  type AnalyticsApiDependencies,
} from '../server/analytics-api'
import { LlamaClient } from '../server/llama-client'
import type {
  AnalysisSession,
  AnalysisSessionSummary,
  AnalysisStore,
} from '../server/analysis-store'

const servers: Array<ReturnType<typeof createServer>> = []
const sessionId = '99000000-0000-4000-8000-000000000001'
const emptySource: AnalyticsSourceData = {
  games: [],
  teamStats: [],
  standings: [],
  injuries: [],
  playerStats: [],
  players: [],
}
const context = buildAnalyticsSnapshot(
  'season_overview',
  { season: 2025 },
  emptySource,
  '2025-10-01T00:00:00.000Z',
)

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

async function request(
  path: string,
  dependencies: AnalyticsApiDependencies,
  method = 'GET',
  body?: unknown,
) {
  const baseUrl = await startServer(async (incoming, response) => {
    if (!(await handleApiRequest(incoming, response, {}, dependencies))) response.writeHead(404).end()
  })
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function createMemoryStore() {
  let session: AnalysisSession | null = null
  let appended = 0

  const store: AnalysisStore = {
    async list() {
      return session ? [session satisfies AnalysisSessionSummary] : []
    },
    async get(id) {
      return session?.id === id ? session : null
    },
    async saveInitial(input) {
      session = {
        id: sessionId,
        title: input.title,
        preset: input.preset,
        filters: input.filters,
        context: input.context,
        model: input.model,
        createdAt: '2025-10-01T00:00:00.000Z',
        updatedAt: '2025-10-01T00:00:00.000Z',
        messages: [
          {
            id: 1,
            role: 'user',
            content: input.prompt,
            inputTokens: null,
            outputTokens: null,
            latencyMs: null,
            createdAt: '2025-10-01T00:00:00.000Z',
          },
          {
            id: 2,
            role: 'assistant',
            content: input.completion.content,
            inputTokens: input.completion.usage?.promptTokens ?? null,
            outputTokens: input.completion.usage?.completionTokens ?? null,
            latencyMs: input.completion.latencyMs,
            createdAt: '2025-10-01T00:00:01.000Z',
          },
        ],
      }
      return session
    },
    async appendExchange(_id, question, completion) {
      appended += 1
      session?.messages.push(
        {
          id: 3,
          role: 'user',
          content: question,
          inputTokens: null,
          outputTokens: null,
          latencyMs: null,
          createdAt: '2025-10-01T00:00:02.000Z',
        },
        {
          id: 4,
          role: 'assistant',
          content: completion.content,
          inputTokens: completion.usage?.promptTokens ?? null,
          outputTokens: completion.usage?.completionTokens ?? null,
          latencyMs: completion.latencyMs,
          createdAt: '2025-10-01T00:00:03.000Z',
        },
      )
    },
    async rename(id, title) {
      if (!session || session.id !== id) return null
      session.title = title
      return session
    },
    async delete(id) {
      if (!session || session.id !== id) return false
      session = null
      return true
    },
  }
  return { store, getSession: () => session, getAppendCount: () => appended }
}

function dependencies(llama: LlamaClient, store: AnalysisStore): AnalyticsApiDependencies {
  return {
    dataSource: { async load() { return emptySource } },
    llama,
    store,
    async loadMetadata(season) {
      return {
        seasons: [2025, 2024],
        teams: [{ id: 1, name: 'Arizona' }],
        selectedSeason: season ?? 2025,
        stages: ['Regular Season'],
        weeks: ['Week 1'],
      }
    },
  }
}

function llama(baseUrl: string) {
  return new LlamaClient({
    baseUrl,
    model: 'test-model',
    timeoutMs: 1_000,
    maxContextChars: 20_000,
    maxOutputTokens: 512,
    maxHistoryMessages: 12,
    maxHistoryChars: 10_000,
  })
}

describe('analytics API contracts', () => {
  it('loads completed-game filter metadata without querying betting views', async () => {
    const tables: string[] = []
    const operations: Array<{ table: string; method: string; args: unknown[] }> = []
    const rows: Record<string, unknown[]> = {
      league_seasons: [{ season_year: 2025 }, { season_year: 2024 }],
      teams: [{ id: 1, name: 'Arizona' }],
      games: [
        { stage: 'Regular Season', week: 'Week 2' },
        { stage: 'Regular Season', week: 'Week 1' },
      ],
    }
    class Query implements PromiseLike<{ data: unknown[]; error: null }> {
      constructor(private readonly table: string) {
        tables.push(table)
      }
      private add(method: string, args: unknown[]) {
        operations.push({ table: this.table, method, args })
        return this
      }
      select(...args: unknown[]) { return this.add('select', args) }
      order(...args: unknown[]) { return this.add('order', args) }
      eq(...args: unknown[]) { return this.add('eq', args) }
      in(...args: unknown[]) { return this.add('in', args) }
      not(...args: unknown[]) { return this.add('not', args) }
      limit(...args: unknown[]) { return this.add('limit', args) }
      then<TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
        onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve({ data: rows[this.table] ?? [], error: null }).then(onfulfilled, onrejected)
      }
    }
    const client = {
      from(table: string) {
        return new Query(table)
      },
    } as unknown as SupabaseClient

    const metadata = await loadAnalyticsMetadata(client, 2025)

    assert.deepEqual(metadata.stages, ['Regular Season'])
    assert.deepEqual(metadata.weeks, ['Week 1', 'Week 2'])
    assert.equal(tables.includes('game_betting_results'), false)
    assert.deepEqual(
      operations.find(({ table, method }) => table === 'games' && method === 'in')?.args,
      ['status_short', ['FT', 'AOT']],
    )
    assert.equal(
      operations.filter(({ table, method }) => table === 'games' && method === 'not').length,
      2,
    )
  })

  it('serves metadata and deterministic analytics without API-Sports configuration', async () => {
    const memory = createMemoryStore()
    const deps = dependencies(llama('http://127.0.0.1:1'), memory.store)

    const metadataResponse = await request('/api/analytics/metadata?season=2024', deps)
    assert.equal(metadataResponse.status, 200)
    assert.equal((await metadataResponse.json() as { selectedSeason: number }).selectedSeason, 2024)

    const queryResponse = await request('/api/analytics/query', deps, 'POST', {
      preset: 'season_overview',
      filters: { season: 2025 },
    })

    assert.equal(queryResponse.status, 200)
    const queryPayload = await queryResponse.json() as { snapshot: { summary: { games: number } } }
    assert.equal(queryPayload.snapshot.summary.games, 0)

    const invalidResponse = await request('/api/analytics/query', deps, 'POST', {
      preset: 'invalid',
      filters: { season: 2025 },
    })
    assert.equal(invalidResponse.status, 400)
    assert.equal((await invalidResponse.json() as { code: string }).code, 'invalid_preset')
  })

  it('serves weekly analysis, history, grading, and season validation', async () => {
    const memory = createMemoryStore()
    const deps = dependencies(llama('http://127.0.0.1:1'), memory.store)
    let analyzedSeason: number | null = null
    const run = {
      id: '99000000-0000-4000-8000-000000000099',
      season: 2025,
      stage: 'Regular Season',
      week: 'Week 2',
      model: 'test-model',
      context: {
        schemaVersion: 2 as const,
        generatedAt: '2025-09-10T00:00:00.000Z',
        season: 2025,
        stage: 'Regular Season',
        week: 'Week 2',
        matchups: [],
      },
      summary: 'No supported picks.',
      createdAt: '2025-09-10T00:00:00.000Z',
      suggestions: [],
    }
    let runExists = true
    deps.weekly = {
      async analyze(season, options) {
        analyzedSeason = season
        options?.onProgress?.({ stage: 'running_model', message: 'Running model.' })
        return run
      },
      async list() {
        return runExists ? [run] : []
      },
      async delete(id) {
        if (!runExists || id !== run.id) return false
        runExists = false
        return true
      },
      async grade() {
        return { graded: 2 }
      },
    }

    const listResponse = await request('/api/analytics/weekly/runs', deps)
    assert.equal(listResponse.status, 200)
    assert.equal((await listResponse.json() as { runs: unknown[] }).runs.length, 1)

    const analyzeResponse = await request('/api/analytics/weekly/analyze', deps, 'POST', { season: 2025 })
    assert.equal(analyzeResponse.status, 201)
    assert.equal(analyzedSeason, 2025)

    const streamResponse = await request('/api/analytics/weekly/analyze-stream', deps, 'POST', { season: 2025 })
    assert.equal(streamResponse.status, 200)
    assert.match(streamResponse.headers.get('content-type') ?? '', /text\/event-stream/)
    const streamBody = await streamResponse.text()
    assert.match(streamBody, /event: progress/)
    assert.match(streamBody, /Running model\./)
    assert.match(streamBody, /event: complete/)
    assert.match(streamBody, new RegExp(run.id))

    const gradeResponse = await request('/api/analytics/weekly/grade', deps, 'POST')
    assert.deepEqual(await gradeResponse.json(), { graded: 2 })

    const deleteResponse = await request(`/api/analytics/weekly/runs/${run.id}`, deps, 'DELETE')
    assert.equal(deleteResponse.status, 204)
    const missingResponse = await request(`/api/analytics/weekly/runs/${run.id}`, deps, 'DELETE')
    assert.equal(missingResponse.status, 404)
    assert.equal((await missingResponse.json() as { code: string }).code, 'weekly_run_not_found')

    const invalidResponse = await request('/api/analytics/weekly/analyze', deps, 'POST', { season: 'invalid' })
    assert.equal(invalidResponse.status, 400)
    assert.equal((await invalidResponse.json() as { code: string }).code, 'invalid_season')
  })

  it('creates, lists, loads, renames, and deletes completed analysis sessions', async () => {
    const modelUrl = await startServer(async (incoming, response) => {
      await new Promise<void>((resolve) => {
        incoming.on('data', () => {})
        incoming.on('end', resolve)
      })

      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        model: 'test-model',
        choices: [{ message: { content: 'Grounded overview.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      }))
    })
    const memory = createMemoryStore()
    const deps = dependencies(llama(modelUrl), memory.store)

    const createResponse = await request('/api/analytics/analyze', deps, 'POST', {
      title: 'Season report',
      preset: 'season_overview',
      filters: { season: 2025 },
    })
    assert.equal(createResponse.status, 201)
    assert.equal(memory.getSession()?.messages.length, 2)

    assert.equal((await request('/api/analytics/sessions', deps)).status, 200)
    assert.equal((await request(`/api/analytics/sessions/${sessionId}`, deps)).status, 200)

    const renameResponse = await request(`/api/analytics/sessions/${sessionId}`, deps, 'PATCH', {
      title: 'Renamed report',
    })
    assert.equal(renameResponse.status, 200)
    assert.equal(memory.getSession()?.title, 'Renamed report')

    const deleteResponse = await request(`/api/analytics/sessions/${sessionId}`, deps, 'DELETE')
    assert.equal(deleteResponse.status, 204)
    assert.equal(memory.getSession(), null)
  })

  it('registers matchup previews and persists their preset-specific initial prompt', async () => {
    const modelUrl = await startServer(async (incoming, response) => {
      await new Promise<void>((resolve) => {
        incoming.on('data', () => {})
        incoming.on('end', resolve)
      })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        model: 'test-model',
        choices: [{ message: { content: 'Grounded matchup.' }, finish_reason: 'stop' }],
      }))
    })
    const memory = createMemoryStore()
    const deps = dependencies(llama(modelUrl), memory.store)
    deps.dataSource = {
      async load() {
        return {
          ...emptySource,
          targetMatchup: {
            gameId: 42,
            season: 2025,
            status: { short: 'NS', long: 'Not Started' },
            kickoff: { date: '2025-10-05', timestamp: 1_759_680_000 },
            stage: 'Regular Season',
            week: 'Week 5',
            venue: { name: 'State Farm Stadium', city: 'Glendale' },
            awayTeam: { id: 2, name: 'Buffalo' },
            homeTeam: { id: 1, name: 'Arizona' },
            currentConsensusOdds: { homeSpread: 2.5, total: 47.5 },
          },
        }
      },
    }

    const response = await request('/api/analytics/analyze', deps, 'POST', {
      title: 'Pregame matchup',
      preset: 'matchup_preview',
      filters: { season: 2025, gameId: 42 },
    })

    assert.equal(response.status, 201)
    assert.equal(memory.getSession()?.preset, 'matchup_preview')
    assert.equal(memory.getSession()?.messages[0].content, 'Generate a grounded pregame matchup preview.')
    assert.equal(memory.getSession()?.context.targetMatchup?.gameId, 42)
  })

  it('streams follow-ups and persists only completed exchanges', async () => {
    let endStream = true
    const modelUrl = await startServer(async (incoming, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream: boolean }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        model: 'test-model',
        choices: [{ delta: { content: 'Follow-up answer.' }, finish_reason: 'stop' }],
      })}\n\n`)
      if (body.stream && endStream) response.end('data: [DONE]\n\n')
      else response.end()
    })
    const memory = createMemoryStore()
    await memory.store.saveInitial({
      title: 'Existing',
      preset: 'season_overview',
      filters: { season: 2025 },
      context,
      model: 'test-model',
      prompt: 'Analyze.',
      completion: {
        content: 'Initial.',
        model: 'test-model',
        finishReason: 'stop',
        usage: null,
        latencyMs: 1,
      },
    })
    const deps = dependencies(llama(modelUrl), memory.store)

    const invalid = await request(`/api/analytics/sessions/${sessionId}/messages`, deps, 'POST', {
      question: 'x'.repeat(4_001),
    })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json() as { code: string }).code, 'invalid_question')
    assert.equal(memory.getAppendCount(), 0)

    const completed = await request(`/api/analytics/sessions/${sessionId}/messages`, deps, 'POST', {
      question: 'What stands out?',
    })
    assert.equal(completed.status, 200)
    assert.equal(completed.headers.get('x-accel-buffering'), 'no')
    const completedBody = await completed.text()
    assert.match(completedBody, /event: content/)
    assert.match(completedBody, /event: complete/)
    assert.equal(memory.getAppendCount(), 1)

    endStream = false
    const incomplete = await request(`/api/analytics/sessions/${sessionId}/messages`, deps, 'POST', {
      question: 'Try again.',
    })
    const incompleteBody = await incomplete.text()
    assert.match(incompleteBody, /event: error/)
    assert.doesNotMatch(incompleteBody, /event: complete/)
    assert.equal(memory.getAppendCount(), 1)
  })

  it('reports local model availability as data rather than failing the page', async () => {
    const closedServer = createServer()
    await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve))
    const address = closedServer.address()
    assert(address && typeof address === 'object')
    await new Promise<void>((resolve) => closedServer.close(() => resolve()))
    const memory = createMemoryStore()
    const deps = dependencies(llama(`http://127.0.0.1:${address.port}`), memory.store)

    const response = await request('/api/analytics/llm-health', deps)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      status: 'unavailable',
      code: 'unavailable',
      message: 'Could not connect to the local llama.cpp server.',
    })
  })
})
