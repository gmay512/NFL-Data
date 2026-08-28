import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import { handleApiRequest } from '../server/api-handler'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function request(path: string, method = 'GET', body?: unknown) {
  const server = createServer(async (incoming, response) => {
    if (!(await handleApiRequest(incoming, response, {}))) {
      response.writeHead(404).end()
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')

  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('API handler contracts', () => {
  it('returns the stable health response', async () => {
    const response = await request('/api/health')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
  })

  it('rejects invalid numeric request fields before reading ingest configuration', async () => {
    const seasonResponse = await request('/api/ingest-season', 'POST', { season: 'invalid' })
    assert.equal(seasonResponse.status, 400)
    assert.deepEqual(await seasonResponse.json(), { error: 'A numeric season is required.' })

    const statsResponse = await request('/api/refresh-game-stats', 'POST', { gameId: 1 })
    assert.equal(statsResponse.status, 400)
    assert.deepEqual(await statsResponse.json(), { error: 'Numeric gameId and teamId values are required.' })

    const gameIdsResponse = await request('/api/refresh-season-games', 'POST', {
      season: 2026,
      gameIds: [1, 'invalid'],
    })
    assert.equal(gameIdsResponse.status, 400)
    assert.deepEqual(await gameIdsResponse.json(), { error: 'gameIds must be an array of positive integers.' })
  })

  it('preserves API not-found and non-API pass-through behavior', async () => {
    const response = await request('/api/not-a-route')
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'API route not found.' })

    const nonApiResponse = await request('/not-api')
    assert.equal(nonApiResponse.status, 404)
  })
})
