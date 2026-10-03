import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createWeeklyAnalysisStore } from '../server/weekly-analysis-store'
import { AnalyticsReadScope, readAllRows, AnalyticsDatabaseError } from '../server/analytics-reads'
import { analyticsKey } from '../src/data/analytics-repository'
import { AppApiError, getAnalyticsMetadata, readAnalysisStream, readWeeklyAnalysisStream } from '../src/api/app-api'

function stream(text: string) {
  return new Response(text).body!
}

describe('Analytics read coordination', () => {
  it('uses every nested cursor/filter value in stable cache keys', () => {
    assert.equal(analyticsKey('read', { season: 2026, before: { id: 'a', createdAt: 'now' } }),
      analyticsKey('read', { before: { createdAt: 'now', id: 'a' }, season: 2026 }))
    assert.notEqual(analyticsKey('read', { before: { id: 'a' } }), analyticsKey('read', { before: { id: 'b' } }))
    assert.notEqual(analyticsKey('read', { teamId: 1 }), analyticsKey('read', { teamId: 2 }))
  })

  it('deduplicates request-local work and bounds queued concurrency', async () => {
    const scope = new AnalyticsReadScope()
    let requests = 0
    let active = 0
    let maximum = 0
    const load = async () => {
      requests++
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
      return 42
    }
    const shared = scope.read('shared', load)
    assert.equal(shared, scope.read('shared', load))
    await shared
    assert.equal(requests, 1)
    await Promise.all(Array.from({ length: 9 }, () => scope.run(load)))
    assert.equal(maximum, 2)
  })

  it('stops queued database work after cancellation', async () => {
    const controller = new AbortController()
    const scope = new AnalyticsReadScope(controller.signal)
    controller.abort()
    await assert.rejects(scope.run(async () => { throw new Error('Must not execute') }), { name: 'AbortError' })
  })

  it('rejects queued work immediately even while occupied slots have not finished', async () => {
    const controller = new AbortController()
    const scope = new AnalyticsReadScope(controller.signal)
    let finish: (() => void) | undefined
    const held = new Promise<void>((resolve) => { finish = resolve })
    const active = [scope.run(() => held), scope.run(() => held)]
    const queued = scope.run(async () => { throw new Error('Cancelled work must not execute') })
    controller.abort()
    await assert.rejects(queued, { name: 'AbortError' })
    finish?.()
    await Promise.all(active)
  })

  it('cancels remaining request-local work when a required read fails', async () => {
    const scope = new AnalyticsReadScope()
    const failure = new AnalyticsDatabaseError('Results', { code: '57014', message: 'statement timeout' })
    await assert.rejects(scope.read('failed', async () => { throw failure }), (error) => error === failure)
    assert.equal(scope.signal.aborted, true)
    assert.throws(() => scope.read('must-not-start', async () => 42), (error) => error === failure)
  })

  it('reads all related rows past the database page limit and preserves timeout codes', async () => {
    const data = Array.from({ length: 2_501 }, (_, id) => ({ id }))
    const rows = await readAllRows((from, to) => Promise.resolve({
      data: data.slice(from, to + 1), error: null,
    }), 'Related data')
    assert.equal(rows.length, data.length)
    await assert.rejects(readAllRows(() => Promise.resolve({
      data: null, error: { code: '57014', message: 'statement timeout' },
    }), 'Results'), (error) => error instanceof AnalyticsDatabaseError && error.code === 'database_timeout')
  })
})

