import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

type ReadState<T> = {
  data: T | null
  error: Error | null
  updatedAt: number
  loading: boolean
  refreshing: boolean
  revision: number
}
type Entry = {
  state: ReadState<unknown>
  listeners: Set<() => void>
  controller: AbortController | null
  request: Promise<void> | null
  expiry: ReturnType<typeof setTimeout> | null
}

const entries = new Map<string, Entry>()
const disabled: ReadState<never> = { data: null, error: null, updatedAt: 0, loading: false, refreshing: false, revision: 0 }

export function analyticsKey(name: string, values: object = {}) {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sorted(item)]))
    }
    return value
  }
  return `${name}:${JSON.stringify(sorted(values))}`
}

function entryFor(key: string) {
  let entry = entries.get(key)
  if (!entry) {
    if (entries.size >= 64) {
      for (const [oldKey, old] of entries) {
        if (!old.listeners.size && !old.request) {
          entries.delete(oldKey)
          if (old.expiry) clearTimeout(old.expiry)
          break
        }
      }
    }
    entry = { state: { ...disabled, loading: true }, listeners: new Set(), controller: null, request: null, expiry: null }
    entries.set(key, entry)
  }
  return entry
}

function publish(entry: Entry, state: ReadState<unknown>) {
  entry.state = state
  entry.listeners.forEach((listener) => listener())
}

export function invalidateAnalyticsReads(prefix = '', options: { preserveData?: boolean } = {}) {
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix)) continue
    if (options.preserveData && key === 'health' && prefix !== 'health') continue
    entry.controller?.abort()
    if (entry.expiry) clearTimeout(entry.expiry)
    entry.request = null
    const data = options.preserveData ? entry.state.data : null
    publish(entry, {
      ...disabled, data, loading: data == null, refreshing: data != null,
      revision: entry.state.revision + 1,
    })
  }
}

export function seedAnalyticsRead<T>(key: string, data: T) {
  const entry = entryFor(key)
  entry.controller?.abort()
  entry.request = null
  publish(entry, { ...entry.state, data, error: null, updatedAt: Date.now(), loading: false, refreshing: false })
  expire(entry, 60_000)
}

function expire(entry: Entry, ttl: number, retainExpired = true) {
  if (entry.expiry) clearTimeout(entry.expiry)
  entry.expiry = setTimeout(() => {
    entry.expiry = null
    const data = retainExpired ? entry.state.data : null
    publish(entry, {
      ...entry.state, data, updatedAt: 0, loading: data == null, refreshing: data != null,
      revision: entry.state.revision + 1,
    })
  }, ttl)
  const handle: unknown = entry.expiry
  if (handle && typeof handle === 'object' && 'unref' in handle && typeof handle.unref === 'function') handle.unref()
}

async function start<T>(entry: Entry, load: (signal: AbortSignal) => Promise<T>, ttl: number, retainExpired: boolean) {
  if (entry.request) return entry.request
  const controller = new AbortController()
  entry.controller = controller
  const hasData = entry.state.data != null
  publish(entry, { ...entry.state, error: null, loading: !hasData, refreshing: hasData })
  const request = Promise.resolve().then(() => load(controller.signal)).then((data) => {
    if (controller.signal.aborted) return
    publish(entry, { ...entry.state, data, error: null, updatedAt: Date.now(), loading: false, refreshing: false })
    expire(entry, ttl, retainExpired)
  }).catch((error: unknown) => {
    if (controller.signal.aborted) return
    publish(entry, {
      ...entry.state, error: error instanceof Error ? error : new Error(String(error)),
      loading: false, refreshing: false,
    })
  }).finally(() => {
    if (entry.request === request) {
      entry.request = null
      entry.controller = null
    }
  })
  entry.request = request
  return request
}

export function useAnalyticsRead<T>(
  key: string | null, load: (signal: AbortSignal) => Promise<T>, ttl = 60_000,
  options: { retainExpired?: boolean } = {},
) {
  const retainExpired = options.retainExpired ?? true
  const loader = useRef(load)
  useEffect(() => { loader.current = load })
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => {}
    const entry = entryFor(key)
    entry.listeners.add(listener)
    return () => {
      entry.listeners.delete(listener)
      queueMicrotask(() => {
        if (!entry.listeners.size) {
          entry.controller?.abort()
          entry.request = null
          entry.controller = null
        }
      })
    }
  }, [key])
  const getSnapshot = useCallback(() => key ? entryFor(key).state : disabled, [key])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as ReadState<T>
  useEffect(() => {
    if (key) void start(entryFor(key), (signal) => loader.current(signal), ttl, retainExpired)
  }, [key, ttl, retainExpired, state.revision])
  const retry = useCallback(() => {
    if (!key) return
    const entry = entryFor(key)
    publish(entry, { ...entry.state, revision: entry.state.revision + 1 })
  }, [key])
  return { data: state.data, error: state.error, isLoading: state.loading, isRefreshing: state.refreshing, retry }
}
