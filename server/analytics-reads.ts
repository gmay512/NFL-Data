export class AnalyticsDatabaseError extends Error {
  readonly code: string

  constructor(stage: string, error: { message: string; code?: string }) {
    super(`${stage}: ${error.message}${error.code ? ` (code=${error.code})` : ''}`, { cause: error })
    this.name = 'AnalyticsDatabaseError'
    this.code = error.code === '57014' ? 'database_timeout' : 'database_unavailable'
  }
}

export async function readAllRows<T>(
  load: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>,
  stage: string,
) {
  const rows: T[] = []
  for (let from = 0; ; from += 1_000) {
    const { data, error } = await load(from, from + 999)
    if (error) throw new AnalyticsDatabaseError(stage, error)
    rows.push(...data ?? [])
    if ((data?.length ?? 0) < 1_000) return rows
  }
}

export class AnalyticsReadScope {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly requests = new Map<string, Promise<unknown>>()
  private active = 0
  private readonly waiting: Array<{ resume: () => void; reject: (error: unknown) => void }> = []

  constructor(signal?: AbortSignal) {
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    this.signal.addEventListener('abort', () => {
      for (const waiter of this.waiting.splice(0)) waiter.reject(this.signal.reason)
    }, { once: true })
  }

  read<T>(key: string, load: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted()
    const existing = this.requests.get(key)
    if (existing) return existing as Promise<T>
    const request = load().catch((error: unknown) => {
      this.controller.abort(error)
      throw error
    })
    this.requests.set(key, request)
    return request
  }

  async run<T>(load: () => PromiseLike<T>): Promise<T> {
    this.signal.throwIfAborted()
    if (this.active >= 2) await new Promise<void>((resolve, reject) => {
      this.waiting.push({ resume: resolve, reject })
    })
    else this.active++
    try {
      this.signal.throwIfAborted()
      return await load()
    } finally {
      const next = this.waiting.shift()
      if (next) next.resume()
      else this.active--
    }
  }
}
