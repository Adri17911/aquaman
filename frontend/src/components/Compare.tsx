import { useCallback, useEffect, useState } from 'react'
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  Brush,
  ComposedChart,
} from 'recharts'
import { getTelemetryMultiDevice } from '../api'
import type { ApiDevice } from '../api'
import { useToast } from '../contexts/ToastContext'

const RANGES = [1, 6, 24, 168, 8760] as const
const COMPARE_COLORS = ['#22d3ee', '#38bdf8', '#fbbf24', '#34d399', '#a78bfa', '#f472b6', '#a3e635']

function bucketForRangeHours(rangeHours: number): string {
  if (rangeHours <= 1) return '1m'
  if (rangeHours <= 6) return '5m'
  if (rangeHours <= 24) return '15m'
  if (rangeHours <= 168) return '1h'
  return '1d'
}

interface SeriesRow {
  id: string
  deviceId: string
  metric: string
}

const METRIC_OPTS = [
  { id: 'temp', label: 'Temp °C' },
  { id: 'humidity', label: 'RH %' },
  { id: 'lux', label: 'Lux' },
  { id: 'water_voltage', label: 'Water V' },
  { id: 'led_brightness', label: 'LED %' },
]

function buildSpec(series: SeriesRow[]): string {
  const byDevice = new Map<string, string[]>()
  for (const s of series) {
    if (!s.deviceId || !s.metric) continue
    const list = byDevice.get(s.deviceId) ?? []
    if (!list.includes(s.metric)) list.push(s.metric)
    byDevice.set(s.deviceId, list)
  }
  return [...byDevice.entries()]
    .map(([id, metrics]) => `${id}:${metrics.join(',')}`)
    .filter(Boolean)
    .join('|')
}

interface CompareProps {
  devices: ApiDevice[] | null
}

export function Compare({ devices }: CompareProps) {
  const toast = useToast()
  const [series, setSeries] = useState<SeriesRow[]>([])
  const [rangeHours, setRangeHours] = useState(24)
  const [chartData, setChartData] = useState<Array<Record<string, string | number | null>>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadChart = useCallback(async () => {
    const spec = buildSpec(series)
    if (!spec || !devices?.length) {
      setChartData([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const to = new Date()
      const from = new Date(to.getTime() - rangeHours * 60 * 60 * 1000)
      const bucket = bucketForRangeHours(rangeHours)
      const res = await getTelemetryMultiDevice(
        spec,
        from.toISOString(),
        to.toISOString(),
        bucket,
        2000
      )
      const isLongRange = rangeHours >= 168
      const points = (res.points || []).map((p: Record<string, string | number | null>) => {
        const ts = p.ts as string
        const tsFormatted = isLongRange
          ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: rangeHours >= 8760 ? '2-digit' : undefined })
          : new Date(ts).toLocaleTimeString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        return { ...p, ts: tsFormatted, tsRaw: ts }
      })
      setChartData(points)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load'
      setError(msg)
      setChartData([])
      toast(`Compare chart: ${msg}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [series, rangeHours, devices?.length])

  useEffect(() => {
    loadChart()
  }, [loadChart])

  const addSeries = () => {
    const firstId = devices?.[0]?.device_id ?? ''
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `series-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setSeries((prev) => [...prev, { id, deviceId: firstId, metric: 'temp' }])
  }

  const removeSeries = (id: string) => {
    setSeries((prev) => prev.filter((s) => s.id !== id))
  }

  const updateSeries = (id: string, patch: Partial<SeriesRow>) => {
    setSeries((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  const dataKeys = chartData.length > 0 ? Object.keys(chartData[0]).filter((k) => k !== 'ts' && k !== 'tsRaw') : []

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <h2 className="mb-3 font-display text-sm font-medium text-slate-300">Compare devices</h2>
        <p className="mb-4 text-xs text-slate-500">
          Add one or more series (device + metric) to plot time-aligned data from multiple devices (e.g. room temp vs tank temp).
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Time range:</span>
          {RANGES.map((h) => (
            <button
              key={h}
              onClick={() => setRangeHours(h)}
              className={`rounded px-2 py-1 text-xs font-medium ${
                rangeHours === h ? 'bg-cyan-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
              }`}
            >
              {h >= 8760 ? '1y' : h < 24 ? `${h}h` : `${h / 24}d`}
            </button>
          ))}
        </div>
        <div className="space-y-2">
          {series.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2">
              <select
                value={s.deviceId}
                onChange={(e) => updateSeries(s.id, { deviceId: e.target.value })}
                className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-slate-200"
              >
                {(devices ?? []).map((d) => (
                  <option key={d.device_id} value={d.device_id}>
                    {d.name || d.device_id}
                  </option>
                ))}
              </select>
              <select
                value={s.metric}
                onChange={(e) => updateSeries(s.id, { metric: e.target.value })}
                className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-slate-200"
              >
                {METRIC_OPTS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => removeSeries(s.id)}
                className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-400 hover:bg-rose-600/80 hover:text-white"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addSeries}
            className="rounded bg-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-600"
          >
            + Add series
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-2 font-display text-sm font-medium text-slate-300">Correlation chart</div>
        {loading && <p className="text-xs text-slate-500">Loading…</p>}
        {!loading && dataKeys.length === 0 && buildSpec(series) && (
          <p className="text-xs text-slate-500">No data in range. Ensure devices have reported telemetry.</p>
        )}
        {!loading && !buildSpec(series) && (
          <p className="text-xs text-slate-500">Add at least one series above.</p>
        )}
        {dataKeys.length > 0 && (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <defs>
                  {dataKeys.map((key, i) => (
                    <linearGradient key={key} id={`compare-${key.replace(/[^a-z0-9]/gi, '_')}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COMPARE_COLORS[i % COMPARE_COLORS.length]} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={COMPARE_COLORS[i % COMPARE_COLORS.length]} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="ts" stroke="#64748b" fontSize={10} />
                <YAxis stroke="#64748b" fontSize={10} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
                  labelStyle={{ color: '#94a3b8' }}
                />
                {dataKeys.map((key, i) => (
                  <Area
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stroke={COMPARE_COLORS[i % COMPARE_COLORS.length]}
                    fill={`url(#compare-${key.replace(/[^a-z0-9]/gi, '_')})`}
                    strokeWidth={2}
                    name={key.replace('__', ' · ')}
                  />
                ))}
                <Brush dataKey="ts" height={24} stroke="#334155" fill="#0f172a" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )
}
