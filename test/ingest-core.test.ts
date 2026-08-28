import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mapGameEventRows } from '../server/ingest-core'

describe('game event ingestion', () => {
  it('maps the current API minute and score fields', () => {
    const result = mapGameEventRows(22705, [{
      quarter: 'Fourth',
      minute: '0:55',
      team: { id: 314 },
      player: { id: 42, name: 'M. Beason', image: 'player.png' },
      type: 'TD',
      comment: 'M. Beason run for 1 yd, for a TD',
      score: { home: 47, away: 37 },
    }])

    assert.deepEqual(result.players, [{
      id: 42,
      name: 'M. Beason',
      image_url: 'player.png',
    }])
    assert.deepEqual(result.rows, [{
      game_id: 22705,
      team_id: 314,
      player_id: 42,
      quarter: 'Fourth',
      minute: '0:55',
      event_type: 'TD',
      comment: 'M. Beason run for 1 yd, for a TD',
      score_home: 47,
      score_away: 37,
    }])
  })

  it('supports legacy time and nested scores aliases', () => {
    const result = mapGameEventRows(1, [{
      quarter: 'Second',
      time: '1:13',
      team: { id: 10 },
      type: 'FG',
      scores: { home: { total: 10 }, away: { total: 7 } },
    }])

    assert.deepEqual(result.rows[0], {
      game_id: 1,
      team_id: 10,
      player_id: null,
      quarter: 'Second',
      minute: '1:13',
      event_type: 'FG',
      comment: null,
      score_home: 10,
      score_away: 7,
    })
  })

  it('ignores rows missing required team, quarter, or event type fields', () => {
    const result = mapGameEventRows(1, [
      { quarter: 'First', type: 'TD' },
      { team: { id: 10 }, type: 'TD' },
      { team: { id: 10 }, quarter: 'First' },
    ])

    assert.deepEqual(result, { players: [], rows: [] })
  })
})
