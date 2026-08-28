import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  classifyPlayerStatGroup,
  getPlayerStatCategory,
  getPlayerStatGroupOrder,
  getPlayerUnit,
} from '../src/lib/player-stats'

describe('player stat classification', () => {
  it('preserves game detail categories and ordering', () => {
    assert.equal(getPlayerStatCategory('Passing'), 'offense')
    assert.equal(getPlayerStatCategory('Kick Returns'), 'specialTeams')
    assert.equal(getPlayerStatCategory('Tackles'), 'defense')
    assert.ok(getPlayerStatGroupOrder('Passing', 'offense') < getPlayerStatGroupOrder('Receiving', 'offense'))
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
