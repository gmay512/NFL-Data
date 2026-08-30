import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ScheduleGameCard } from '../src/features/dashboard/DashboardComponents'
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

function renderCard(event?: LatestGameEventRow, gameOdds?: GameOddsRow) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ScheduleGameCard, {
        game,
        dashboardPath: '/?view=live',
        latestEvent: event,
        odds: gameOdds,
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
})
