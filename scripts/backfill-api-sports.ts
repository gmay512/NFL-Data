import { planHistoricalBackfill, runHistoricalBackfill } from '../server/backfill-core'
import { getIngestConfig } from '../server/config'

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`)
}

function readInteger(name: string, fallback: number) {
  const prefix = `--${name}=`
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer.`)
  return value
}

async function run() {
  const config = getIngestConfig(process.env)
  const startSeason = readInteger('start-season', 2020)
  const endSeason = readInteger('end-season', 2026)
  const dailyCeiling = readInteger('daily-ceiling', 7_000)
  const dryRun = hasFlag('dry-run')

  if (!dryRun && !hasFlag('confirm-production')) {
    throw new Error('Refusing to mutate data without --confirm-production.')
  }
  const target = new URL(config.supabaseUrl ?? '')
  if (!dryRun && ['localhost', '127.0.0.1', '192.168.4.241'].includes(target.hostname)) {
    throw new Error(`Refusing to run the production backfill against local target ${target.origin}.`)
  }

  console.log(`[Backfill] Target: ${target.origin}`)
  const plan = await planHistoricalBackfill(config, startSeason, endSeason)
  console.log(JSON.stringify({
    startSeason: plan.startSeason,
    endSeason: plan.endSeason,
    estimatedRequests: plan.estimatedRequests,
    resourceCount: plan.resources.length,
    gameGaps: plan.gameGaps,
  }, null, 2))
  if (hasFlag('verbose-plan')) console.log(JSON.stringify(plan.resources, null, 2))
  if (dryRun) return

  const summary = await runHistoricalBackfill(config, plan, dailyCeiling)
  console.log(JSON.stringify({
    startingUsage: summary.startingUsage,
    endingUsage: summary.endingUsage,
    callsMade: summary.callsMade,
    complete: summary.complete,
    providerEmpty: summary.providerEmpty,
    failed: summary.failed,
    remainingGameGaps: summary.plan.gameGaps,
  }, null, 2))
  if (summary.failed) process.exitCode = 1
}

run().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
