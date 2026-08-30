import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApiRequest } from './api-handler'
import { startOddsRefreshScheduler } from './odds-scheduler'

const serverDirectory = path.dirname(fileURLToPath(import.meta.url))
const distDirectory = path.resolve(serverDirectory, '../dist')
const indexPath = path.join(distDirectory, 'index.html')
const port = Number(process.env.PORT ?? '3000')
const host = process.env.HOST ?? '0.0.0.0'

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

async function sendFile(response: ServerResponse, filePath: string, headOnly: boolean) {
  const fileStat = await stat(filePath)
  response.statusCode = 200
  response.setHeader('Content-Length', fileStat.size)
  response.setHeader('Content-Type', contentTypes[path.extname(filePath)] ?? 'application/octet-stream')
  if (headOnly) {
    response.end()
    return
  }
  createReadStream(filePath).pipe(response)
}

const server = createServer(async (request, response) => {
  if (await handleApiRequest(request, response, process.env)) return

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end('Method Not Allowed')
    return
  }

  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    const requestedPath = path.resolve(distDirectory, `.${pathname}`)
    const isInsideDist = requestedPath === distDirectory || requestedPath.startsWith(`${distDirectory}${path.sep}`)
    if (!isInsideDist) {
      response.writeHead(400).end('Bad Request')
      return
    }

    const requestedStat = await stat(requestedPath).catch(() => null)
    const filePath = requestedStat?.isFile() ? requestedPath : indexPath
    await sendFile(response, filePath, request.method === 'HEAD')
  } catch (error) {
    console.error('[Static Server Error]', error)
    response.writeHead(500).end('Internal Server Error')
  }
})

server.listen(port, host, () => {
  console.log(`NFL Data listening on http://${host}:${port}`)
  startOddsRefreshScheduler(process.env)
})
