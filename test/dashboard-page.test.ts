import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import type { Root } from 'react-dom/client'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import type { SupabaseClient } from '@supabase/supabase-js'

let dom: JSDOM | null = null
let root: Root | null = null
let vite: ViteDevServer | null = null
let client: SupabaseClient | null = null
let renderCount = 0

afterEach(async () => {
  if (root) await React.act(() => root?.unmount())
  await client?.auth.stopAutoRefresh()
  await vite?.close()
  dom?.window.close()
  root = null
  vite = null
  dom = null
  client = null
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}

async function settle() {
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
}

async function render(fetchHandler: typeof fetch, entry = '/?season=2026') {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event },
    fetch: { configurable: true, value: fetchHandler },
    React: { configurable: true, value: React },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    BroadcastChannel: { configurable: true, value: undefined },
  })
  vite = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, watch: null },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(`http://dashboard-${++renderCount}.localhost:54321`),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('test-anon-key'),
    },
  })
  const { DashboardPage } = await vite.ssrLoadModule('/src/pages/DashboardPage.tsx')
  client = (await vite.ssrLoadModule('/src/lib/supabase.ts')).supabase
  const [{ createRoot }, { MemoryRouter }] = await Promise.all([
    import('react-dom/client'), import('react-router-dom'),
  ])
  const container = dom.window.document.getElementById('root')!
  root = createRoot(container)
  await React.act(async () => {
    root?.render(React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(DashboardPage)))
  })
  await settle()
  return container
}

const games = [
  { id: 1, season: 2026, stage: 'Regular Season', week: 'Week 1', home_team_id: 2, away_team_id: 1, status_short: 'NS', game_date: '2099-09-01' },
  { id: 2, season: 2026, stage: 'Regular Season', week: 'Week 2', home_team_id: 2, away_team_id: 1, status_short: 'NS', game_date: '2099-09-08' },
]

it('renders games before discovery/odds and never applies stale week odds', async () => {
  const discovery = deferred<Response>()
  const firstOdds = deferred<Response>()
  const secondOdds = deferred<Response>()
  const oddsCalls: number[][] = []
  const container = await render(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/seasons') return discovery.promise
    if (url.pathname === '/api/analytics/llm-health') return json({ status: 'unavailable', message: 'offline' })
    if (url.pathname.endsWith('/league_seasons')) return json([{ season_year: 2026, is_current: true }])
    if (url.pathname.endsWith('/teams')) return json([{ id: 1, name: 'Visitors' }, { id: 2, name: 'Hosts' }])
    if (url.pathname.endsWith('/games')) return json(games)
    if (url.pathname.endsWith('/rpc/get_game_consensus_odds')) {
      const ids = JSON.parse(String(init?.body)).requested_game_ids as number[]
      oddsCalls.push(ids)
      return ids[0] === 1 ? firstOdds.promise : secondOdds.promise
    }
    throw new Error(`Unexpected dashboard request ${url}`)
  })
  assert.match(container.textContent ?? '', /Visitors/)
  assert.match(container.textContent ?? '', /Loading odds/)
  assert.deepEqual(oddsCalls, [[1]])
  const week2 = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Week 2'))
  assert(week2)
  await React.act(async () => { week2.click() })
  await settle()
  assert.deepEqual(oddsCalls, [[1], [2]])
  await React.act(async () => {
    firstOdds.resolve(json([{ game_id: 1, home_spread: -9, total: 99 }]))
  })
  await settle()
  assert.doesNotMatch(container.textContent ?? '', /O\/U 99/)
  await React.act(async () => {
    secondOdds.resolve(json([{ game_id: 2, home_spread: -3, total: 45 }]))
    discovery.resolve(json({ seasons: [{ season: 2025, current: false }, { season: 2026, current: true }] }))
  })
  await settle()
  assert.match(container.textContent ?? '', /O\/U 45/)
  assert.equal(container.querySelector<HTMLSelectElement>('.season-select select')?.value, '2026')
  assert.match(container.querySelector('.season-select select')?.textContent ?? '', /2025/)
})

it('renders a team schedule before its statistics finish and keeps cards on secondary errors', async () => {
  const stats = deferred<Response>()
  const container = await render(async (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/seasons') return json({ seasons: [] })
    if (url.pathname === '/api/analytics/llm-health') return json({ status: 'unavailable', message: 'offline' })
    if (url.pathname.endsWith('/league_seasons')) return json([{ season_year: 2026, is_current: true }])
    if (url.pathname.endsWith('/teams')) return json([{ id: 1, name: 'Visitors' }, { id: 2, name: 'Hosts' }])
    if (url.pathname.endsWith('/games')) return json(games)
    if (url.pathname.endsWith('/game_team_stats')) return stats.promise
    if (url.pathname.endsWith('/rpc/get_game_consensus_odds')) {
      return new Response(JSON.stringify({ message: 'Odds unavailable' }), { status: 500 })
    }
    throw new Error(`Unexpected dashboard request ${url}`)
  }, '/?season=2026&view=team&team=1')
  assert.equal(container.querySelectorAll('.schedule-game').length, 2)
  assert.match(container.textContent ?? '', /Loading statistics/)
  await React.act(async () => { stats.resolve(json([])) })
  await settle()
  assert.doesNotMatch(container.textContent ?? '', /Loading statistics/)
  assert.match(container.textContent ?? '', /Unable to load odds/)
  assert.equal(container.querySelectorAll('.schedule-game').length, 2)
})

it('renders live scores without waiting for odds', async () => {
  const odds = deferred<Response>()
  const container = await render(async (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/seasons') return json({ seasons: [] })
    if (url.pathname === '/api/analytics/llm-health') return json({ status: 'unavailable', message: 'offline' })
    if (url.pathname === '/api/live-games') return json({ gameIds: [1] })
    if (url.pathname.endsWith('/league_seasons')) return json([{ season_year: 2026, is_current: true }])
    if (url.pathname.endsWith('/teams')) return json([{ id: 1, name: 'Visitors' }, { id: 2, name: 'Hosts' }])
    if (url.pathname.endsWith('/games')) return json([{ ...games[0], status_short: 'Q2', home_total: 7, away_total: 10 }])
    if (url.pathname.endsWith('/game_events')) return json([])
    if (url.pathname.endsWith('/rpc/get_game_consensus_odds')) return odds.promise
    throw new Error(`Unexpected dashboard request ${url}`)
  }, '/?season=2026&view=live')
  assert.equal(container.querySelectorAll('.schedule-game').length, 1)
  assert.match(container.textContent ?? '', /Visitors/)
  assert.match(container.textContent ?? '', /Loading odds/)
  await React.act(async () => { odds.resolve(json([{ game_id: 1, home_spread: -3, total: 45 }])) })
  await settle()
  assert.match(container.textContent ?? '', /O\/U 45/)
})
