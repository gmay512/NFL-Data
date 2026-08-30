import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GameOddsDisplay } from '../src/features/odds/GameOddsDisplay'
import { formatConsensusSpread, formatConsensusTotal } from '../src/lib/odds-format'
import type { GameOddsRow } from '../src/types/nfl'

(globalThis as typeof globalThis & { React: typeof React }).React = React

const odds = {
  game_id: 12,
  home_spread: -2.5,
  total: 44.5,
} satisfies GameOddsRow

describe('consensus odds display', () => {
  it('formats the favored team and full-game total', () => {
    assert.equal(formatConsensusSpread(odds, 'Bills', 'Chiefs'), 'Chiefs -2.5')
    assert.equal(formatConsensusTotal(odds), 'O/U 44.5')
    assert.equal(formatConsensusSpread({ ...odds, home_spread: 3 }, 'Bills', 'Chiefs'), 'Bills -3')
    assert.equal(formatConsensusSpread({ ...odds, home_spread: 0 }), "Pick'em")
  })

  it('renders both values on the detail surface', () => {
    const markup = renderToStaticMarkup(createElement(GameOddsDisplay, {
      odds,
      awayTeamName: 'Bills',
      homeTeamName: 'Chiefs',
      variant: 'detail',
    }))

    assert.match(markup, /Consensus game odds/)
    assert.match(markup, /Chiefs -2.5/)
    assert.match(markup, /O\/U 44.5/)
  })

  it('renders nothing when no consensus is available', () => {
    assert.equal(renderToStaticMarkup(createElement(GameOddsDisplay, {})), '')
  })
})
