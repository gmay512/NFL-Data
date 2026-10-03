import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'

export function captureAnalyticsExpiries(context: TestContext) {
  const schedule = globalThis.setTimeout
  const cancel = globalThis.clearTimeout
  const timers = new Map<ReturnType<typeof setTimeout>, { delay: number; run: () => void }>()
  context.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const handle = schedule(callback, delay, ...args)
    if (delay === 5_000 || delay === 60_000 || delay === 300_000) {
      timers.set(handle, { delay, run: () => callback(...args) })
    }
    return handle
  })
  context.mock.method(globalThis, 'clearTimeout', (handle: Parameters<typeof clearTimeout>[0]) => {
    if (handle && typeof handle === 'object') timers.delete(handle)
    cancel(handle)
  })
  context.after(() => {
    for (const handle of timers.keys()) cancel(handle)
  })
  return (delay: number) => {
    const pending = [...timers].filter(([, timer]) => timer.delay === delay)
    assert(pending.length, `No Analytics expiry scheduled for ${delay}ms`)
    for (const [handle, timer] of pending) {
      clearTimeout(handle)
      timer.run()
    }
  }
}

export function deferredAnalyticsReads(source: typeof fetch) {
  const held = new Set<string>()
  const pending: {
    path: string
    input: RequestInfo | URL
    init?: RequestInit
    resolve: (response: Response) => void
  }[] = []
  const counts = new Map<string, number>()
  return {
    counts,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      counts.set(path, (counts.get(path) ?? 0) + 1)
      if (!held.has(path)) return source(input, init)
      return new Promise<Response>((resolve) => { pending.push({ path, input, init, resolve }) })
    },
    hold: (...paths: string[]) => paths.forEach((path) => held.add(path)),
    complete: async (path: string, response?: Response) => {
      held.delete(path)
      const requests = pending.filter((request) => request.path === path)
      assert(requests.length, `No pending Analytics read for ${path}`)
      for (const request of requests) {
        pending.splice(pending.indexOf(request), 1)
        request.resolve(response?.clone() ?? await source(request.input, request.init))
      }
    },
  }
}
