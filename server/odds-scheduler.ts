import { getIngestConfig, type AppEnv } from './config'
import { refreshAvailableOdds } from './ingest-core'

const defaultRefreshIntervalMinutes = 60

type SchedulerLogger = Pick<Console, 'error' | 'info'>
type SchedulerTimer = ReturnType<typeof setInterval>

export type OddsSchedulerOptions = {
  clearInterval?: (timer: SchedulerTimer) => void
  enabled?: boolean
  intervalMs?: number
  logger?: SchedulerLogger
  refresh?: () => Promise<{ odds: number }>
  setInterval?: (callback: () => void, intervalMs: number) => SchedulerTimer
}

function isDisabled(value: string | undefined) {
  return value != null && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
}

export function getOddsRefreshIntervalMs(env: AppEnv) {
  const minutes = Number(env.ODDS_REFRESH_INTERVAL_MINUTES ?? defaultRefreshIntervalMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('ODDS_REFRESH_INTERVAL_MINUTES must be a positive number.')
  }
  return minutes * 60_000
}

export function startOddsRefreshScheduler(env: AppEnv, options: OddsSchedulerOptions = {}) {
  const logger = options.logger ?? console
  const enabled = options.enabled ?? !isDisabled(env.ODDS_AUTO_REFRESH_ENABLED)
  let inFlight: Promise<void> | null = null
  let timer: SchedulerTimer | null = null

  const runNow = () => {
    if (inFlight) {
      logger.info('[Odds Scheduler] Refresh already in progress; skipping overlapping run.')
      return inFlight
    }

    const startedAt = Date.now()
    inFlight = (async () => {
      try {
        const result = await (options.refresh ?? (() => refreshAvailableOdds(getIngestConfig(env))))()
        logger.info(`[Odds Scheduler] Refresh complete: ${result.odds} rows in ${Date.now() - startedAt}ms.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`[Odds Scheduler] Refresh failed: ${message}`)
      }
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  if (enabled) {
    const intervalMs = options.intervalMs ?? getOddsRefreshIntervalMs(env)
    const setSchedulerInterval = options.setInterval ?? setInterval
    timer = setSchedulerInterval(() => void runNow(), intervalMs)
    if ('unref' in timer) timer.unref()
    void runNow()
  } else {
    logger.info('[Odds Scheduler] Automatic refresh is disabled.')
  }

  return {
    runNow,
    stop() {
      if (!timer) return
      const clearSchedulerInterval = options.clearInterval ?? clearInterval
      clearSchedulerInterval(timer)
      timer = null
    },
  }
}
