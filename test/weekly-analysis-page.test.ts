import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import type { Root } from 'react-dom/client'
import type { WeeklyAnalysisRun } from '../server/weekly-analysis'

const newRunId = '99000000-0000-4000-8000-000000000003'
const oldRunId = '99000000-0000-4000-8000-000000000002'
const priorWeekRunId = '99000000-0000-4000-8000-000000000001'

function weeklyRun(id: string, week: string, createdAt: string, summary: string): WeeklyAnalysisRun {
  return {
    id,
    season: 2025,
    stage: 'Regular Season',
    week,
    model: 'test-model',
    context: {
      schemaVersion: 2,
      generatedAt: createdAt,
      season: 2025,
      stage: 'Regular Season',
      week,
      matchups: [],
    },
    summary,
    createdAt,
    suggestions: [{
      id: Number(id.slice(-1)),
      runId: id,
      gameId: 100 + Number(id.slice(-1)),
      season: 2025,
      stage: 'Regular Season',
      week,
      kickoffAt: '2025-09-21T17:00:00.000Z',
      awayTeamId: 2,
      awayTeamName: 'Visitors',
      homeTeamId: 1,
      homeTeamName: 'Hosts',
      market: 'spread',
      selection: 'away',
      lockedLine: 3.5,
      confidence: 61,
      rationale: `${summary} rationale`,
      supportingGameIds: [101],
      result: 'ungraded',
      resultDelta: null,
      finalAwayScore: null,
      finalHomeScore: null,
      gradedAt: null,
      createdAt,
      lossAnalysis: null,
    }],
  }
}

let dom: JSDOM | null = null
let root: Root | null = null

afterEach(async () => {
  if (root) await React.act(() => root?.unmount())
  root = null
  dom?.window.close()
  dom = null
})

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function settle() {
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

async function renderPage(fetchHandler: typeof fetch, initialEntry = '/analytics/weekly') {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/analytics/weekly' })
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event },
    fetch: { configurable: true, value: fetchHandler },
    React: { configurable: true, value: React },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  })
  const [{ createRoot }, { MemoryRouter }, { WeeklyAnalysisPage }] = await Promise.all([
    import('react-dom/client'),
    import('react-router-dom'),
    import('../src/pages/WeeklyAnalysisPage'),
  ])
  const container = dom.window.document.getElementById('root')
  assert(container)
  root = createRoot(container)
  await React.act(async () => {
    root?.render(React.createElement(
      MemoryRouter,
      { initialEntries: [initialEntry] },
      React.createElement(WeeklyAnalysisPage),
    ))
  })
  await settle()
  return container
}

function baseFetch(getRuns: () => WeeklyAnalysisRun[]) {
  return async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/analytics/weekly/runs') return json({ runs: getRuns() })
    if (path === '/api/analytics/metadata') {
      return json({
        seasons: [2025],
        teams: [],
        selectedSeason: 2025,
        stages: ['Regular Season'],
        weeks: ['Week 1', 'Week 2'],
      })
    }
    if (path === '/api/analytics/llm-health') {
      return json({ status: 'available', model: 'test-model', models: ['test-model'] })
    }
    if (path === '/api/refresh-season-odds') {
      return json({ season: 2025, bookmakers: 0, betTypes: 0, odds: 0 })
    }
    return json({ error: `Unexpected request: ${path}` }, 500)
  }
}

