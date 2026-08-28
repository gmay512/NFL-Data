import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatDetailGameStatus,
  formatScheduleGameDate,
  formatScheduleGameStatus,
  formatScore,
  formatValue,
  isWinningTeam,
} from '../src/lib/game-format'
import { shouldRefreshGame } from '../src/lib/game-sync'

describe('game refresh policy', () => {
  it('does not refresh terminal games', () => {
    for (const status_short of ['FT', 'AOT', 'CANC', 'PST']) {
      assert.equal(shouldRefreshGame({ status_short, game_timestamp: 1 }), false)
    }
  })

  it('refreshes active games and scheduled games after kickoff', () => {
    assert.equal(shouldRefreshGame({ status_short: 'Q2', game_timestamp: null }), true)
    assert.equal(shouldRefreshGame({ status_short: 'NS', game_timestamp: 100 }, 100_000), true)
  })

  it('does not refresh future or undated scheduled games', () => {
    assert.equal(shouldRefreshGame({ status_short: 'NS', game_timestamp: 101 }, 100_000), false)
    assert.equal(shouldRefreshGame({ status_short: 'NS', game_timestamp: null }, 100_000), false)
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
})
