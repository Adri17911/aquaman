import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

export type ToastKind = 'success' | 'error' | 'info'

type ToastItem = { id: number; kind: ToastKind; message: string; durationMs: number }

const DEFAULT_DURATION_MS = 4800

const ToastContext = createContext<{
  toast: (message: string, kind?: ToastKind, durationMs?: number) => void
} | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    return (_message: string, _kind?: ToastKind, _durationMs?: number) => {
      /* no-op outside provider */
    }
  }
  return ctx.toast
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const toast = useCallback((message: string, kind: ToastKind = 'info', durationMs = DEFAULT_DURATION_MS) => {
    const id = Date.now() + Math.random()
    const ms = Math.max(1200, Math.min(durationMs, 20000))
    setItems((x) => [...x, { id, kind, message, durationMs: ms }])
    window.setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), ms)
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex max-w-sm flex-col gap-2"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg ${
              t.kind === 'success'
                ? 'border-emerald-700 bg-emerald-950/95 text-emerald-100'
                : t.kind === 'error'
                  ? 'border-rose-700 bg-rose-950/95 text-rose-100'
                  : 'border-slate-600 bg-slate-900/95 text-slate-200'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
