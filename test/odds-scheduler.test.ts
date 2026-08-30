import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getOddsRefreshIntervalMs, startOddsRefreshScheduler } from '../server/odds-scheduler'

type Deferred = {
  promise: Promise<{ odds: number }>
  resolve: (value: { odds: number }) => void
}

function deferred(): Deferred {
  let resolve!: Deferred['resolve']
  const promise = new Promise<{ odds: number }>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function schedulerHarness(refresh: () => Promise<{ odds: number }>) {
  let tick: (() => void) | undefined
  let cleared = false
  const messages: string[] = []
  const scheduler = startOddsRefreshScheduler({}, {
    refresh,
    intervalMs: 1_000,
    setInterval: (callback) => {
      tick = callback
      return { unref() {} } as NodeJS.Timeout
    },
    clearInterval: () => {
      cleared = true
    },
    logger: {
      error: (message) => messages.push(String(message)),
      info: (message) => messages.push(String(message)),
    },
  })
  return {
    get cleared() {
      return cleared
    },
    messages,
    scheduler,
    tick: () => tick?.(),
  }
}

describe('odds refresh scheduler', () => {
  it('uses an hourly default and validates overrides', () => {
    assert.equal(getOddsRefreshIntervalMs({}), 60 * 60_000)
    assert.equal(getOddsRefreshIntervalMs({ ODDS_REFRESH_INTERVAL_MINUTES: '15' }), 15 * 60_000)
    assert.throws(
      () => getOddsRefreshIntervalMs({ ODDS_REFRESH_INTERVAL_MINUTES: '0' }),
      /must be a positive number/,
    )
  })

  it('runs immediately, repeats on the interval, and stops cleanly', async () => {
    let calls = 0
    const harness = schedulerHarness(async () => ({ odds: ++calls }))

    await harness.scheduler.runNow()
    assert.equal(calls, 1)
    harness.tick()
    await harness.scheduler.runNow()
    assert.equal(calls, 2)
    harness.scheduler.stop()
    assert.equal(harness.cleared, true)
  })

  it('prevents overlap and resumes after a failed run', async () => {
    const firstRun = deferred()
    let calls = 0
    const harness = schedulerHarness(() => {
      calls += 1
      if (calls === 1) return firstRun.promise
      if (calls === 2) return Promise.reject(new Error('temporary provider error'))
      return Promise.resolve({ odds: 4 })
    })

    harness.tick()
    assert.equal(calls, 1)
    firstRun.resolve({ odds: 2 })
    await harness.scheduler.runNow()

    harness.tick()
    await harness.scheduler.runNow()
    assert.equal(calls, 2)
    assert.equal(harness.messages.some((message) => message.includes('temporary provider error')), true)

    harness.tick()
    await harness.scheduler.runNow()
    assert.equal(calls, 3)
  })

  it('can be disabled through the environment', () => {
    let calls = 0
    const scheduler = startOddsRefreshScheduler({ ODDS_AUTO_REFRESH_ENABLED: 'false' }, {
      refresh: async () => ({ odds: ++calls }),
      logger: { error() {}, info() {} },
    })

    assert.equal(calls, 0)
    scheduler.stop()
  })
})
