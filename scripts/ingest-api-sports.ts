import { getIngestConfig } from '../server/config'
import { ingestSeason } from '../server/ingest-core'

function readCliArg(name: string): string | null {
  const prefix = `--${name}=`
  const match = process.argv.find((argument) => argument.startsWith(prefix))
  return match ? match.slice(prefix.length) : null
}

export function parseSeason(raw: string | null, fallback = '2023') {
  const value = raw ?? fallback
  const season = Number(value)
  if (!Number.isInteger(season) || season < 1900 || season > 3000) {
    throw new Error(`Invalid season value: ${value}. Expected a 4-digit year like 2024.`)
  }
  return season
}

async function run() {
  const season = parseSeason(readCliArg('season'), process.env.API_SPORTS_SEASON)
  const summary = await ingestSeason(getIngestConfig(process.env), season)
  console.log(JSON.stringify(summary, null, 2))
}

run().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
