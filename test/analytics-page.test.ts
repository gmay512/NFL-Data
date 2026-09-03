import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import type { Root } from 'react-dom/client'
import { buildAnalyticsSnapshot, type AnalyticsSourceData } from '../server/analytics-core'
import type { AnalysisSession } from '../server/analysis-store'

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
  dom?.window.close()
  dom = null
})

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function renderPage(fetchHandler: typeof fetch, initialEntry = '/analytics?season=2025') {
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
      React.createElement(AnalyticsPage),
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
    if (path === '/api/analytics/query') {
      const result = options?.empty
        ? buildAnalyticsSnapshot('season_overview', { season: 2025 }, { ...source, games: [] })
        : options?.many
          ? buildAnalyticsSnapshot('season_overview', { season: 2025 }, manyGamesSource)
          : snapshot
      return json({ snapshot: result })
    }
    if (path === '/api/analytics/sessions' && init?.method !== 'POST') {
      return json({ sessions: options?.saved ? [session] : [] })
    }
    if (path === '/api/analytics/sessions/session-1') return json({ session })
    return json({ error: `Unexpected request: ${path}` }, 500)
  }
}

describe('AnalyticsPage', () => {
  it('renders historical metrics, team trends, sortable game results, and URL-backed filters', async () => {
    let requestedTeam: number | undefined
    const fetchHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/analytics/query' && init?.body) {
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
      if (path === '/api/analytics/query') return json({ error: 'Analytics database unavailable.' }, 503)
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
      if (path === '/api/analytics/query' && init?.body) {
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
            content: 'The home side covered by 3.5 points.',
          }],
        }
        return new Response(
          'event: content\ndata: {"content":"The home side covered"}\n\n'
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
    assert.match(container.textContent ?? '', /The home side covered by 3.5 points/)
  })

  it('opens a saved analysis from a session deep link', async () => {
    const container = await renderPage(baseFetch({ saved: true }), '/analytics?session=session-1')

    assert.match(container.textContent ?? '', /2025 season overview/)
    assert.match(container.textContent ?? '', /The supplied game finished over the closing total/)
  })
})
