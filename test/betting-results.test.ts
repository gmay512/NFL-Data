import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { gradeBettingResult, type BettingResultInput } from '../src/lib/betting-results'

const completedGame = {
  awayScore: 20,
  closingHomeSpread: -3.5,
  closingTotal: 44.5,
  homeScore: 27,
  statusShort: 'FT',
} satisfies BettingResultInput

describe('betting result grading', () => {
  it('grades a home favorite cover and an over', () => {
    assert.deepEqual(gradeBettingResult(completedGame), {
      finalTotal: 47,
      homeMargin: 7,
      isCompleted: true,
      spread: { delta: 3.5, line: -3.5, result: 'home_cover' },
      total: { delta: 2.5, line: 44.5, result: 'over' },
    })
  })

  it('grades a home underdog cover despite a loss', () => {
    const result = gradeBettingResult({
      ...completedGame,
      awayScore: 21,
      closingHomeSpread: 3,
      closingTotal: 42,
      homeScore: 20,
    })

    assert.deepEqual(result.spread, { delta: 2, line: 3, result: 'home_cover' })
    assert.deepEqual(result.total, { delta: -1, line: 42, result: 'under' })
  })

  it('grades the away team against a favorite that misses the spread', () => {
    const result = gradeBettingResult({
      ...completedGame,
      awayScore: 24,
      closingHomeSpread: -7,
      closingTotal: 50.5,
      homeScore: 27,
    })

    assert.deepEqual(result.spread, { delta: -4, line: -7, result: 'away_cover' })
    assert.deepEqual(result.total, { delta: 0.5, line: 50.5, result: 'over' })
  })

  it('handles pick em lines and tied final scores', () => {
    const homeWin = gradeBettingResult({ ...completedGame, closingHomeSpread: 0 })
    assert.deepEqual(homeWin.spread, { delta: 7, line: 0, result: 'home_cover' })

    const tie = gradeBettingResult({
      ...completedGame,
      awayScore: 24,
      closingHomeSpread: 0,
      closingTotal: 48,
      homeScore: 24,
    })
    assert.deepEqual(tie.spread, { delta: 0, line: 0, result: 'push' })
  })

  it('grades whole-number spread and total pushes', () => {
    const result = gradeBettingResult({
      ...completedGame,
      awayScore: 21,
      closingHomeSpread: -3,
      closingTotal: 45,
      homeScore: 24,
    })

    assert.deepEqual(result.spread, { delta: 0, line: -3, result: 'push' })
    assert.deepEqual(result.total, { delta: 0, line: 45, result: 'push' })
  })

  it('grades completed overtime finals', () => {
    const result = gradeBettingResult({
      ...completedGame,
      awayScore: 24,
      closingHomeSpread: '-2.5',
      closingTotal: '51.5',
      homeScore: 30,
      statusShort: 'aot',
    })

    assert.equal(result.isCompleted, true)
    assert.deepEqual(result.spread, { delta: 3.5, line: -2.5, result: 'home_cover' })
    assert.deepEqual(result.total, { delta: 2.5, line: 51.5, result: 'over' })
  })

  it('leaves individual markets ungraded when their line is absent or invalid', () => {
    const missingSpread = gradeBettingResult({
      ...completedGame,
      closingHomeSpread: null,
    })
    assert.deepEqual(missingSpread.spread, { delta: null, line: null, result: 'ungraded' })
    assert.equal(missingSpread.total.result, 'over')

    for (const closingTotal of ['', 'Over 44.5', Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalidTotal = gradeBettingResult({ ...completedGame, closingTotal })
      assert.deepEqual(invalidTotal.total, { delta: null, line: null, result: 'ungraded' })
      assert.equal(invalidTotal.spread.result, 'home_cover')
    }
  })

  it('does not grade unfinished games or completed games without both scores', () => {
    for (const game of [
      { ...completedGame, statusShort: 'Q4' },
      { ...completedGame, homeScore: null },
      { ...completedGame, awayScore: null },
    ]) {
      assert.deepEqual(gradeBettingResult(game), {
        finalTotal: null,
        homeMargin: null,
        isCompleted: false,
        spread: { delta: null, line: -3.5, result: 'ungraded' },
        total: { delta: null, line: 44.5, result: 'ungraded' },
      })
    }
  })
})