describe('Analytics read contracts', () => {
  it('projects selected weekly loss evidence to metrics without transferring grounding', async () => {
    const id = '99000000-0000-4000-8000-000000000001'
    const selects: string[] = []
    const client = createClient('http://database.test', 'test-key', {
      global: { fetch: async (input) => {
        const url = new URL(String(input))
        const table = url.pathname.split('/').at(-1)
        const columns = url.searchParams.get('select') ?? ''
        selects.push(columns)
        const data = table === 'betting_analysis_runs'
          ? columns === 'id' ? [{ id }] : {
            id, season: 2026, stage: 'Regular Season', week: 'Week 1',
            model_name: 'test', summary: 'Saved.', created_at: '2026-09-01T00:00:00Z',
          }
          : table === 'betting_suggestions' ? [{ id: 1, run_id: id, result: 'loss' }]
            : [{
              id: 2, suggestion_id: 1, analysis_version: 1, model_name: 'test', summary: 'Loss.',
              clues: [], missing_metrics: [], created_at: '2026-09-01T00:00:00Z',
              metrics: { score: { label: 'Score', value: 10 } },
            }]
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
      } },
    })
    const view = await createWeeklyAnalysisStore(client).view!(id)
    assert.equal(view?.isFinal, true)
    assert.deepEqual(view?.suggestions[0].lossAnalysis?.evidence, { metrics: { score: { label: 'Score', value: 10 } } })
    assert.equal(Object.hasOwn(view!, 'context'), false)
    assert(selects.some((columns) => columns.includes('metrics:evidence_snapshot->metrics')))
    assert(selects.every((columns) => !columns.includes('context_snapshot')))
    await assert.rejects(createWeeklyAnalysisStore(client).summaries!({ limit: 101 }), /from 1 through 100/)
  })

  it('distinguishes network, deadline, cancellation and malformed read failures', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => { throw new TypeError('offline') }
      await assert.rejects(getAnalyticsMetadata(), (error) => error instanceof AppApiError && error.code === 'network_unavailable')
      for (const [name, code] of [['TimeoutError', 'read_timeout'], ['AbortError', 'cancelled']]) {
        const controller = new AbortController()
        controller.abort(new DOMException('Aborted', name))
        await assert.rejects(getAnalyticsMetadata(undefined, { signal: controller.signal }),
          (error) => error instanceof AppApiError && error.code === code)
      }
      globalThis.fetch = async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } })
      await assert.rejects(getAnalyticsMetadata(), (error) => error instanceof AppApiError && error.code === 'malformed_response')
    } finally { globalThis.fetch = originalFetch }
  })
})

describe('Analytics stream completion', () => {
  it('does not mistake a partial answer for a saved exchange', async () => {
    const content: string[] = []
    await assert.rejects(readAnalysisStream(stream('event: content\ndata: {"content":"Partial"}\n\n'),
      (event) => { if (event.type === 'content') content.push(event.content) }), /before saving was confirmed/)
    assert.deepEqual(content, ['Partial'])
  })

  it('handles heartbeat, split data lines, and a final event without a blank line', async () => {
    const events: string[] = []
    await readAnalysisStream(stream(': heartbeat\n\nevent: complete\ndata: {"model":\ndata: "test","finishReason":"stop"}'),
      (event) => events.push(event.type))
    assert.deepEqual(events, ['complete'])
  })

  it('reports interrupted weekly output rather than success', async () => {
    await assert.rejects(readWeeklyAnalysisStream(stream('event: progress\ndata: {"message":"Starting"}\n\n'), () => {}),
      /before completion/)
  })

  it('rejects success-shaped weekly completion events with missing run data', async () => {
    await assert.rejects(readWeeklyAnalysisStream(stream('event: complete\ndata: {"run":{}}\n\n'), () => {}),
      (error) => error instanceof AppApiError && error.code === 'malformed_response')
  })

  it('rejects malformed event data and releases the reader', async () => {
    const body = stream('event: complete\ndata: []\n\n')
    await assert.rejects(readAnalysisStream(body, () => {}), /invalid event/)
    assert.equal(body.locked, false)
  })

  it('aborts a waiting stream without persisting or reporting completion', async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} })
    const controller = new AbortController()
    const read = readAnalysisStream(body, () => { throw new Error('Must not complete') }, controller.signal)
    controller.abort()
    await assert.rejects(read, { name: 'AbortError' })
    assert.equal(body.locked, false)
  })
})
