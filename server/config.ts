import type { IngestConfig } from './ingest-core'

export type AppEnv = Record<string, string | undefined>

export function getRequiredEnv(env: AppEnv, ...names: string[]) {
  const value = names.map((name) => env[name]).find((entry) => Boolean(entry))
  if (!value) throw new Error(`Missing required env var: ${names.join(' or ')}`)
  return value
}

export function getIngestConfig(env: AppEnv): IngestConfig {
  return {
    supabaseUrl: getRequiredEnv(env, 'SUPABASE_URL', 'VITE_SUPABASE_URL'),
    serviceRoleKey: getRequiredEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    apiKey: getRequiredEnv(env, 'API_SPORTS_KEY', 'API_Sports_KEY'),
    apiBaseUrl: env.API_SPORTS_BASE_URL,
    apiHost: env.API_SPORTS_HOST,
    leagueId: Number(env.API_SPORTS_LEAGUE_ID ?? '1'),
    apiRequestsPerMinute: Number(env.API_SPORTS_REQUESTS_PER_MINUTE ?? '240'),
  }
}
