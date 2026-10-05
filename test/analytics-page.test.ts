import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import type { Root } from 'react-dom/client'
import { buildAnalyticsSnapshot, type AnalyticsSourceData } from '../server/analytics-core'
import type { AnalysisSession } from '../server/analysis-store'
import { invalidateAnalyticsReads, useAnalyticsRead } from '../src/data/analytics-repository'
import { captureAnalyticsExpiries, deferredAnalyticsReads } from './analytics-refresh-helpers'
import { formattedReportMarkdown } from './analytics-report-fixtures'

const source: AnalyticsSourceData = {
  games: [{
    game_id: 101,
    season: 2025,
    stage: 'Regular Season',
    week: 'Week 1',
    game_date: '2025-09-07',
    game_timestamp: 1757260800,
    away_team_id: 2,
    away_team_name: 'Visitors',
    home_team_id: 1,
    home_team_name: 'Hosts',
    away_score: 20,
    home_score: 27,
    final_total: 47,
    home_margin: 7,
    closing_home_spread: -3.5,
    spread_bookmaker_count: 4,
    spread_delta: 3.5,
    spread_result: 'home_cover',
    closing_total: 44.5,
    total_bookmaker_count: 4,
    total_delta: 2.5,
    total_result: 'over',
  }],
  teamStats: [],
  standings: [],
  injuries: [],
  playerStats: [],
  players: [],
}
const manyGamesSource: AnalyticsSourceData = {
  ...source,
  games: Array.from({ length: 12 }, (_, index) => ({
    ...source.games[0],
    game_id: 200 + index,
    game_date: `2025-09-${String(index + 1).padStart(2, '0')}`,
    away_team_id: 100 + index * 2,
    away_team_name: `Away ${String.fromCharCode(65 + index)}`,
    home_team_id: 101 + index * 2,
    home_team_name: `Home ${String.fromCharCode(65 + index)}`,
    away_score: 14 + index,
    home_score: 20 + index,
    final_total: 34 + index * 2,
    home_margin: 6,
    closing_home_spread: -1 - index,
    spread_delta: 5 - index,
    spread_result: index < 6 ? 'home_cover' : 'away_cover',
    closing_total: 30 + index,
    total_delta: 4 + index,
    total_result: 'over',
  })),
}
const snapshot = buildAnalyticsSnapshot('season_overview', { season: 2025 }, source, '2025-10-01T00:00:00.000Z')
const session: AnalysisSession = {
  id: 'session-1',
  title: '2025 season overview',
  preset: 'season_overview',
  filters: { season: 2025 },
  context: snapshot,
  model: 'qwen3-coder-next',
  createdAt: '2025-10-01T00:00:00.000Z',
  updatedAt: '2025-10-01T00:00:00.000Z',
  messages: [{
    id: 1,
    role: 'assistant',
    content: 'The supplied game finished over the closing total.',
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    createdAt: '2025-10-01T00:00:00.000Z',
  }],
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

async function renderPage(fetchHandler: typeof fetch, initialEntry = '/analytics?season=2025', strict = false) {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/analytics' })
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
  const [{ createRoot }, { MemoryRouter }, { AnalyticsPage }] = await Promise.all([
    import('react-dom/client'),
    import('react-router-dom'),
    import('../src/pages/AnalyticsPage'),
  ])
  const container = dom.window.document.getElementById('root')
  assert(container)
  root = createRoot(container)
  await React.act(async () => {
    root?.render(React.createElement(
      MemoryRouter,
      { initialEntries: [initialEntry] },
      strict ? React.createElement(React.StrictMode, null, React.createElement(AnalyticsPage)) : React.createElement(AnalyticsPage),
    ))
  })
  await settle()
  return container
}

async function settle() {
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

function baseFetch(options?: { online?: boolean; empty?: boolean; saved?: boolean; many?: boolean }) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/analytics/metadata') return json({
      seasons: [2025],
      teams: [{ id: 1, name: 'Hosts' }, { id: 2, name: 'Visitors' }],
      selectedSeason: 2025,
      stages: ['Regular Season'],
      weeks: ['Week 1'],
    })
    if (path === '/api/analytics/llm-health') {
      return json(options?.online === false
        ? { status: 'unavailable', code: 'unavailable', message: 'offline' }
        : { status: 'available', model: 'qwen3-coder-next', models: ['qwen3-coder-next'] })
    }
    if (path === '/api/analytics/overview') {
      const result = options?.empty
        ? buildAnalyticsSnapshot('season_overview', { season: 2025 }, { ...source, games: [] })
        : options?.many
          ? buildAnalyticsSnapshot('season_overview', { season: 2025 }, manyGamesSource)
          : snapshot
      return json({ snapshot: result })
    }
    if (path === '/api/analytics/sessions' && init?.method !== 'POST') {
      return json({ sessions: options?.saved ? [session] : [], next: null })
    }
    if (path === '/api/analytics/weekly/runs') return json({ runs: [] })
    if (path === '/api/refresh-season-odds') return json({
      season: 2025,
      bookmakers: 0,
      betTypes: 0,
      odds: 0,
    })
    if (path === '/api/analytics/sessions/session-1') return json({ session })
    return json({ error: `Unexpected request: ${path}` }, 500)
  }
}

