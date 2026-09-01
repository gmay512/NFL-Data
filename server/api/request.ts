import type { IncomingMessage, ServerResponse } from 'node:http'

export class RequestBodyError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'RequestBodyError'
    this.statusCode = statusCode
  }
}

export async function readJsonBody(request: IncomingMessage, maxBytes = 1_000_000) {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += buffer.length
    if (byteLength > maxBytes) {
      throw new RequestBodyError(`Request body exceeds ${maxBytes} bytes.`, 413)
    }
    chunks.push(buffer)
  }

  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RequestBodyError('JSON request body must be an object.', 400)
    }
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof RequestBodyError) throw error
    throw new RequestBodyError('Request body contains invalid JSON.', 400)
  }
}

export async function readNumericFields(
  request: IncomingMessage,
  fields: string[],
): Promise<Record<string, number> | null> {
  const body = await readJsonBody(request)
  const values = Object.fromEntries(fields.map((field) => [field, Number(body[field])]))
  return Object.values(values).every(Number.isFinite) ? values : null
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(payload))
}
