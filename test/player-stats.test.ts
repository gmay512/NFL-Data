import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  classifyPlayerStatGroup,
  compareStatValues,
  getPlayerStatCategory,
  getPlayerStatGroupOrder,
  getPlayerUnit,
  sortPlayerStatRows,
} from '../src/lib/player-stats'

describe('player stat classification', () => {
  it('preserves game detail categories and ordering', () => {
    assert.equal(getPlayerStatCategory('Passing'), 'offense')
    assert.equal(getPlayerStatCategory('Kick Returns'), 'specialTeams')
    assert.equal(getPlayerStatCategory('Tackles'), 'defense')
    assert.ok(getPlayerStatGroupOrder('Passing', 'offense') < getPlayerStatGroupOrder('Receiving', 'offense'))
  })

  describe('player stat sorting', () => {
    it('sorts fully numeric values numerically in both directions', () => {
      assert.ok(compareStatValues('9', '10', 'ascending') < 0)
      assert.ok(compareStatValues('9', '10', 'descending') > 0)
      assert.ok(compareStatValues('-1.5', '0', 'ascending') < 0)
    })

    it('sorts non-numeric values as case-insensitive text', () => {
      assert.ok(compareStatValues('Alpha', 'beta', 'ascending') < 0)
      assert.ok(compareStatValues('Alpha', 'beta', 'descending') > 0)
      assert.ok(compareStatValues('45%', '8%', 'ascending') < 0)
    })

    it('keeps missing values last in both directions', () => {
      assert.ok(compareStatValues(null, '10', 'ascending') > 0)
      assert.ok(compareStatValues('', '10', 'descending') > 0)
      assert.equal(compareStatValues('  ', undefined, 'ascending'), 0)
    })

    it('uses player name and id as deterministic tie-breakers', () => {
      const rows = [
        { playerId: 2, playerName: 'Bravo', stats: new Map([['Yards', '10']]) },
        { playerId: 3, playerName: 'Alpha', stats: new Map([['Yards', '10']]) },
        { playerId: 1, playerName: 'Alpha', stats: new Map([['Yards', '10']]) },
      ]

      assert.deepEqual(
        sortPlayerStatRows(rows, { type: 'stat', statName: 'Yards' }, 'ascending').map((row) => row.playerId),
        [1, 3, 2],
      )
      assert.deepEqual(
        sortPlayerStatRows(rows, { type: 'player' }, 'descending').map((row) => row.playerId),
        [2, 1, 3],
      )
    })
  })

  it('preserves team detail group fallbacks', () => {
    assert.equal(classifyPlayerStatGroup('Rushing'), 'offense')
    assert.equal(classifyPlayerStatGroup('Sacks'), 'defense')
    assert.equal(classifyPlayerStatGroup('Unknown'), 'specialTeams')
  })

  it('maps roster position groups', () => {
    assert.equal(getPlayerUnit('Offence'), 'offense')
    assert.equal(getPlayerUnit('Defense'), 'defense')
    assert.equal(getPlayerUnit('Special Teams'), 'specialTeams')
    assert.equal(getPlayerUnit(null), null)
  })
})