describe('WeeklyAnalysisPage', () => {
  it('runs an upcoming-week analysis and selects the newly saved final output', async () => {
    const created = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Newly generated output.')
    let runs: WeeklyAnalysisRun[] = []
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/weekly/analyze-stream' && init?.method === 'POST') {
        runs = [created]
        return new Response(
          `event: progress\ndata: {"stage":"running_model","message":"Running local model analysis…"}\n\n`
          + `event: complete\ndata: ${JSON.stringify({ run: created })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      return baseFetch(() => runs)(input)
    }
    const container = await renderPage(fetchHandler)
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((item) => item.textContent === 'Analyze upcoming week')
    assert(button)
    await React.act(async () => button.click())
    await settle()
    assert.match(container.querySelector('.weekly-run-detail')?.textContent ?? '', /Newly generated output\./)
    assert.match(container.querySelector('.weekly-run-detail .final-badge')?.textContent ?? '', /Final analysis/)
  })

  it('groups runs, marks each newest run final, and shows only the URL-selected output', async () => {
    const pastSeasonRun = weeklyRun(
      '99000000-0000-4000-8000-000000000004',
      'Week 18',
      '2024-12-30T00:00:00.000Z',
      'Past season output.',
    )
    pastSeasonRun.season = 2024
    pastSeasonRun.context.season = 2024
    pastSeasonRun.suggestions[0].season = 2024
    const preseasonRun = weeklyRun(
      '99000000-0000-4000-8000-000000000005',
      'Pre Season Week 3',
      '2025-09-13T00:00:00.000Z',
      'Preseason output.',
    )
    preseasonRun.stage = 'Preseason'
    preseasonRun.context.stage = 'Preseason'
    preseasonRun.suggestions[0].stage = 'Preseason'
    const postseasonRun = weeklyRun(
      '99000000-0000-4000-8000-000000000006',
      'Wild Card',
      '2026-01-10T00:00:00.000Z',
      'Postseason output.',
    )
    postseasonRun.stage = 'Post Season'
    postseasonRun.context.stage = 'Post Season'
    postseasonRun.suggestions[0].stage = 'Post Season'
    const runs = [
      postseasonRun,
      weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Newest week two output.'),
      weeklyRun(oldRunId, 'Week 2', '2025-09-11T00:00:00.000Z', 'Older week two output.'),
      weeklyRun(priorWeekRunId, 'Week 1', '2025-09-05T00:00:00.000Z', 'Week one output.'),
      pastSeasonRun,
      preseasonRun,
    ]
    const container = await renderPage(baseFetch(() => runs), `/analytics/weekly?run=${oldRunId}`)
    const selects = container.querySelectorAll<HTMLSelectElement>('select')
    assert.equal(selects.length, 2)
    assert.deepEqual([...selects[0].options].map((option) => option.textContent), ['2025'])
    assert.deepEqual([...selects[1].options].map((option) => option.textContent), ['Wild Card', 'Week 2', 'Week 1'])
    assert.equal(selects[1].value, 'Week 2')
    assert.match(container.textContent ?? '', /Older week two output\./)
    assert.doesNotMatch(container.querySelector('.weekly-run-detail')?.textContent ?? '', /Newest week two output\./)
    assert.doesNotMatch(container.textContent ?? '', /2024 Regular Season/)
    assert.doesNotMatch(container.textContent ?? '', /Preseason output\./)
    assert.match(selects[1].textContent ?? '', /Wild Card/)
    assert.doesNotMatch(selects[1].textContent ?? '', /Pre Season Week 3/)
    assert.equal(container.querySelectorAll('.weekly-run-browser .final-badge').length, 1)
    assert.equal(container.querySelector('.weekly-run-detail .final-badge'), null)

    const newest = container.querySelector<HTMLButtonElement>('.weekly-run-option')
    assert(newest)
    await React.act(async () => newest.click())
    await settle()
    assert.match(container.querySelector('.weekly-run-detail')?.textContent ?? '', /Newest week two output\./)
    assert.match(container.querySelector('.weekly-run-detail .final-badge')?.textContent ?? '', /Final analysis/)

    await React.act(async () => {
      selects[1].value = 'Week 1'
      selects[1].dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await settle()
    assert.match(container.querySelector('.weekly-run-detail')?.textContent ?? '', /Week one output\./)
  })

  it('keeps saved analyses available when season metadata fails', async () => {
    const saved = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Saved output remains available.')
    const historical = weeklyRun(oldRunId, 'Week 18', '2026-01-01T00:00:00.000Z', 'Recent historical output.')
    historical.season = 2024
    historical.context.season = 2024
    historical.suggestions[0].season = 2024
    const fetchHandler = async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/metadata') return json({ error: 'Season provider unavailable.' }, 503)
      return baseFetch(() => [historical, saved])(input)
    }
    const container = await renderPage(fetchHandler)
    assert.match(container.querySelector('.weekly-run-detail')?.textContent ?? '', /Saved output remains available\./)
    assert.doesNotMatch(container.textContent ?? '', /Recent historical output\./)
    assert.match(container.textContent ?? '', /Season provider unavailable\./)
    assert.match(container.querySelector('select')?.textContent ?? '', /2025/)
    const analyzeButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Analyze upcoming week')
    assert.equal(analyzeButton?.disabled, true)
  })

  it('prints the selected run and promotes the next run after deleting the final analysis', async () => {
    let runs = [
      weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Newest week two output.'),
      weeklyRun(oldRunId, 'Week 2', '2025-09-11T00:00:00.000Z', 'Older week two output.'),
    ]
    let printed = 0
    let deletedId: string | null = null
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path.startsWith('/api/analytics/weekly/runs/') && init?.method === 'DELETE') {
        deletedId = path.split('/').pop() ?? null
        runs = runs.filter((run) => run.id !== deletedId)
        return new Response(null, { status: 204 })
      }
      return baseFetch(() => runs)(input)
    }
    const container = await renderPage(fetchHandler, `/analytics/weekly?run=${newRunId}`)
    Object.defineProperties(window, {
      print: { configurable: true, value: () => { printed += 1 } },
      confirm: { configurable: true, value: () => true },
    })

    const printButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Print analysis')
    assert(printButton)
    printButton.click()
    assert.equal(printed, 1)
    assert(container.querySelector('.weekly-print-area'))

    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Delete analysis')
    assert(deleteButton)
    await React.act(async () => deleteButton.click())
    await settle()
    assert.equal(deletedId, newRunId)
    assert.match(container.querySelector('.weekly-run-detail')?.textContent ?? '', /Older week two output\./)
    assert.match(container.querySelector('.weekly-run-detail .final-badge')?.textContent ?? '', /Final analysis/)
  })

  it('refreshes displayed records and reports grading results', async () => {
    const run = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Ready to grade.')
    let graded = false
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/weekly/grade' && init?.method === 'POST') {
        graded = true
        run.suggestions[0] = {
          ...run.suggestions[0],
          result: 'win',
          resultDelta: 4.5,
          finalAwayScore: 24,
          finalHomeScore: 20,
          gradedAt: '2025-09-22T00:00:00.000Z',
        }
        return json({ requestedGames: 1, refreshedGames: 1, graded: 1 })
      }
      return baseFetch(() => [run])(input)
    }
    const container = await renderPage(fetchHandler)
    const gradeButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Grade completed picks')
    assert(gradeButton)
    await React.act(async () => gradeButton.click())
    await settle()
    assert.equal(graded, true)
    assert.match(container.textContent ?? '', /Graded 1 pick after refreshing 1 game\./)
    assert.match(container.querySelector('.weekly-run-detail')?.textContent ?? '', /1 wins/)
    assert.match(container.querySelector('.result-pill')?.textContent ?? '', /win/)
  })

  it('reports when refreshed games do not have completed results yet', async () => {
    const run = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Still pending.')
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/weekly/grade' && init?.method === 'POST') {
        return json({ requestedGames: 1, refreshedGames: 1, graded: 0 })
      }
      return baseFetch(() => [run])(input)
    }
    const container = await renderPage(fetchHandler)
    const gradeButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Grade completed picks')
    assert(gradeButton)
    await React.act(async () => gradeButton.click())
    await settle()
    assert.match(container.textContent ?? '', /Refreshed 1 game, but no completed results were available yet\./)
    assert.match(container.querySelector('.weekly-run-detail')?.textContent ?? '', /1 pending/)
  })

  it('analyzes one losing game from its card and deletes only its stored analysis', async () => {
    const run = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Loss ready for review.')
    run.suggestions[0] = {
      ...run.suggestions[0],
      result: 'loss',
      resultDelta: -2.5,
      finalAwayScore: 20,
      finalHomeScore: 26,
      gradedAt: '2025-09-22T00:00:00.000Z',
    }
    let analyzedSuggestionId: number | null = null
    let deletedAnalysisId: number | null = null
    const analysis = {
      id: 12,
      suggestionId: run.suggestions[0].id,
      analysisVersion: 1,
      model: 'test-model',
      evidence: {
        schemaVersion: 1 as const,
        suggestionId: run.suggestions[0].id,
        gameId: run.suggestions[0].gameId,
        market: 'spread' as const,
        selection: 'away' as const,
        lockedLine: 3.5,
        matchup: {
          awayTeamId: 2,
          awayTeamName: 'Visitors',
          homeTeamId: 1,
          homeTeamName: 'Hosts',
        },
        metrics: {
          'actual.away.turnovers': { label: 'Visitors turnovers', value: 3 },
          'actual.home.turnovers': { label: 'Hosts turnovers', value: 1 },
        },
        missingMetrics: ['Visitors red-zone efficiency'],
      },
      summary: 'Turnovers were the strongest available clue.',
      clues: [{
        category: 'turnovers' as const,
        title: 'Turnover disadvantage',
        explanation: 'The selected team committed more turnovers.',
        metricKeys: ['actual.away.turnovers', 'actual.home.turnovers'],
      }],
      missingMetrics: ['Visitors red-zone efficiency'],
      createdAt: '2025-09-23T00:00:00.000Z',
    }
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === `/api/analytics/weekly/suggestions/${run.suggestions[0].id}/analyze-loss`
        && init?.method === 'POST') {
        analyzedSuggestionId = run.suggestions[0].id
        run.suggestions[0] = { ...run.suggestions[0], lossAnalysis: analysis }
        return json({ analysis }, 201)
      }
      if (path === '/api/analytics/weekly/loss-analyses/12' && init?.method === 'DELETE') {
        deletedAnalysisId = 12
        run.suggestions[0] = { ...run.suggestions[0], lossAnalysis: null }
        return new Response(null, { status: 204 })
      }
      return baseFetch(() => [run])(input)
    }
    const container = await renderPage(fetchHandler)
    const analyzeButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Analyze loss')
    assert(analyzeButton)
    assert.equal(analyzeButton.disabled, false)
    await React.act(async () => analyzeButton.click())
    await settle()
    assert.equal(analyzedSuggestionId, run.suggestions[0].id)
    assert.match(container.textContent ?? '', /Turnovers were the strongest available clue\./)
    assert.match(container.textContent ?? '', /Visitors turnovers: 3/)
    assert.match(container.textContent ?? '', /1 unavailable metric/)

    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true })
    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Delete loss analysis')
    assert(deleteButton)
    await React.act(async () => deleteButton.click())
    await settle()
    assert.equal(deletedAnalysisId, 12)
    assert([...container.querySelectorAll('button')].some((button) => button.textContent === 'Analyze loss'))
  })

  it('disables per-game loss analysis while the local LLM is offline', async () => {
    const run = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Offline loss.')
    run.suggestions[0] = {
      ...run.suggestions[0],
      result: 'loss',
      resultDelta: -2.5,
      finalAwayScore: 20,
      finalHomeScore: 26,
      gradedAt: '2025-09-22T00:00:00.000Z',
    }
    const fetchHandler = async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/llm-health') {
        return json({ status: 'unavailable', code: 'unavailable', message: 'Offline.' })
      }
      return baseFetch(() => [run])(input)
    }
    const container = await renderPage(fetchHandler)
    const analyzeButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Analyze loss')
    assert(analyzeButton)
    assert.equal(analyzeButton.disabled, true)
    assert.match(container.textContent ?? '', /Start the local LLM to analyze this loss\./)
  })

  it('cancels an in-flight weekly analysis when the page unmounts', async () => {
    let analysisSignal: AbortSignal | undefined
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/weekly/analyze-stream' && init?.method === 'POST') {
        analysisSignal = init.signal ?? undefined
        return await new Promise<Response>((_resolve, reject) => {
          analysisSignal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          }, { once: true })
        })
      }
      return baseFetch(() => [])(input)
    }
    const container = await renderPage(fetchHandler)
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((item) => item.textContent === 'Analyze upcoming week')
    assert(button)
    await React.act(async () => button.click())
    await settle()
    assert(analysisSignal)
    assert.equal(analysisSignal.aborted, false)
    await React.act(() => root?.unmount())
    root = null
    assert.equal(analysisSignal.aborted, true)
  })
})
