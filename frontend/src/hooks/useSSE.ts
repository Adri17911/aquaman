import { useEffect } from 'react'

export const SSE_REFETCH_EVENT = 'aqua-sse-refetch'

export function useSSE() {
  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = () => {
      window.dispatchEvent(new CustomEvent(SSE_REFETCH_EVENT))
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [])
}
