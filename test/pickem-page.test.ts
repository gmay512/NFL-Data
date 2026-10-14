import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import type { Root } from 'react-dom/client'
import type { PickemAnalysis, PickemWeekView } from '../src/api/pickem-contracts'
import { invalidateAnalyticsReads } from '../src/data/analytics-repository'
import { pickemAnalysis, pickemView, pickemWeek, pickemWeeks } from './pickem-fixtures'

let root: Root | null = null
let dom: JSDOM | null = null
afterEach(async () => {
  if (root) await React.act(() => root?.unmount())
  root = null
  invalidateAnalyticsReads()
  dom?.window.close()
  dom = null
})
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'Content-Type': 'application/json' },
})
async function settle() {
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
}
async function render(fetchHandler: typeof fetch, entry = '/analytics/pickem') {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/analytics/pickem' })
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator }, HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event }, fetch: { configurable: true, value: fetchHandler },
    React: { configurable: true, value: React }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  })
  const [{ createRoot }, { MemoryRouter }, { PickemPage }] = await Promise.all([
    import('react-dom/client'), import('react-router-dom'), import('../src/pages/PickemPage'),
  ])
  const container = dom.window.document.getElementById('root')!
  root = createRoot(container)
  await React.act(async () => {
    root!.render(React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(PickemPage)))
  })
  await settle()
  await settle()
  return container
}
function button(container: HTMLElement, name: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name)
  assert(found, `Missing button ${name}`)
  return found
}
function baseFetch(view: () => PickemWeekView, options: { offline?: boolean; grades?: unknown[]; weeks?: typeof pickemWeeks } = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/analytics/metadata') return json({
      seasons: [2026, 2025], selectedSeason: 2026, teams: [], stages: [], weeks: [],
    })
    if (url.pathname === '/api/analytics/llm-health') return json(options.offline
      ? { status: 'unavailable', code: 'unavailable', message: 'Offline' }
      : { status: 'available', model: 'test-model', models: ['test-model'] })
    if (url.pathname === '/api/analytics/pickem/weeks') return json(options.weeks ?? pickemWeeks)
    if (url.pathname === '/api/analytics/pickem/week') return json(view())
    if (url.pathname === '/api/analytics/pickem/grade') {
      options.grades?.push(JSON.parse(String(init?.body)))
      return json({ graded: 0, requestedGames: 0, refreshedGames: 0, refreshError: null })
    }
    return json({ error: `Unexpected request ${url.pathname}` }, 500)
  }
}

