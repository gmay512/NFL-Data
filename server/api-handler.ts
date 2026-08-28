import type { IncomingMessage, ServerResponse } from 'node:http'
import { getIngestConfig, type AppEnv } from './config'
import { readJsonBody, readNumericFields, sendJson } from './api/request'
import {
  fetchAvailableSeasons,
  ingestSeason,
  refreshGameById,
  refreshGamesByIds,
  refreshGamePlayerStatsByGameId,
  refreshGameTeamStatsByGameId,
  refreshLiveGames,
  refreshSeasonGames,
  refreshSeasonSchedule,
} from './ingest-core'

function isPositiveIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((gameId) => Number.isInteger(gameId) && gameId > 0)
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
      const values = await readNumericFields(request, ['season'])
      if (!values) {
        sendJson(response, 400, { error: 'A numeric season is required.' })
        return true
      }

      sendJson(response, 200, await ingestSeason(getIngestConfig(env), values.season))
      return true
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-season-schedule') {
      const values = await readNumericFields(request, ['season'])
      if (!values) {
        sendJson(response, 400, { error: 'A numeric season is required.' })
        return true
      }

      const summary = await refreshSeasonSchedule(getIngestConfig(env), values.season)
      sendJson(response, 200, { season: values.season, ...summary })
      return true
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-season-games') {
      const body = await readJsonBody(request)
      const season = Number(body.season)
      if (!Number.isFinite(season)) {
        sendJson(response, 400, { error: 'A numeric season is required.' })
        return true
      }

      if (body.gameIds !== undefined && !isPositiveIntegerArray(body.gameIds)) {
        sendJson(response, 400, { error: 'gameIds must be an array of positive integers.' })
        return true
      }

      const config = getIngestConfig(env)
      const games =
        body.gameIds === undefined
          ? await refreshSeasonGames(config, season)
          : await refreshGamesByIds(config, body.gameIds)
      sendJson(response, 200, { season, games })
      return true
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-game-team-stats') {
      const values = await readNumericFields(request, ['gameId'])
      if (!values) {
        sendJson(response, 400, { error: 'A numeric gameId is required.' })
        return true
      }

      const rows = await refreshGameTeamStatsByGameId(getIngestConfig(env), values.gameId)
      sendJson(response, 200, { gameId: values.gameId, rowsUpserted: rows.length, rows })
      return true
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-game') {
      const values = await readNumericFields(request, ['gameId'])
      if (!values) {
        sendJson(response, 400, { error: 'A numeric gameId is required.' })
        return true
      }

      await refreshGameById(getIngestConfig(env), values.gameId)
      sendJson(response, 200, { gameId: values.gameId })
      return true
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/refresh-game-stats') {
      const body = await readJsonBody(request)
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
