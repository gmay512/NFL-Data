import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import { buildAnalyticsSnapshot } from '../server/analytics-core'
import {
  ANALYTICS_GROUNDING_PROMPT,
  buildGroundedMessages,
  getLlamaConfig,
  LlamaClient,
  LlamaClientError,
  type LlamaConfig,
  type LlamaStreamEvent,
} from '../server/llama-client'

const servers: Array<ReturnType<typeof createServer>> = []

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

function config(baseUrl: string, overrides: Partial<LlamaConfig> = {}): LlamaConfig {
  return {
    baseUrl,
    model: 'test-model',
    timeoutMs: 1_000,
    maxContextChars: 20_000,
    maxOutputTokens: 512,
    maxHistoryMessages: 2,
    maxHistoryChars: 100,
    ...overrides,
  }
}

const snapshot = buildAnalyticsSnapshot(
  'season_overview',
  { season: 2025 },
  { games: [], teamStats: [], standings: [], injuries: [], playerStats: [], players: [] },
  '2025-10-01T00:00:00.000Z',
)

async function readJsonBody(request: IncomingMessage) {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  return JSON.parse(body) as Record<string, unknown>
}

function hasLlamaCode(code: LlamaClientError['code']) {
  return (error: unknown) => error instanceof LlamaClientError && error.code === code
}

describe('llama.cpp configuration and grounding', () => {
  it('uses the local service defaults and validates overrides', () => {
    assert.deepEqual(getLlamaConfig({}), {
      baseUrl: 'http://127.0.0.1:8089',
      model: 'qwen3-coder-next',
      timeoutMs: 120_000,
      maxContextChars: 240_000,
      maxOutputTokens: 2_048,
      maxHistoryMessages: 12,
      maxHistoryChars: 24_000,
    })
    assert.throws(
      () => getLlamaConfig({ LLM_BASE_URL: 'file:///tmp/model' }),
      hasLlamaCode('configuration'),
    )
    assert.throws(
      () => getLlamaConfig({ LLM_MAX_OUTPUT_TOKENS: '0' }),
      hasLlamaCode('configuration'),
    )
  })

  it('builds a grounded prompt with bounded recent history', () => {
    const messages = buildGroundedMessages(config('http://localhost', {
      maxHistoryMessages: 2,
      maxHistoryChars: 40,
    }), snapshot, {
      history: [
        { role: 'user', content: 'old question that should be omitted' },
        { role: 'assistant', content: 'recent answer' },
        { role: 'user', content: 'recent question' },
      ],
      question: 'What is supported?',
    })

    assert.equal(messages[0].content, ANALYTICS_GROUNDING_PROMPT)
    assert.match(messages[1].content, /"schemaVersion":1/)
    assert.deepEqual(messages.slice(2).map((message) => message.content), [
      'recent answer',
      'recent question',
      'What is supported?',
    ])
  })

  it('rejects prompts over the configured context bound', () => {
    assert.throws(
      () => buildGroundedMessages(config('http://localhost', { maxContextChars: 100 }), snapshot),
      hasLlamaCode('context_too_large'),
    )
  })

  it('selects matchup instructions while retaining the shared grounding prompt', () => {
    const matchup = buildAnalyticsSnapshot(
      'matchup_preview',
      { season: 2025, gameId: 42 },
      {
        games: [],
        teamStats: [],
        standings: [],
        injuries: [],
        playerStats: [],
        players: [],
        targetMatchup: null,
      },
    )
    const messages = buildGroundedMessages(config('http://localhost'), matchup)

    assert.equal(messages[0].content, ANALYTICS_GROUNDING_PROMPT)
    assert.match(messages.at(-1)!.content, /current consensus odds/)
    assert.match(messages.at(-1)!.content, /prior performance/)
    assert.match(messages.at(-1)!.content, /missing data/)
    assert.match(messages.at(-1)!.content, /predictive certainty/)
    assert.match(messages.at(-1)!.content, /advice/)
  })
})

