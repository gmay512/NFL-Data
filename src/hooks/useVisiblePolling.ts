import { useEffect, useRef } from 'react'

export function useVisiblePolling(callback: () => Promise<void>, enabled: boolean, intervalMs = 60_000) {
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let inFlight = false

    const run = async () => {
      if (disposed || document.hidden || inFlight) return
      inFlight = true
      try {
        await callbackRef.current()
      } finally {
        inFlight = false
      }
    }

    const intervalId = window.setInterval(() => void run(), intervalMs)
    const handleVisibilityChange = () => {
      if (!document.hidden) void run()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      disposed = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [enabled, intervalMs])
}
