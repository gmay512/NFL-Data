import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  fetchAvailableSeasons,
  ingestSeason,
  refreshGameById,
  refreshGamePlayerStatsByGameId,
  refreshGameTeamStatsByGameId,
  refreshLiveGames,
  refreshSeasonSchedule,
} from './ingest-core'

type AppEnv = Record<string, string | undefined>

function getEnv(env: AppEnv, ...names: string[]) {
  const value = names.map((name) => env[name]).find((entry) => Boolean(entry))
  if (!value) throw new Error(`Missing required env var: ${names.join(' or ')}`)
  return value
}

function getIngestConfig(env: AppEnv) {
  return {
    supabaseUrl: getEnv(env, 'SUPABASE_URL', 'VITE_SUPABASE_URL'),
    serviceRoleKey: getEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    apiKey: getEnv(env, 'API_SPORTS_KEY', 'API_Sports_KEY'),
    apiBaseUrl: env.API_SPORTS_BASE_URL,
    apiHost: env.API_SPORTS_HOST,
    leagueId: Number(env.API_SPORTS_LEAGUE_ID ?? '1'),
  }
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

export async function handleApiRequest(request: IncomingMessage, response: ServerResponse, env: AppEnv) {
  const requestUrl = new URL(request.url ?? '/', 'http://localhost')
  if (!requestUrl.pathname.startsWith('/api/')) return false

  try {
    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      sendJson(response, 200, { status: 'ok' })
      return true
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/seasons') {
      const seasons = await fetchAvailableSeasons(getIngestConfig(env))
      sendJson(response, 200, { seasons })
      return true
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/ingest-season') {
      const body = (await readJsonBody(request)) as { season?: unknown }
      const season = Number(body.season)
      if (!Number.isFinite(season)) {
        sendJson(response, 400, { error: 'A numeric season is required.' })
        return true
      }

      sendJson(response, 200, await ingestSeason(getIngestConfig(env), season))
      return true
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-season-schedule') {
      const body = (await readJsonBody(request)) as { season?: unknown }
      const season = Number(body.season)
      if (!Number.isFinite(season)) {
        sendJson(response, 400, { error: 'A numeric season is required.' })
        return true
      }

      const summary = await refreshSeasonSchedule(getIngestConfig(env), season)
      sendJson(response, 200, { season, ...summary })
      return true
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-game-team-stats') {
      const body = (await readJsonBody(request)) as { gameId?: unknown }
      const gameId = Number(body.gameId)
      if (!Number.isFinite(gameId)) {
        sendJson(response, 400, { error: 'A numeric gameId is required.' })
        return true
      }

      const rows = await refreshGameTeamStatsByGameId(getIngestConfig(env), gameId)
      sendJson(response, 200, { gameId, rowsUpserted: rows.length, rows })
      return true
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-game') {
      const body = (await readJsonBody(request)) as { gameId?: unknown }
      const gameId = Number(body.gameId)
      if (!Number.isFinite(gameId)) {
        sendJson(response, 400, { error: 'A numeric gameId is required.' })
        return true
      }

      await refreshGameById(getIngestConfig(env), gameId)
      sendJson(response, 200, { gameId })
      return true
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
        return true
      }

      const config = getIngestConfig(env)
      const [teamRows, playerRows] = await Promise.all([
        body.loadTeamStats === true ? refreshGameTeamStatsByGameId(config, gameId) : Promise.resolve([]),
        body.loadPlayerStats === true ? refreshGamePlayerStatsByGameId(config, gameId, teamId) : Promise.resolve([]),
      ])
      sendJson(response, 200, {
        gameId,
        teamStatsRowsUpserted: teamRows.length,
        playerStatsRowsUpserted: playerRows.length,
      })
      return true
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/live-games') {
      const gameIds = await refreshLiveGames(getIngestConfig(env))
      sendJson(response, 200, { gameIds })
      return true
    }

    sendJson(response, 404, { error: 'API route not found.' })
    return true
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[API Error]', error)
    sendJson(response, 500, { error: errorMessage })
    return true
  }
}
