import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatDetailGameStatus,
  formatScheduleGameDate,
  formatScheduleGameStatus,
  formatScore,
  formatScoringEventContext,
  formatScoringEventDescription,
  formatValue,
  isWinningTeam,
} from '../src/lib/game-format'
import {
  getRefreshableGameIds,
  hasLiveGameChanged,
  reconcileRowsByKey,
  selectFirstRowsByKey,
  shouldRefreshGame,
} from '../src/lib/game-sync'

describe('game refresh policy', () => {
  it('does not refresh terminal games', () => {
    for (const status_short of ['FT', 'AOT', 'CANC', 'PST']) {
      assert.equal(shouldRefreshGame({ status_short, game_timestamp: 1 }), false)
    }
  })

  describe('live game update detection', () => {
    const liveGame = {
      away_total: 14,
      home_total: 10,
      status_short: 'Q3',
      status_long: 'Third Quarter',
      status_timer: '08:42',
    }

    it('does not flag initial or unchanged games', () => {
      assert.equal(hasLiveGameChanged(undefined, liveGame), false)
      assert.equal(hasLiveGameChanged(liveGame, { ...liveGame }), false)
    })

    it('detects score changes', () => {
      assert.equal(hasLiveGameChanged(liveGame, { ...liveGame, home_total: 17 }), true)
    })

    it('detects status and quarter changes', () => {
      assert.equal(hasLiveGameChanged(liveGame, { ...liveGame, status_short: 'Q4' }), true)
      assert.equal(hasLiveGameChanged(liveGame, { ...liveGame, status_long: 'Fourth Quarter' }), true)
    })

    it('detects clock changes', () => {
      assert.equal(hasLiveGameChanged(liveGame, { ...liveGame, status_timer: '08:01' }), true)
    })
  })

  it('refreshes active games and scheduled games after kickoff', () => {
    assert.equal(shouldRefreshGame({ status_short: 'Q2', game_timestamp: null }), true)
    assert.equal(shouldRefreshGame({ status_short: 'NS', game_timestamp: 100 }, 100_000), true)
  })

  it('does not refresh future or undated scheduled games', () => {
    assert.equal(shouldRefreshGame({ status_short: 'NS', game_timestamp: 101 }, 100_000), false)
    assert.equal(shouldRefreshGame({ status_short: 'NS', game_timestamp: null }, 100_000), false)
  })

  it('selects only active and due nonterminal game ids', () => {
    const now = 100_000
    const games = [
      { id: 1, status_short: 'Q2', game_timestamp: null },
      { id: 2, status_short: 'NS', game_timestamp: 100 },
      { id: 3, status_short: 'NS', game_timestamp: 101 },
      { id: 4, status_short: 'FT', game_timestamp: 90 },
      { id: 5, status_short: 'PST', game_timestamp: 90 },
      { id: 6, status_short: 'NS', game_timestamp: null },
    ]

    assert.deepEqual(getRefreshableGameIds(games, now), [1, 2])
  })

  describe('refreshed row reconciliation', () => {
    const first = { id: 1, score: 7 }
    const second = { id: 2, score: 10 }

    it('retains the existing array and rows when nothing changed', () => {
      const previous = [first, second]
      const reconciled = reconcileRowsByKey(previous, [{ ...first }, { ...second }], 'id')

      assert.equal(reconciled, previous)
      assert.equal(reconciled[0], first)
      assert.equal(reconciled[1], second)
    })

    it('replaces only changed rows', () => {
      const changedSecond = { ...second, score: 13 }
      const reconciled = reconcileRowsByKey([first, second], [{ ...first }, changedSecond], 'id')

      assert.equal(reconciled[0], first)
      assert.equal(reconciled[1], changedSecond)
    })

    it('follows incoming additions, removals, and order', () => {
      const third = { id: 3, score: 0 }
      const reconciled = reconcileRowsByKey([first, second], [{ ...second }, third], 'id')

      assert.deepEqual(reconciled, [second, third])
      assert.equal(reconciled[0], second)
      assert.equal(reconciled[1], third)
    })
  })

  it('selects the first ordered event for each game', () => {
    const latestGameOne = { game_id: 1, event: 'latest' }
    const rows = [
      latestGameOne,
      { game_id: 2, event: 'only' },
      { game_id: 1, event: 'older' },
    ]

    assert.deepEqual(selectFirstRowsByKey(rows, 'game_id'), [latestGameOne, rows[1]])
  })
})

describe('game display formatting', () => {
  it('preserves schedule status labels', () => {
    assert.equal(formatScheduleGameStatus({ status_short: 'FT', status_long: null, status_timer: null }), 'Final')
    assert.equal(formatScheduleGameStatus({ status_short: 'HT', status_long: null, status_timer: '00:00' }), 'Half time')
    assert.equal(formatScheduleGameStatus({ status_short: 'Q3', status_long: null, status_timer: '04:12' }), 'Q3 04:12')
  })

  it('preserves detail status labels and fallbacks', () => {
    assert.equal(formatDetailGameStatus(null), 'Loading')
    assert.equal(formatDetailGameStatus({ status_short: 'PST', status_long: null, status_timer: null }), 'Postponed')
    assert.equal(formatDetailGameStatus({ status_short: null, status_long: 'Delayed', status_timer: null }), 'Delayed')
  })

  it('formats schedule dates and values', () => {
    assert.equal(formatScheduleGameDate({ game_date: null, game_time: null }), 'Date pending')
    assert.match(formatScheduleGameDate({ game_date: '2026-09-10', game_time: '20:20' }), /^Thu, Sep 10 · 8:20 PM E[DS]T$/)
    assert.equal(formatValue(''), '—')
    assert.equal(formatValue(0), '0')
    assert.equal(formatScore(null), '—')
    assert.equal(formatScore(17), 17)
  })

  it('marks a winner only for completed games', () => {
    assert.equal(isWinningTeam({ status_short: 'FT', away_total: 21, home_total: 17 }, 'away'), true)
    assert.equal(isWinningTeam({ status_short: 'Q4', away_total: 21, home_total: 17 }, 'away'), false)
    assert.equal(isWinningTeam({ status_short: 'FT', away_total: 21, home_total: 21 }, 'home'), false)
  })

  it('formats latest scoring play context and fallback text', () => {
    const event = {
      quarter: 'Fourth',
      minute: '0:55',
      event_type: 'TD',
      comment: 'Quarterback run for 1 yd, for a TD',
    }
    assert.equal(formatScoringEventContext(event), 'Q4 · 0:55')
    assert.equal(formatScoringEventDescription(event), event.comment)
    assert.equal(formatScoringEventDescription({ ...event, comment: null }), 'TD')
  })
})