describe('llama.cpp health checks', () => {
  it('confirms the configured model is loaded', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }))
    })

    assert.deepEqual(await new LlamaClient(config(baseUrl)).checkHealth(), {
      status: 'available',
      model: 'test-model',
      models: ['test-model'],
    })
  })

  it('distinguishes model mismatch and malformed metadata', async () => {
    const mismatchUrl = await startServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'different-model' }] }))
    })
    await assert.rejects(
      new LlamaClient(config(mismatchUrl)).checkHealth(),
      hasLlamaCode('model_mismatch'),
    )

    const malformedUrl = await startServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ models: [] }))
    })
    await assert.rejects(
      new LlamaClient(config(malformedUrl)).checkHealth(),
      hasLlamaCode('malformed_response'),
    )
  })

  it('distinguishes unavailable, timeout, and cancelled requests', async () => {
    const closedServer = createServer()
    await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve))
    const address = closedServer.address()
    assert(address && typeof address === 'object')
    await new Promise<void>((resolve) => closedServer.close(() => resolve()))
    await assert.rejects(
      new LlamaClient(config(`http://127.0.0.1:${address.port}`)).checkHealth(),
      hasLlamaCode('unavailable'),
    )

    const timeoutUrl = await startServer(() => {})
    await assert.rejects(
      new LlamaClient(config(timeoutUrl, { timeoutMs: 20 })).checkHealth(),
      hasLlamaCode('timeout'),
    )

    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      new LlamaClient(config(timeoutUrl)).checkHealth(controller.signal),
      hasLlamaCode('cancelled'),
    )
  })
})

describe('llama.cpp grounded completions', () => {
  it('sends the grounded request and parses completion metadata', async () => {
    let body: Record<string, unknown> | null = null
    const baseUrl = await startServer(async (request, response) => {
      body = await readJsonBody(request)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        model: 'test-model',
        choices: [{
          message: { role: 'assistant', content: 'The supplied season has no games.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
      }))
    })

    const result = await new LlamaClient(config(baseUrl)).complete(snapshot)
    assert.equal(result.content, 'The supplied season has no games.')
    assert.equal(result.finishReason, 'stop')
    assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 8, totalTokens: 108 })
    assert.equal(body?.model, 'test-model')
    assert.equal(body?.stream, false)
    assert.equal(body?.max_tokens, 512)
    assert.match(JSON.stringify(body?.messages), /Use only facts/)
  })

  it('rejects malformed completion responses', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ model: 'test-model', choices: [] }))
    })

    await assert.rejects(
      new LlamaClient(config(baseUrl)).complete(snapshot),
      hasLlamaCode('malformed_response'),
    )
  })

  it('streams content and emits completion only after the SSE terminator', async () => {
    const baseUrl = await startServer(async (request, response) => {
      const body = await readJsonBody(request)
      assert.equal(body.stream, true)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        model: 'test-model',
        choices: [{ delta: { content: 'Grounded ' }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        model: 'test-model',
        choices: [{ delta: { content: 'answer.' }, finish_reason: 'stop' }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        model: 'test-model',
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })

    const events: LlamaStreamEvent[] = []
    for await (const event of new LlamaClient(config(baseUrl)).stream(snapshot)) events.push(event)

    assert.deepEqual(events.slice(0, 2), [
      { type: 'content', content: 'Grounded ' },
      { type: 'content', content: 'answer.' },
    ])
    assert.deepEqual(events[2], {
      type: 'complete',
      content: 'Grounded answer.',
      model: 'test-model',
      finishReason: 'stop',
      usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 },
      latencyMs: events[2].type === 'complete' ? events[2].latencyMs : -1,
    })
  })

  it('does not emit completion when a stream ends early', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({
        model: 'test-model',
        choices: [{ delta: { content: 'Partial' }, finish_reason: null }],
      })}\n\n`)
    })

    const events: LlamaStreamEvent[] = []
    await assert.rejects(async () => {
      for await (const event of new LlamaClient(config(baseUrl)).stream(snapshot)) events.push(event)
    }, hasLlamaCode('malformed_response'))
    assert.deepEqual(events, [{ type: 'content', content: 'Partial' }])
  })

  it('cancels an in-progress stream without emitting completion', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        model: 'test-model',
        choices: [{ delta: { content: 'First chunk' }, finish_reason: null }],
      })}\n\n`)
    })
    const controller = new AbortController()
    const events: LlamaStreamEvent[] = []

    await assert.rejects(async () => {
      for await (const event of new LlamaClient(config(baseUrl)).stream(snapshot, {}, controller.signal)) {
        events.push(event)
        controller.abort()
      }
    }, hasLlamaCode('cancelled'))

    assert.deepEqual(events, [{ type: 'content', content: 'First chunk' }])
  })
})
