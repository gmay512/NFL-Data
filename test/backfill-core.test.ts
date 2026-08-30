import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseApiUsage } from '../server/backfill-core'

describe('historical backfill quota accounting', () => {
  it('parses request usage from the status response object', () => {
    assert.deepEqual(parseApiUsage({
      response: {
        requests: {
          current: 1499,
          limit_day: 7500,
        },
      },
    }), {
      current: 1499,
      limitDay: 7500,
    })
  })

  it('rejects missing and inconsistent quota values', () => {
    assert.throws(() => parseApiUsage({ requests: { current: 1, limit_day: 7500 } }))
    assert.throws(() => parseApiUsage({
      response: { requests: { current: 7501, limit_day: 7500 } },
    }))
  })
})
