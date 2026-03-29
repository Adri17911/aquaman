import { useEffect, useState } from 'react'
import { getToken } from '../auth'

export const SSE_REFETCH_EVENT = 'aqua-sse-refetch'

export type SseState = { connected: boolean; error: boolean }

const MAX_BACKOFF_MS = 30_000
const BASE_BACKOFF_MS = 2000

/** Subscribes to SSE with JWT in query; retries with exponential backoff after errors. */
export function useSSE(): SseState {
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    const token = getToken()
    if (!token) {
      setConnected(false)
      setError(true)
      return
    }

    let cancelled = false
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }

    const connect = () => {
      if (cancelled) return
      clearRetry()
      es?.close()
      const url = `/api/stream?token=${encodeURIComponent(token)}`
      es = new EventSource(url)

      es.onopen = () => {
        if (cancelled) return
        attempt = 0
        setConnected(true)
        setError(false)
      }

      es.onmessage = () => {
        window.dispatchEvent(new CustomEvent(SSE_REFETCH_EVENT))
      }

      es.onerror = () => {
        if (cancelled) return
        es?.close()
        es = null
        setConnected(false)
        setError(true)
        attempt += 1
        const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempt - 1, 4))
        retryTimer = setTimeout(connect, exp)
      }
    }

    connect()

    return () => {
      cancelled = true
      clearRetry()
      es?.close()
      setConnected(false)
    }
  }, [])

  return { connected, error }
}
