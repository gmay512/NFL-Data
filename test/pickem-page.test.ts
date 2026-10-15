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
    assert.equal(button(container, 'Print results').disabled, false)
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
    assert.equal(button(container, 'Print results').disabled, true)
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
    assert.equal(button(container, 'Print results').disabled, false)
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
  it('prints only the selected saved report without new requests or changes to saved data', async () => {
    const selectedWeek = { ...pickemWeek, week: 'Week 5' }
    const selectedPick = {
      ...pickemAnalysis.predictions[0], result: 'win' as const,
      finalAwayScore: 24, finalHomeScore: 21, gradedAt: '2026-10-11T21:00:00Z',
    }
    const before = {
      winnerTeamId: 26, winnerTeamName: 'Houston', confidence: 50,
      supportingPoints: [{ text: 'Earlier supporting factor.', evidenceIds: ['limitations'] }],
      risks: selectedPick.risks, evidence: {},
    }
    const selected: PickemWeekView = {
      ...pickemView, ...selectedWeek,
      games: [{ ...pickemView.games[0], status: 'FT', eligible: false, locked: true }],
      record: { wins: 1, losses: 0, ties: 0, pending: 0, void: 0 },
      analysis: {
        ...pickemAnalysis, ...selectedWeek, revision: 2, predictions: [selectedPick],
        summary: '1 game predictions changed versus the previous analysis.',
        changes: [{ gameId: selectedPick.gameId, kind: 'updated', before,
          after: { ...before, winnerTeamId: 29, winnerTeamName: 'Dallas', confidence: 61, supportingPoints: selectedPick.supportingPoints } }],
      },
    }
    const weeks = { ...pickemWeeks, weeks: [
      ...pickemWeeks.weeks, { ...selectedWeek, firstKickoff: selectedPick.kickoffAt, analysisId: pickemAnalysis.id, revision: 2 },
    ] }
    const fetcher = baseFetch(() => selected, { weeks, offline: true })
    let requests = 0
    const container = await render(async (input, init) => {
      requests++
      if (new URL(String(input), 'http://localhost').pathname === '/api/analytics/pickem/week'
        && new URL(String(input), 'http://localhost').searchParams.get('week') === pickemWeek.week) return json(pickemView)
      return fetcher(input, init)
    })
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Week"]')!
    await React.act(async () => {
      select.value = JSON.stringify([selectedWeek.stage, selectedWeek.week])
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await settle()
    const report = container.querySelector('.pickem-print-area')!
    const original = report.innerHTML
    const requestCount = requests
    let printed = 0
    window.print = () => {
      printed++
      assert.match(report.querySelector('h2')!.textContent!, /Pickem - 2026 Week 5/)
      assert.match(report.textContent!, /Regular Season/)
      assert.match(report.textContent!, /Revision 2/)
      assert.match(report.textContent!, /Outright winner: Dallas/)
      assert.match(report.textContent!, /61% model confidence/)
      assert.match(report.textContent!, /Final: Dallas 24.*Houston 21/)
      assert.match(report.textContent!, /Original prediction retained/)
      assert.match(report.textContent!, /Sources refreshed/)
      assert.match(report.textContent!, /test-model/)
      assert.equal(report.querySelector('[aria-label="Supporting factors"] li')?.textContent, selectedPick.supportingPoints[0].text)
      assert.equal(report.querySelector('[aria-label="Risks and data gaps"] li')?.textContent, selectedPick.risks[0].text)
      assert.equal(report.querySelector('[aria-label="Source limitations"] li')?.textContent, selectedPick.dataWarnings[0])
      assert.match(report.querySelector('[aria-label="Pickem weekly record"]')!.textContent!, /1 wins.*100.0%/)
      assert.equal(report.querySelector('button, select, [role="status"], [role="alert"]'), null)
      assert.equal(report.querySelector('.weekly-summary')?.classList.contains('pickem-screen-only'), true)
      assert(report.querySelector('.pickem-change'))
    }
    assert.equal(button(container, 'Print results').disabled, false)
    await React.act(() => button(container, 'Print results').click())
    await React.act(() => window.dispatchEvent(new window.Event('afterprint')))
    assert.equal(printed, 1)
    assert.equal(requests, requestCount)
    assert.equal(report.innerHTML, original)
    assert.equal(button(container, 'Print results').disabled, false)
  })
  it('keeps printing disabled while loading or when saved predictions are empty', async () => {
    let resolveDetail!: (response: Response) => void
    const fetcher = baseFetch(() => pickemView)
    const container = await render((input, init) =>
      new URL(String(input), 'http://localhost').pathname === '/api/analytics/pickem/week'
        ? new Promise<Response>((resolve) => { resolveDetail = resolve })
        : fetcher(input, init))
    assert.equal(button(container, 'Print results').disabled, true)
    await React.act(() => resolveDetail(json({
      ...pickemView, analysis: { ...pickemAnalysis, predictions: [] },
      record: { wins: 0, losses: 0, ties: 0, pending: 0, void: 0 },
    })))
    await settle()
    assert.equal(button(container, 'Print results').disabled, true)
  })
  it('disables printing during grading or analysis and restores it without replacing saved results', async () => {
    let grades = 0
    let resolveGrade!: (response: Response) => void
    let resolveAnalysis!: (response: Response) => void
    const fetcher = baseFetch(() => pickemView)
    const container = await render((input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/pickem/grade' && ++grades > 1) {
        return new Promise<Response>((resolve) => { resolveGrade = resolve })
      }
      if (path === '/api/analytics/pickem/analyze-stream') {
        return new Promise<Response>((resolve) => { resolveAnalysis = resolve })
      }
      return fetcher(input, init)
    })
    let prints = 0
    window.print = () => { prints++ }
    assert.equal(button(container, 'Print results').disabled, false)
    await React.act(() => button(container, 'Refresh results').click())
    assert.equal(button(container, 'Print results').disabled, true)
    await React.act(() => button(container, 'Print results').click())
    await React.act(() => resolveGrade(json({ graded: 0, requestedGames: 0, refreshedGames: 0, refreshError: null })))
    await settle()
    assert.equal(button(container, 'Print results').disabled, false)
    await React.act(() => button(container, 'Update analysis').click())
    assert.equal(button(container, 'Print results').disabled, true)
    await React.act(() => button(container, 'Print results').click())
    await React.act(() => resolveAnalysis(new Response(
      'event: error\ndata: {"error":"Test update stopped","code":"invalid_model_output"}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    )))
    await settle()
    assert.equal(button(container, 'Print results').disabled, false)
    assert.match(container.querySelector('.pickem-print-area')!.textContent!, /Outright winner: Dallas/)
    assert.equal(prints, 0)
  })
  it('surfaces print-dialog failures without modifying saved results and allows retry', async () => {
    const container = await render(baseFetch(() => pickemView))
    const report = container.querySelector('.pickem-print-area')!
    const original = report.innerHTML
    window.print = () => { throw new Error('Printer unavailable') }
    await React.act(() => button(container, 'Print results').click())
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Could not print Pickem results: Printer unavailable/)
    assert.equal(report.innerHTML, original)
    assert.equal(button(container, 'Print results').disabled, false)
    let printed = 0
    window.print = () => { printed++ }
    await React.act(() => button(container, 'Print results').click())
    assert.equal(printed, 1)
    assert.equal(container.querySelector('[role="alert"]'), null)
  })
  it('preserves existing result-refresh warnings when printing or cancelling the dialog', async () => {
    const fetcher = baseFetch(() => pickemView)
    const container = await render((input, init) =>
      new URL(String(input), 'http://localhost').pathname === '/api/analytics/pickem/grade'
        ? Promise.resolve(json({ graded: 0, requestedGames: 0, refreshedGames: 0, refreshError: 'Saved grades may be stale.' }))
        : fetcher(input, init))
    window.print = () => {}
    await React.act(() => button(container, 'Print results').click())
    await React.act(() => window.dispatchEvent(new window.Event('afterprint')))
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Saved grades may be stale/)
  })
})
