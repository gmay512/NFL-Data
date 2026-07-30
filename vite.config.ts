import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  fetchAvailableSeasons,
  ingestSeason,
  refreshGameById,
  refreshGamePlayerStatsByGameId,
  refreshGameTeamStatsByGameId,
  refreshLiveGames,
} from './server/ingest-core'

function getEnv(env: Record<string, string>, ...names: string[]) {
  const value = names.map((name) => env[name]).find((entry) => Boolean(entry))
  if (!value) throw new Error(`Missing required env var: ${names.join(' or ')}`)
  return value
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(payload))
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      react(),
      {
        name: 'nfl-data-api',
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            try {
              const requestUrl = new URL(request.url ?? '/', 'http://localhost')

              if (request.method === 'GET' && requestUrl.pathname === '/api/seasons') {
                const seasons = await fetchAvailableSeasons({
                  supabaseUrl: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL,
                  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
                  apiKey: getEnv(env, 'API_SPORTS_KEY', 'API_Sports_KEY'),
                  apiBaseUrl: env.API_SPORTS_BASE_URL,
                  apiHost: env.API_SPORTS_HOST,
                  leagueId: Number(env.API_SPORTS_LEAGUE_ID ?? '1'),
                })

                sendJson(response, 200, { seasons })
                return
              }

              if (request.method === 'POST' && requestUrl.pathname === '/api/ingest-season') {
                const body = (await readJsonBody(request)) as { season?: unknown }
                const season = Number(body.season)
                if (!Number.isFinite(season)) {
                  sendJson(response, 400, { error: 'A numeric season is required.' })
                  return
                }

                const summary = await ingestSeason(
                  {
                    supabaseUrl: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL,
                    serviceRoleKey: getEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'),
                    apiKey: getEnv(env, 'API_SPORTS_KEY', 'API_Sports_KEY'),
                    apiBaseUrl: env.API_SPORTS_BASE_URL,
                    apiHost: env.API_SPORTS_HOST,
                    leagueId: Number(env.API_SPORTS_LEAGUE_ID ?? '1'),
                  },
                  season,
                )

                sendJson(response, 200, summary)
                return
              }

              if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-game-team-stats') {
                const body = (await readJsonBody(request)) as { gameId?: unknown }
                const gameId = Number(body.gameId)
                if (!Number.isFinite(gameId)) {
                  sendJson(response, 400, { error: 'A numeric gameId is required.' })
                  return
                }

                const rows = await refreshGameTeamStatsByGameId(
                  {
                    supabaseUrl: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL,
                    serviceRoleKey: getEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'),
                    apiKey: getEnv(env, 'API_SPORTS_KEY', 'API_Sports_KEY'),
                    apiBaseUrl: env.API_SPORTS_BASE_URL,
                    apiHost: env.API_SPORTS_HOST,
                    leagueId: Number(env.API_SPORTS_LEAGUE_ID ?? '1'),
                  },
                  gameId,
                )

                sendJson(response, 200, { gameId, rowsUpserted: rows.length, rows })
                return
              }

              if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-game') {
                const body = (await readJsonBody(request)) as { gameId?: unknown }
                const gameId = Number(body.gameId)
                if (!Number.isFinite(gameId)) {
                  sendJson(response, 400, { error: 'A numeric gameId is required.' })
                  return
                }

                await refreshGameById(
                  {
                    supabaseUrl: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL,
                    serviceRoleKey: getEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'),
                    apiKey: getEnv(env, 'API_SPORTS_KEY', 'API_Sports_KEY'),
                    apiBaseUrl: env.API_SPORTS_BASE_URL,
                    apiHost: env.API_SPORTS_HOST,
                    leagueId: Number(env.API_SPORTS_LEAGUE_ID ?? '1'),
                  },
                  gameId,
                )

                sendJson(response, 200, { gameId })
                return
              }

              if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-game-stats') {
                const body = (await readJsonBody(request)) as {
                  gameId?: unknown
                  teamId?: unknown
                  loadPlayerStats?: unknown
                  loadTeamStats?: unknown
                }
                const gameId = Number(body.gameId)
                const teamId = Number(body.teamId)
                if (!Number.isFinite(gameId) || !Number.isFinite(teamId)) {
                  sendJson(response, 400, { error: 'Numeric gameId and teamId values are required.' })
                  return
                }

                const config = {
                  supabaseUrl: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL,
                  serviceRoleKey: getEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'),
                  apiKey: getEnv(env, 'API_SPORTS_KEY', 'API_Sports_KEY'),
                  apiBaseUrl: env.API_SPORTS_BASE_URL,
                  apiHost: env.API_SPORTS_HOST,
                  leagueId: Number(env.API_SPORTS_LEAGUE_ID ?? '1'),
                }
                const [teamRows, playerRows] = await Promise.all([
                  body.loadTeamStats === true ? refreshGameTeamStatsByGameId(config, gameId) : Promise.resolve([]),
                  body.loadPlayerStats === true ? refreshGamePlayerStatsByGameId(config, gameId, teamId) : Promise.resolve([]),
                ])

                sendJson(response, 200, {
                  gameId,
                  teamStatsRowsUpserted: teamRows.length,
                  playerStatsRowsUpserted: playerRows.length,
                })
                return
              }

              if (request.method === 'POST' && requestUrl.pathname === '/api/live-games') {
                const gameIds = await refreshLiveGames({
                  supabaseUrl: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL,
                  serviceRoleKey: getEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'),
                  apiKey: getEnv(env, 'API_SPORTS_KEY', 'API_Sports_KEY'),
                  apiBaseUrl: env.API_SPORTS_BASE_URL,
                  apiHost: env.API_SPORTS_HOST,
                  leagueId: Number(env.API_SPORTS_LEAGUE_ID ?? '1'),
                })

                sendJson(response, 200, { gameIds })
                return
              }
            } catch (error) {
              let errorMessage = 'Unknown server error'
              let errorStack = undefined
              
              if (error instanceof Error) {
                errorMessage = error.message
                errorStack = error.stack
              } else if (typeof error === 'object' && error !== null) {
                errorMessage = JSON.stringify(error, null, 2)
              } else if (typeof error === 'string') {
                errorMessage = error
              }
              
              console.error('[Ingest Error]', errorMessage, errorStack)
              sendJson(response, 500, {
                error: errorMessage,
              })
              return
            }

            next()
          })
        },
      },
    ],
  }
})
