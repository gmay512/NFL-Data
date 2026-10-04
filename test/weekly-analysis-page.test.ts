import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import type { Root } from 'react-dom/client'
import type { WeeklyAnalysisRun } from '../server/weekly-analysis'
import { invalidateAnalyticsReads } from '../src/data/analytics-repository'
import { captureAnalyticsExpiries, deferredAnalyticsReads } from './analytics-refresh-helpers'

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
  invalidateAnalyticsReads()
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
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname
    if (path === '/api/analytics/weekly/runs') return json({ runs: getRuns() })
    if (path === '/api/analytics/weekly/summaries') {
      const season = Number(url.searchParams.get('season')) || 2025
      const runs = getRuns().filter((run) => run.season === season && !/^pre[\s-]*season$/i.test(run.stage ?? ''))
      const record = (items: WeeklyAnalysisRun[]) => {
        const picks = items.flatMap((run) => run.suggestions)
        return {
          wins: picks.filter((pick) => pick.result === 'win').length,
          losses: picks.filter((pick) => pick.result === 'loss').length,
          pushes: picks.filter((pick) => pick.result === 'push').length,
          pending: picks.filter((pick) => pick.result === 'ungraded').length,
        }
      }
      return json({
        runs: runs.filter((run) => !url.searchParams.get('week') || run.week === url.searchParams.get('week')).map((run) => ({
          id: run.id, season: run.season, stage: run.stage, week: run.week, model: run.model,
          createdAt: run.createdAt, picks: run.suggestions.length, record: record([run]),
          isFinal: !runs.some((other) => other.stage === run.stage && other.week === run.week
            && (other.createdAt > run.createdAt || (other.createdAt === run.createdAt && other.id > run.id))),
        })),
        weeks: [...new Set(runs.map((run) => run.week))], record: record(runs), next: null,
        selectedSeason: runs.length ? Math.max(...runs.map((run) => run.season)) : null,
        total: runs.length,
      })
    }
    if (path.startsWith('/api/analytics/weekly/runs/')) {
      const run = getRuns().find((item) => item.id === path.split('/').at(-1))
      return run ? json({ run }) : json({ error: 'Not found.' }, 404)
    }
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
  for (const picksRemain of [true, false]) {
    it(`shows citation omission warnings after generation with ${picksRemain ? 'accepted picks' : 'zero picks'}`, async () => {
      const warning = "Application note: 1 model suggestion omitted because cited game IDs were outside the target matchup's supplied history (pick 7)."
      const created = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z',
        `${picksRemain ? '1 tracked suggestion.' : 'No supported bets met the model selection criteria for this run.'}\n\n${warning}`)
      if (!picksRemain) created.suggestions = []
      else created.suggestions[0].rationale = 'Supported recorded facts.'
      let runs: WeeklyAnalysisRun[] = []
      let generations = 0
      const container = await renderPage(async (input, init) => {
        const path = new URL(String(input), 'http://localhost').pathname
        if (path === '/api/analytics/weekly/analyze-stream') {
          generations++
          runs = [created]
          return new Response(`event: complete\ndata: ${JSON.stringify({ run: created })}\n\n`, {
            headers: { 'Content-Type': 'text/event-stream' },
          })
        }
        return baseFetch(() => runs)(input, init)
      })
      const analyze = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Analyze upcoming week')
      assert(analyze)
      await React.act(() => analyze.click())
      await settle()
      assert.equal(generations, 1)
      assert.equal(container.querySelector('.weekly-summary')?.textContent, created.summary)
      assert.equal(container.querySelectorAll('.weekly-pick').length, picksRemain ? 1 : 0)
      assert.equal(container.querySelector('.weekly-run-option')?.getAttribute('aria-pressed'), 'true')
      assert.match(container.querySelector('.weekly-run-option')?.textContent ?? '', new RegExp(`${picksRemain ? 1 : 0} picks`))
      for (const label of ['Tracked suggestion record', 'Selected analysis record']) {
        assert.match(container.querySelector(`[aria-label="${label}"]`)?.textContent ?? '', new RegExp(`${picksRemain ? 1 : 0} pending`))
      }
      assert.equal(container.querySelectorAll('[role="alert"]').length, 0)
      assert.equal(container.querySelector('.weekly-pick')?.textContent.includes(warning) ?? false, false)
    })
  }

  it('keeps selected output and model-help layout stable across timed refreshes', async (context) => {
    const expire = captureAnalyticsExpiries(context)
    const newer = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Newer output.')
    const selected = weeklyRun(oldRunId, 'Week 2', '2025-09-11T00:00:00.000Z', 'Selected older output.')
    selected.suggestions[0].result = 'loss'
    const reads = deferredAnalyticsReads(baseFetch(() => [newer, selected]))
    const container = await renderPage(reads.fetch, `/analytics/weekly?week=Week%202&run=${oldRunId}`)
    const page = container.querySelector('main')
    const workspace = container.querySelector('.weekly-workspace')
    const detail = container.querySelector<HTMLElement>('.weekly-run-detail')
    const pick = detail?.querySelector('.weekly-pick')
    const lossActions = detail?.querySelector('.weekly-loss-actions')
    const help = lossActions?.querySelector('.analytics-model-help')
    const lossButton = lossActions?.querySelector<HTMLButtonElement>('button')
    const analyze = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Analyze upcoming week')
    const selectedOption = container.querySelector('.weekly-run-option[aria-pressed="true"]')
    assert(page && workspace && detail && pick && lossActions && help && lossButton && analyze && selectedOption)
    const pageChildren = [...page.children]
    const actionChildren = [...lossActions.children]
    const helpChildren = [...help.children]
    const indicators = [...container.querySelectorAll('.analytics-refresh-indicator')]
    const initialCounts = new Map(reads.counts)
    detail.scrollTop = 41
    const assertStable = () => {
      assert.deepEqual([...page.children], pageChildren)
      assert.deepEqual([...lossActions.children], actionChildren)
      assert.deepEqual([...help.children], helpChildren)
      assert.deepEqual([...container.querySelectorAll('.analytics-refresh-indicator')], indicators)
      assert.equal(container.querySelector('.weekly-workspace'), workspace)
      assert.equal(container.querySelector('.weekly-run-detail'), detail)
      assert.equal(container.querySelector('.weekly-pick'), pick)
      assert.equal(container.querySelector('.weekly-run-option[aria-pressed="true"]'), selectedOption)
      assert.match(detail.querySelector('.weekly-summary')?.textContent ?? '', /Selected older output/)
      assert.equal(detail.scrollTop, 41)
      assert.equal(container.querySelector('.analytics-read-statuses .status-message'), null)
    }
    assert.equal(analyze.disabled, false)
    assert.equal(lossButton.disabled, false)
    const paths = ['/api/analytics/llm-health', '/api/analytics/weekly/summaries',
      `/api/analytics/weekly/runs/${oldRunId}`, '/api/analytics/metadata']
    reads.hold(...paths)
    await React.act(() => expire(5_000))
    assertStable()
    assert.equal(analyze.disabled, true)
    assert.equal(lossButton.disabled, true)
    assert.match(help.querySelector('.is-active')?.textContent ?? '', /Checking local LLM/)
    assert.equal(help.children[1].getAttribute('aria-hidden'), 'true')
    await React.act(() => {
      expire(60_000)
      expire(300_000)
    })
    assertStable()
    assert.equal(container.querySelectorAll('.analytics-refresh-indicator[role="status"]').length, 3)
    for (const path of paths) assert.equal(reads.counts.get(path), initialCounts.get(path)! + 1)
    await React.act(async () => { await Promise.all(paths.map((path) => reads.complete(path))) })
    assertStable()
    assert.equal(analyze.disabled, false)
    assert.equal(lossButton.disabled, false)
    assert.equal(help.querySelector('.is-active'), null)
    assert(indicators.every((indicator) => indicator.getAttribute('aria-hidden') === 'true'))
  })

  it('retains selected Weekly output when a timed detail refresh fails and can retry it', async (context) => {
    const expire = captureAnalyticsExpiries(context)
    const selected = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Saved output.')
    const reads = deferredAnalyticsReads(baseFetch(() => [selected]))
    const container = await renderPage(reads.fetch, `/analytics/weekly?week=Week%202&run=${newRunId}`)
    const path = `/api/analytics/weekly/runs/${newRunId}`
    reads.hold(path)
    await React.act(() => expire(60_000))
    await React.act(() => reads.complete(path, json({ error: 'Detail refresh unavailable.' }, 503)))
    assert.match(container.querySelector('.weekly-summary')?.textContent ?? '', /Saved output/)
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Detail refresh unavailable/)
    assert.equal(container.querySelector('.weekly-run-option')?.getAttribute('aria-pressed'), 'true')
    selected.summary = 'Updated saved output.'
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry selected analysis')
    assert(retry)
    await React.act(() => retry.click())
    assert.equal(reads.counts.get(path), 3)
    assert.match(container.querySelector('.weekly-summary')?.textContent ?? '', /Updated saved output/)
    assert.equal(container.querySelector('[role="alert"]'), null)
  })

  it('preserves a newly saved analysis and its record when summary refresh fails', async () => {
    const created = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Persisted success.')
    let saved = false
    const container = await renderPage(async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/weekly/analyze-stream') {
        saved = true
        return new Response(`event: complete\ndata: ${JSON.stringify({ run: created })}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      if (saved && path === '/api/analytics/weekly/summaries') return json({ error: 'Summary refresh failed.' }, 503)
      return baseFetch(() => saved ? [created] : [])(input, init)
    })
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Analyze upcoming week')
    assert(button)
    await React.act(async () => button.click())
    await settle()
    assert.match(container.querySelector('.weekly-run-detail')?.textContent ?? '', /Persisted success/)
    assert.match(container.textContent ?? '', /Summary refresh failed/)
    assert.match(container.querySelector('[aria-label="Tracked suggestion record"]')?.textContent ?? '', /1 pending/)
    assert.equal(container.querySelectorAll('.weekly-run-option').length, 1)
  })

  it('does not replace a deep link with another run after a temporary detail failure', async () => {
    const newest = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Newest output.')
    let linkedReads = 0
    const container = await renderPage(async (input) => {
      if (new URL(String(input), 'http://localhost').pathname === `/api/analytics/weekly/runs/${oldRunId}`) {
        linkedReads++
        return json({ error: 'Linked detail unavailable.' }, 503)
      }
      return baseFetch(() => [newest])(input)
    }, `/analytics/weekly?run=${oldRunId}`)
    assert.equal(linkedReads, 1)
    assert.match(container.textContent ?? '', /Linked detail unavailable/)
    assert.doesNotMatch(container.querySelector('.weekly-run-detail')?.textContent ?? '', /Newest output/)
  })

  it('keeps saved runs available without waiting for slow metadata or model health', async () => {
    const saved = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Independent saved output.')
    const container = await renderPage(async (input) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/metadata' || path === '/api/analytics/llm-health') {
        return new Promise<Response>(() => {})
      }
      return baseFetch(() => [saved])(input)
    })
    assert.match(container.textContent ?? '', /Independent saved output/)
    assert.equal(container.querySelector('.weekly-run-option')?.getAttribute('aria-pressed'), 'true')
  })

  it('does not hide the saved-run browser when a selected detail fails', async () => {
    const saved = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Saved output.')
    const container = await renderPage(async (input) => {
      if (new URL(String(input), 'http://localhost').pathname === `/api/analytics/weekly/runs/${newRunId}`) {
        return json({ error: 'Detail temporarily unavailable.' }, 503)
      }
      return baseFetch(() => [saved])(input)
    })
    assert.equal(container.querySelectorAll('.weekly-run-option').length, 1)
    assert.match(container.textContent ?? '', /Detail temporarily unavailable/)
    assert.match(container.textContent ?? '', /Retry selected analysis/)
  })

  it('opens a run deep link outside the first summary page', async () => {
    const newest = weeklyRun(newRunId, 'Week 2', '2025-09-12T00:00:00.000Z', 'Newest output.')
    const linked = weeklyRun(oldRunId, 'Week 2', '2025-09-11T00:00:00.000Z', 'Linked older output.')
    const container = await renderPage(async (input) => {
      const path = new URL(String(input), 'http://localhost').pathname
      return baseFetch(() => path === '/api/analytics/weekly/summaries' ? [newest] : [newest, linked])(input)
    }, `/analytics/weekly?run=${oldRunId}`)
    assert.match(container.querySelector('.weekly-run-detail')?.textContent ?? '', /Linked older output/)
    assert.doesNotMatch(container.querySelector('.weekly-run-detail')?.textContent ?? '', /Newest output/)
  })

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