describe('PickemPage', () => {
  it('defaults to the upcoming week and automatically grades exactly once without cache loops', async () => {
    const grades: unknown[] = []
    const container = await render(baseFetch(() => pickemView, { grades }))
    assert.match(container.textContent!, /Outright winner: Dallas/)
    assert.match(container.textContent!, /Current home spread \(context only\): -7/)
    assert.deepEqual(grades, [pickemWeek])
    await settle()
    await settle()
    assert.equal(grades.length, 1)
    await React.act(() => button(container, 'Refresh results').click())
    await settle()
    assert.equal(grades.length, 2)
  })
  it('retains saved output when the model is offline and disables generation', async () => {
    const container = await render(baseFetch(() => pickemView, { offline: true }))
    assert.match(container.textContent!, /Outright winner: Dallas/)
    assert.equal(button(container, 'Update analysis').disabled, true)
    assert.match(container.textContent!, /Local LLM offline/)
  })
  it('automatically reconciles other saved weeks for the season without repeat requests', async () => {
    const prior = { ...pickemWeek, week: 'Week 3' }
    const grades: unknown[] = []
    await render(baseFetch(() => pickemView, { grades, weeks: {
      ...pickemWeeks, weeks: [
        { ...prior, firstKickoff: '2026-09-20T17:00:00Z', analysisId: 'old-analysis', revision: 1 },
        ...pickemWeeks.weeks,
      ],
    } }))
    assert.deepEqual(grades, [pickemWeek, prior])
    await settle()
    assert.equal(grades.length, 2)
  })
  it('selects explicit unsaved future weeks from the schedule rather than historical metadata', async () => {
    const future = { ...pickemWeek, week: 'Week 10' }
    const requested: string[] = []
    const fetcher = baseFetch(() => ({ ...pickemView, ...future, analysis: null }), { weeks: {
      ...pickemWeeks, weeks: [...pickemWeeks.weeks, { ...future, firstKickoff: '2026-11-10T17:00:00Z', analysisId: null, revision: 0 }],
    } })
    const container = await render(async (input, init) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/analytics/pickem/week') requested.push(url.searchParams.get('week')!)
      return fetcher(input, init)
    }, '/analytics/pickem?season=2026&stage=Regular%20Season&week=Week%2010')
    assert(requested.every((week) => week === 'Week 10'))
    assert.equal(button(container, 'Generate analysis').disabled, false)
    assert.match(container.textContent!, /No analysis saved/)
  })
  it('keeps locked historical picks and unpredicted started games distinct from losses', async () => {
    const view: PickemWeekView = {
      ...pickemView, analysis: { ...pickemAnalysis, predictions: [{
        ...pickemAnalysis.predictions[0], result: 'tie', finalAwayScore: 24, finalHomeScore: 24, gradedAt: '2026-10-04T21:00:00Z',
      }] },
      games: [
        { ...pickemView.games[0], status: 'AOT', eligible: false, locked: true },
        { ...pickemView.games[0], gameId: 21571, status: 'FT', eligible: false, locked: true },
      ],
      record: { wins: 0, losses: 0, ties: 1, pending: 0, void: 0 },
    }
    const container = await render(baseFetch(() => view))
    assert.match(container.textContent!, /Original prediction retained/)
    assert.match(container.textContent!, /Not predicted before kickoff/)
    assert.match(container.textContent!, /1 ties/)
    assert.equal(button(container, 'Update analysis').disabled, true)
  })
  it('updates the canonical analysis and displays accessible before/after winner and confidence changes', async () => {
    const nextPick = { ...pickemAnalysis.predictions[0], winnerTeamId: 26, confidence: 72 }
    const before = {
      winnerTeamId: 29, winnerTeamName: 'Dallas', confidence: 61,
      supportingPoints: nextPick.supportingPoints, risks: nextPick.risks, evidence: { spread: -7 },
    }
    const updated: PickemAnalysis = {
      ...pickemAnalysis, revision: 2, predictions: [nextPick], summary: '1 game predictions changed versus the previous analysis.',
      changes: [{ gameId: nextPick.gameId, kind: 'updated', before,
        after: { ...before, winnerTeamId: 26, winnerTeamName: 'Houston', confidence: 72, evidence: { spread: -3 } } }],
    }
    let view = pickemView
    let analyzed = 0
    const grades: unknown[] = []
    const fetcher = baseFetch(() => view, { grades })
    const container = await render(async (input, init) => {
      if (String(input) === '/api/analytics/pickem/analyze-stream') {
        assert.deepEqual(JSON.parse(String(init?.body)), { ...pickemWeek, revision: 1 })
        analyzed++
        view = { ...view, analysis: updated }
        return new Response(`event: progress\ndata: {"message":"Refreshing injuries"}\n\nevent: complete\ndata: ${JSON.stringify({ analysis: updated })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return fetcher(input, init)
    })
    await React.act(() => button(container, 'Update analysis').click())
    await settle()
    assert.equal(analyzed, 1)
    assert.equal(grades.length, 1)
    assert.match(container.textContent!, /Outright winner: Houston/)
    assert.match(container.textContent!, /Changed versus previous analysis/)
    assert.equal(container.querySelector('del')?.textContent, 'Dallas')
    assert.match(container.textContent!, /61% → 72%/)
    assert.match(container.textContent!, /Home spread: -7 → -3/)
  })
  it('preserves prior saved predictions on refresh/model errors and escapes model text', async () => {
    const view = {
      ...pickemView, analysis: { ...pickemAnalysis, predictions: [{
        ...pickemAnalysis.predictions[0], supportingPoints: [{ text: '<b>Uncertain model prose</b>', evidenceIds: ['limitations'] }],
      }] },
    }
    const fetcher = baseFetch(() => view)
    const container = await render(async (input, init) => {
      if (String(input) === '/api/analytics/pickem/analyze-stream') {
        return new Response('event: error\ndata: {"error":"Required injury refresh failed","code":"pickem_refresh_failed"}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return fetcher(input, init)
    })
    await React.act(() => button(container, 'Update analysis').click())
    await settle()
    assert.match(container.textContent!, /Outright winner: Dallas/)
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /injury refresh failed/)
    assert.equal(container.querySelector('ul b'), null)
    assert.match(container.textContent!, /<b>Uncertain model prose<\/b>/)
  })
})
