import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import {
  GameAnalysisModal,
  ScheduleGameCard,
} from '../src/features/dashboard/DashboardComponents'
import type { AnalysisSession } from '../src/api/contracts'
import { getGameAnalysisPreset } from '../src/lib/game-format'
import type { GameOddsRow, GameRow, LatestGameEventRow } from '../src/types/nfl'

(globalThis as typeof globalThis & { React: typeof React }).React = React

const game = {
  id: 1,
  away_team_id: 10,
  home_team_id: 20,
  away_total: 13,
  home_total: 7,
  game_date: '2026-08-27',
  game_time: '20:00',
  stage: 'Regular Season',
  week: '1',
  status_short: 'Q2',
  status_long: 'Second Quarter',
  status_timer: '1:13',
} as GameRow

const latestEvent = {
  game_id: 1,
  team_id: 10,
  player_id: null,
  quarter: 'Second',
  minute: '1:13',
  event_type: 'TD',
  comment: 'Quarterback pass for 56 yds, for a TD',
  score_home: 7,
  score_away: 13,
} satisfies LatestGameEventRow

const odds = {
  game_id: 1,
  home_spread: -3.5,
  total: 47.5,
} satisfies GameOddsRow

function renderCard(
  event?: LatestGameEventRow,
  gameOdds?: GameOddsRow,
  cardGame: GameRow = game,
  withAnalysis = false,
) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ScheduleGameCard, {
        game: cardGame,
        dashboardPath: '/?view=live',
        latestEvent: event,
        odds: gameOdds,
        onAnalyze: withAnalysis ? () => {} : undefined,
      }),
    ),
  )
}

describe('live game card', () => {
  it('shows the latest scoring play when supplied', () => {
    const markup = renderCard(latestEvent)

    assert.match(markup, /Latest scoring play/)
    assert.match(markup, /Q2 · 1:13/)
    assert.match(markup, /Quarterback pass for 56 yds, for a TD/)
  })

  it('does not add an event footer without a scoring event', () => {
    assert.doesNotMatch(renderCard(), /Latest scoring play/)
  })

  it('shows consensus odds without bookmaker details', () => {
    const markup = renderCard(undefined, odds)

    assert.match(markup, /Home -3.5/)
    assert.match(markup, /O\/U 47.5/)
    assert.doesNotMatch(markup, /bookmaker/i)
  })

  it('offers analysis only for scheduled and completed games when enabled', () => {
    const scheduled = { ...game, status_short: 'NS', status_long: 'Not Started' }
    const completed = { ...game, status_short: 'FT', status_long: 'Finished' }

    assert.equal(getGameAnalysisPreset(scheduled), 'matchup_preview')
    assert.equal(getGameAnalysisPreset(completed), 'game_review')
    assert.equal(getGameAnalysisPreset(game), null)
    assert.match(renderCard(undefined, undefined, scheduled, true), /Analyze matchup/)
    assert.match(renderCard(undefined, undefined, completed, true), /Analyze matchup/)
    assert.doesNotMatch(renderCard(undefined, undefined, game, true), /Analyze matchup/)
    assert.doesNotMatch(renderCard(undefined, undefined, scheduled), /Analyze matchup/)
  })
})

describe('game analysis modal', () => {
  const session = {
    id: '99000000-0000-4000-8000-000000000001',
    title: 'Visitors at Hosts preview',
    preset: 'matchup_preview',
    filters: { season: 2026, gameId: 1 },
    context: {} as AnalysisSession['context'],
    model: 'qwen3-coder-next',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    messages: [{
      id: 1,
      role: 'assistant',
      content: 'The teams enter with contrasting current-season form.',
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      createdAt: '2026-09-02T00:00:00.000Z',
    }],
  } satisfies AnalysisSession

  function renderModal(props: Partial<React.ComponentProps<typeof GameAnalysisModal>> = {}) {
    return renderToStaticMarkup(createElement(
      MemoryRouter,
      null,
      createElement(GameAnalysisModal, {
        title: session.title,
        preset: 'matchup_preview',
        session: null,
        isLoading: false,
        error: null,
        onClose: () => {},
        onRetry: () => {},
        ...props,
      }),
    ))
  }

  it('renders loading, error, and saved-result states', () => {
    assert.match(renderModal({ isLoading: true }), /Analyzing matchup/)
    assert.match(renderModal({ error: 'Model unavailable.' }), /Retry analysis/)

    const result = renderModal({ session })
    assert.match(result, /contrasting current-season form/)
    assert.match(result, /Open full conversation/)
    assert.match(result, new RegExp(`/analytics\\?session=${session.id}`))
    assert.match(result, /aria-modal="true"/)
  })
})