describe('AnalyticsPage', () => {
  it('keeps content, sorting, scroll, and drafts stable across timed refreshes', async (context) => {
    const expire = captureAnalyticsExpiries(context)
    const reads = deferredAnalyticsReads(baseFetch({ saved: true, many: true }))
    const container = await renderPage(reads.fetch)
    const open = container.querySelector<HTMLButtonElement>('.saved-analysis-open')
    assert(open)
    await React.act(() => open.click())
    await settle()

    const page = container.querySelector('main')
    const kpis = container.querySelector('.analytics-kpis')
    const hero = container.querySelector('.analytics-hero')
    const actions = container.querySelector('.analysis-actions')
    const table = container.querySelector('.analytics-results-table')
    const sortHeader = table?.querySelector('thead th:nth-child(6)')
    const sortButton = sortHeader?.querySelector<HTMLButtonElement>('button')
    const scroll = table?.closest<HTMLDivElement>('.analytics-table-scroll')
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
    const help = actions?.querySelector('.analytics-model-help')
    assert(page && kpis && hero && actions && table && sortHeader && sortButton && scroll && textarea && help)
    await React.act(async () => {
      sortButton.click()
      const setter = Object.getOwnPropertyDescriptor(dom?.window.HTMLTextAreaElement.prototype, 'value')?.set
      assert(setter)
      setter.call(textarea, 'Keep this question while refreshing.')
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    scroll.scrollTop = 87
    textarea.focus()
    const pageChildren = [...page.children]
    const actionChildren = [...actions.children]
    const helpChildren = [...help.children]
    const indicators = [...container.querySelectorAll('.analytics-refresh-indicator')]
    const sortedIds = [...table.querySelectorAll('tbody th')].map((cell) => cell.textContent)
    const sortDirection = sortHeader.getAttribute('aria-sort')
    const assertStable = () => {
      assert.deepEqual([...page.children], pageChildren)
      assert.deepEqual([...actions.children], actionChildren)
      assert.deepEqual([...help.children], helpChildren)
      assert.deepEqual([...container.querySelectorAll('.analytics-refresh-indicator')], indicators)
      assert.equal(container.querySelector('.analytics-hero'), hero)
      assert.equal(container.querySelector('.analytics-kpis'), kpis)
      assert.equal(container.querySelector('.analytics-results-table'), table)
      assert.equal(container.querySelector('textarea'), textarea)
      assert.equal(sortHeader.getAttribute('aria-sort'), sortDirection)
      assert.deepEqual([...table.querySelectorAll('tbody th')].map((cell) => cell.textContent), sortedIds)
      assert.equal(scroll.scrollTop, 87)
      assert.equal(textarea.value, 'Keep this question while refreshing.')
      assert.equal(document.activeElement, textarea)
      assert.equal(container.querySelector('.analytics-read-statuses .status-message'), null)
    }
    const analyze = [...actions.querySelectorAll<HTMLButtonElement>('button')][0]
    assert.equal(analyze.disabled, false)
    assert.equal(indicators.length, 3)
    assert(indicators.every((indicator) => indicator.getAttribute('aria-hidden') === 'true'))
    reads.hold('/api/analytics/llm-health', '/api/analytics/overview', '/api/analytics/sessions', '/api/analytics/metadata')

    await React.act(() => expire(5_000))
    assertStable()
    assert.equal(analyze.disabled, true)
    assert.equal(container.querySelector('.llm-status')?.getAttribute('aria-busy'), 'true')
    assert.match(help.querySelector('.is-active')?.textContent ?? '', /Checking local LLM/)
    assert.equal(help.children[1].getAttribute('aria-hidden'), 'true')
    assert.equal(reads.counts.get('/api/analytics/llm-health'), 2)

    await React.act(() => {
      expire(60_000)
      expire(300_000)
    })
    assertStable()
    assert.equal(container.querySelectorAll('.analytics-refresh-indicator[role="status"]').length, 3)
    for (const path of ['/api/analytics/overview', '/api/analytics/sessions', '/api/analytics/metadata']) {
      assert.equal(reads.counts.get(path), 2)
    }
    await React.act(async () => {
      await Promise.all(['/api/analytics/llm-health', '/api/analytics/overview', '/api/analytics/sessions', '/api/analytics/metadata']
        .map((path) => reads.complete(path)))
    })
    assertStable()
    assert.equal(analyze.disabled, false)
    assert.equal(help.querySelector('.is-active'), null)
    assert(indicators.every((indicator) => indicator.getAttribute('aria-hidden') === 'true'))

    reads.hold('/api/analytics/llm-health')
    await React.act(() => expire(5_000))
    await React.act(() => reads.complete('/api/analytics/llm-health',
      json({ status: 'unavailable', code: 'unavailable', message: 'Offline.' })))
    assertStable()
    assert.equal(analyze.disabled, true)
    assert.match(help.querySelector('.is-active')?.textContent ?? '', /Start llama-server/)
    assert.match(container.querySelector('.llm-status')?.textContent ?? '', /Local LLM offline/)
  })

  it('preserves timed-refresh failures and retry while applying changed results', async (context) => {
    const expire = captureAnalyticsExpiries(context)
    let nextSnapshot = snapshot
    const reads = deferredAnalyticsReads(async (input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/analytics/overview') {
        return json({ snapshot: nextSnapshot })
      }
      return baseFetch()(input, init)
    })
    const container = await renderPage(reads.fetch)
    const kpis = container.querySelector('.analytics-kpis')
    reads.hold('/api/analytics/overview')
    await React.act(() => expire(60_000))
    assert.equal(container.querySelector('.analytics-kpis'), kpis)
    assert.equal(container.querySelector('.status-message'), null)
    await React.act(() => reads.complete('/api/analytics/overview', json({ error: 'Refresh unavailable.' }, 503)))
    assert.equal(container.querySelector('.analytics-kpis'), kpis)
    assert.match(container.textContent ?? '', /Completed games1/)
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Refresh unavailable/)
    nextSnapshot = buildAnalyticsSnapshot('season_overview', { season: 2025 }, {
      ...source, games: [source.games[0], { ...source.games[0], game_id: 102 }],
    })
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry analytics')
    assert(retry)
    await React.act(() => retry.click())
    assert.equal(reads.counts.get('/api/analytics/overview'), 3)
    assert.equal(container.querySelector('.analytics-kpis'), kpis)
    assert.match(container.textContent ?? '', /Completed games2/)
    assert.equal(container.querySelector('[role="alert"]'), null)
    assert.equal(container.querySelectorAll('.analytics-results-table tbody tr').length, 2)
  })

  it('keeps a shared request alive when just one subscriber unmounts', async () => {
    const container = await renderPage(baseFetch())
    let requests = 0
    let signal: AbortSignal | undefined
    let finish: ((value: number) => void) | undefined
    const load = (incoming: AbortSignal) => {
      requests++
      signal = incoming
      return new Promise<number>((resolve) => { finish = resolve })
    }
    function Consumer({ label }: { label: string }) {
      const read = useAnalyticsRead('subscriber-test', load)
      return React.createElement('span', null, `${label}:${read.data ?? 'loading'}`)
    }
    await React.act(() => root?.render(React.createElement(React.Fragment, null,
      React.createElement(Consumer, { label: 'first', key: 'first' }),
      React.createElement(Consumer, { label: 'second', key: 'second' }),
    )))
    assert.equal(requests, 1)
    await React.act(() => root?.render(React.createElement(React.Fragment, null,
      React.createElement(Consumer, { label: 'second', key: 'second' }),
    )))
    assert.equal(signal?.aborted, false)
    await React.act(() => finish?.(42))
    assert.match(container.textContent ?? '', /second:42/)
    assert.equal(requests, 1)
  })

  it('marks expired same-key content refreshing instead of dropping saved output', async () => {
    const container = await renderPage(baseFetch())
    let requests = 0
    function Consumer() {
      const read = useAnalyticsRead('expiry-test', async () => {
        if (++requests === 1) return 42
        return new Promise<number>(() => {})
      }, 15)
      return React.createElement('span', null, `${read.data ?? 'empty'}:${read.isRefreshing ? 'refreshing' : 'current'}`)
    }
    await React.act(() => root?.render(React.createElement(Consumer)))
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    assert.match(container.textContent ?? '', /42:refreshing/)
    assert.equal(requests, 2)
  })

  it('does not couple saved-list failures to filter metadata or metrics', async () => {
    const container = await renderPage(async (input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/analytics/sessions') {
        return json({ error: 'Saved list unavailable.' }, 503)
      }
      return baseFetch()(input, init)
    })
    assert.match(container.textContent ?? '', /Completed games1/)
    assert.match(container.textContent ?? '', /Saved list unavailable/)
    assert.match(container.querySelector('.analytics-filters')?.textContent ?? '', /2025/)
  })

  it('finishes the initial loading state when metadata fails without a selected season', async () => {
    const container = await renderPage(async (input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/analytics/metadata') {
        return json({ error: 'Metadata unavailable.' }, 503)
      }
      return baseFetch({ saved: true })(input, init)
    }, '/analytics')
    assert.match(container.textContent ?? '', /Metadata unavailable/)
    assert.doesNotMatch(container.textContent ?? '', /Calculating analytics/)
    assert.match(container.textContent ?? '', /2025 season overview/)
  })

  it('deduplicates expensive reads under StrictMode', async () => {
    let queries = 0
    const container = await renderPage(async (input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/analytics/overview') queries++
      return baseFetch()(input, init)
    }, '/analytics?season=2025', true)
    assert.equal(queries, 1)
    assert.match(container.textContent ?? '', /Completed games1/)
  })

  it('shows the same-key cached result during a slow repeat visit', async () => {
    await renderPage(baseFetch())
    await React.act(() => root?.unmount())
    root = null
    dom?.window.close()
    let queries = 0
    const started = performance.now()
    const container = await renderPage(async (input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/analytics/overview') {
        queries++
        return new Promise<Response>(() => {})
      }
      return baseFetch()(input, init)
    })
    assert.equal(queries, 1)
    assert.match(container.textContent ?? '', /Completed games1/)
    assert.match(container.textContent ?? '', /Refreshing analytics/)
    assert.doesNotMatch(container.textContent ?? '', /Calculating analytics/)
    assert(performance.now() - started < 500)
  })

  it('keeps exact-filter cached content visible when an invalidated refresh fails', async () => {
    let fail = false
    const container = await renderPage(async (input, init) => {
      if (fail && new URL(String(input), 'http://localhost').pathname === '/api/analytics/overview') {
        return json({ error: 'Refresh unavailable.' }, 503)
      }
      return baseFetch()(input, init)
    })
    fail = true
    await React.act(() => invalidateAnalyticsReads('overview', { preserveData: true }))
    await settle()
    assert.match(container.textContent ?? '', /Completed games1/)
    assert.match(container.textContent ?? '', /Refresh unavailable/)
    assert.doesNotMatch(container.textContent ?? '', /Calculating analytics/)
  })

  it('does not let a slow saved-session open replace a later selection', async () => {
    const second = { ...session, id: 'session-2', title: 'Second analysis', messages: [] }
    let finishFirst: ((response: Response) => void) | undefined
    let firstSignal: AbortSignal | undefined
    const container = await renderPage(async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/sessions') return json({ sessions: [session, second], next: null })
      if (path === '/api/analytics/sessions/session-1') {
        firstSignal = init?.signal ?? undefined
        return new Promise<Response>((resolve) => { finishFirst = resolve })
      }
      if (path === '/api/analytics/sessions/session-2') return json({ session: second })
      return baseFetch()(input, init)
    })
    await React.act(() => container.querySelectorAll<HTMLButtonElement>('.saved-analysis-open')[0].click())
    await settle()
    await React.act(() => container.querySelectorAll<HTMLButtonElement>('.saved-analysis-open')[1].click())
    await settle()
    assert.equal(firstSignal?.aborted, true)
    await React.act(() => finishFirst?.(json({ session })))
    await settle()
    assert.match(container.querySelector('.analysis-chat')?.textContent ?? '', /Second analysis/)
    assert.doesNotMatch(container.querySelector('.analysis-chat')?.textContent ?? '', /2025 season overview/)
  })

  it('aborts obsolete filtered queries and ignores late results', async () => {
    let oldSignal: AbortSignal | undefined
    let finishOld: ((value: Response) => void) | undefined
    const container = await renderPage(async (input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/analytics/overview'
        && !(JSON.parse(String(init?.body)) as { filters: { teamId?: number } }).filters.teamId) {
        oldSignal = init?.signal ?? undefined
        return new Promise<Response>((resolve) => { finishOld = resolve })
      }
      return baseFetch()(input, init)
    })
    const teamSelect = container.querySelectorAll('select')[3]
    await React.act(() => {
      teamSelect.value = '1'
      teamSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await settle()
    assert.equal(oldSignal?.aborted, true)
    await React.act(() => finishOld?.(json({ snapshot: buildAnalyticsSnapshot('season_overview', { season: 2025 }, {
      ...source, games: [{ ...source.games[0], away_team_name: 'Obsolete team' }],
    }) })))
    await settle()
    assert.doesNotMatch(container.textContent ?? '', /Obsolete team/)
    assert.match(container.textContent ?? '', /Visitors at Hosts/)
  })

  it('renders historical metrics, team trends, sortable game results, and URL-backed filters', async () => {
    let requestedTeam: number | undefined
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/overview' && init?.body) {
        requestedTeam = (JSON.parse(String(init.body)) as { filters: { teamId?: number } }).filters.teamId
      }
      return baseFetch()(input, init)
    }
    const container = await renderPage(fetchHandler)
    assert.match(container.textContent ?? '', /100%/)
    assert.match(container.textContent ?? '', /Visitors at Hosts/)
    assert.match(container.textContent ?? '', /home cover/)

    const teamSelect = container.querySelectorAll('select')[3]
    assert(teamSelect)
    await React.act(async () => {
      teamSelect.value = '1'
      teamSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await settle()
    assert.equal(requestedTeam, 1)
  })

  it('stacks saved analysis under local analysis beside the conversation and keeps sortable table viewports', async () => {
    const container = await renderPage(baseFetch({ many: true }))
    const overview = container.querySelector('.analysis-overview')
    const sidebar = overview?.querySelector(':scope > .analysis-sidebar')
    const actions = sidebar?.querySelector(':scope > .analysis-actions')
    const saved = sidebar?.querySelector(':scope > .saved-analyses')
    const conversation = overview?.querySelector(':scope > .analysis-chat')
    assert(overview && sidebar && actions && saved && conversation)
    assert.deepEqual([...sidebar.children], [actions, saved])
    assert.equal(actions.querySelector('h2')?.textContent, 'Local analysis')
    assert.equal(saved.querySelector('h2')?.textContent, 'Saved analyses')
    assert.equal(conversation.querySelector('h2')?.textContent, 'Grounded conversation')

    const tables = container.querySelectorAll<HTMLTableElement>('.analytics-data-table')
    const scrollAreas = container.querySelectorAll('.analytics-table-scroll')
    assert.equal(tables.length, 2)
    assert.equal(scrollAreas.length, 2)
    assert.equal(tables[0].querySelectorAll('tbody tr').length, 24)
    assert.equal(tables[1].querySelectorAll('tbody tr').length, 12)

    for (const table of tables) {
      const headers = [...table.querySelectorAll<HTMLTableCellElement>('thead th')]
      assert(headers.length > 0)
      for (const header of headers) {
        const button = header.querySelector<HTMLButtonElement>('button')
        assert(button)
        await React.act(async () => button.click())
        assert.notEqual(header.getAttribute('aria-sort'), 'none')
      }
    }
  })

  it('keeps deterministic empty states available while the local model is offline', async () => {
    const container = await renderPage(baseFetch({ online: false, empty: true }))
    assert.match(container.textContent ?? '', /Local LLM offline/)
    assert.match(container.textContent ?? '', /No completed games match these filters/)
    assert.match(container.textContent ?? '', /Historical metrics remain available/)
    const analysisButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Season overview')
    assert.equal(analysisButton?.disabled, true)
  })

  it('renders deterministic analytics without waiting for a slow model health check', async () => {
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/llm-health') return new Promise<Response>(() => {})
      return baseFetch()(input, init)
    }
    const container = await renderPage(fetchHandler)
    assert.match(container.textContent ?? '', /Completed games1/)
    assert.match(container.textContent ?? '', /Visitors at Hosts/)
  })

  it('surfaces analytics query failures without hiding saved-analysis controls', async () => {
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/overview') return json({ error: 'Analytics database unavailable.' }, 503)
      return baseFetch()(input, init)
    }
    const container = await renderPage(fetchHandler)
    assert.match(container.textContent ?? '', /Analytics error/)
    assert.match(container.textContent ?? '', /Analytics database unavailable/)
    assert.match(container.textContent ?? '', /Saved analyses/)
  })

  it('does not show a previous snapshot after a filtered query fails', async () => {
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/overview' && init?.body) {
        const body = JSON.parse(String(init.body)) as { filters: { teamId?: number } }
        if (body.filters.teamId) return json({ error: 'Filtered query failed.' }, 503)
      }
      return baseFetch()(input, init)
    }
    const container = await renderPage(fetchHandler)
    assert.match(container.textContent ?? '', /Visitors at Hosts/)

    const teamSelect = container.querySelectorAll('select')[3]
    assert(teamSelect)
    await React.act(async () => {
      teamSelect.value = '1'
      teamSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await settle()
    assert.match(container.textContent ?? '', /Filtered query failed/)
    assert.doesNotMatch(container.textContent ?? '', /Visitors at Hosts/)
  })

  it('opens a saved session and streams a grounded follow-up response', async () => {
    let completedSession = session
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path.endsWith('/messages') && init?.method === 'POST') {
        completedSession = {
          ...session,
          messages: [...session.messages, {
            ...session.messages[0],
            id: 2,
            content: formattedReportMarkdown,
          }],
        }
        return new Response(
          `event: content\ndata: ${JSON.stringify({ content: formattedReportMarkdown })}\n\n`
          + 'event: complete\ndata: {"model":"qwen3-coder-next","finishReason":"stop"}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      if (path === '/api/analytics/sessions/session-1') return json({ session: completedSession })
      return baseFetch({ saved: true })(input, init)
    }
    const container = await renderPage(fetchHandler)
    const openButton = container.querySelector<HTMLButtonElement>('.saved-analysis-open')
    assert(openButton)
    await React.act(async () => openButton.click())
    await settle()

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
    const form = container.querySelector<HTMLFormElement>('form')
    assert(textarea && form)
    await React.act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(dom?.window.HTMLTextAreaElement.prototype, 'value')?.set
      assert(valueSetter)
      valueSetter.call(textarea, 'How did the home team perform ATS?')
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await React.act(async () => form.requestSubmit())
    await settle()
    const reports = container.querySelectorAll('.is-assistant .analytics-report-content')
    const followUp = reports[reports.length - 1]
    assert.equal(followUp.querySelector('h3')?.textContent, 'Validated factual report')
    assert.equal(followUp.querySelector('li strong')?.textContent, 'Dallas:')
    assert.equal(followUp.querySelectorAll('tbody tr').length, 2)
  })

  it('does not offer to regenerate an already saved reply when its reload fails', async () => {
    let saved = false
    const container = await renderPage(async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path.endsWith('/messages')) {
        saved = true
        return new Response(
          `event: content\ndata: ${JSON.stringify({ content: formattedReportMarkdown })}\n\n`
          + 'event: complete\ndata: {"model":"test","finishReason":"stop"}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      if (saved && path === '/api/analytics/sessions/session-1') return json({ error: 'Reload failed.' }, 503)
      return baseFetch({ saved: true })(input, init)
    })
    await React.act(() => container.querySelector<HTMLButtonElement>('.saved-analysis-open')?.click())
    await settle()
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    assert(textarea && setter)
    await React.act(() => {
      setter.call(textarea, 'Explain the result.')
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await React.act(() => container.querySelector<HTMLFormElement>('form')?.requestSubmit())
    await settle()
    assert.match(container.textContent ?? '', /The reply was saved, but the conversation could not be refreshed/)
    assert.match(container.textContent ?? '', /Local model \(saved\)/)
    const pendingReport = container.querySelector('.is-assistant:last-child .analytics-report-content')
    assert.equal(pendingReport?.querySelector('h3')?.textContent, 'Validated factual report')
    assert.equal(pendingReport?.querySelector('li strong')?.textContent, 'Dallas:')
    assert.equal(pendingReport?.querySelectorAll('tbody tr').length, 2)
    assert([...container.querySelectorAll('button')].some((button) => button.textContent === 'Retry conversation'))
    assert([...container.querySelectorAll('button')].every((button) => button.textContent !== 'Retry'))
  })

  it('opens a saved analysis from a session deep link', async () => {
    const container = await renderPage(baseFetch({ saved: true }), '/analytics?session=session-1')

    assert.match(container.textContent ?? '', /2025 season overview/)
    assert.match(container.textContent ?? '', /The supplied game finished over the closing total/)
    assert.match(container.textContent ?? '', /Grounding details/)
    assert.match(container.textContent ?? '', /effective history|all stages/i)
    assert.match(container.textContent ?? '', /Provider freshness/)
  })

  it('discloses unknown legacy scope without rewriting a saved message', async () => {
    const legacy = {
      ...session, context: { ...snapshot, schemaVersion: 1, evidenceScope: undefined },
    }
    const container = await renderPage(async (input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/analytics/sessions/session-1') {
        return json({ session: legacy })
      }
      return baseFetch({ saved: true })(input, init)
    }, '/analytics?session=session-1')
    assert.match(container.textContent ?? '', /Legacy report/)
    assert.match(container.textContent ?? '', /effective history scope was not recorded/)
    assert.match(container.textContent ?? '', /The supplied game finished over the closing total/)
  })

  it('formats saved assistant Markdown while retaining literal user text and immutable saved content', async () => {
    const formatted = {
      ...session,
      messages: [
        { ...session.messages[0], role: 'user', content: '# Literal question with **asterisks**' },
        { ...session.messages[0], id: 2, content: formattedReportMarkdown },
      ],
    }
    const before = JSON.stringify(formatted)
    const container = await renderPage(async (input, init) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/analytics/sessions/session-1') {
        return json({ session: formatted })
      }
      return baseFetch({ saved: true })(input, init)
    }, '/analytics?session=session-1')
    const report = container.querySelector('.is-assistant .analytics-report-content')
    assert.equal(report?.querySelector('h3')?.textContent, 'Validated factual report')
    assert.equal(report?.querySelector('h4')?.textContent, 'Team trends')
    assert.equal(report?.querySelector('li strong')?.textContent, 'Dallas:')
    assert.equal(report?.querySelectorAll('tbody tr').length, 2)
    assert.doesNotMatch(report?.textContent ?? '', /##|\*\*|\| ---/)
    const user = container.querySelector('.is-user')
    assert.equal(user?.querySelector('p')?.textContent, '# Literal question with **asterisks**')
    assert.equal(user?.querySelectorAll('h3, h4, p strong, .analytics-report-content').length, 0)
    assert.equal(JSON.stringify(formatted), before)
  })
})
