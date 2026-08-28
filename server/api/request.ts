import type { IncomingMessage, ServerResponse } from 'node:http'

export async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) as Record<string, unknown> : {}
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
