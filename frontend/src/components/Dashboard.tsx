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
import {
  getTelemetryMulti,
  getTelemetryLog,
  sendHeaterCommand,
  sendLedCommand,
  getCommandStatus,
  listSchedules,
  TelemetryPoint,
  useLatestTelemetry,
} from '../api'
import { Scenarios } from './Scenarios'
import { SSE_REFETCH_EVENT } from '../hooks/useSSE'

interface DashboardProps {
  deviceId: string | null
  telemetry: TelemetryPoint | null
}

const ACK_TIMEOUT_MS = 5000
const VIEW_STORAGE_KEY = 'aqua-chart-view'

const METRIC_OPTS: { id: string; label: string; color: string }[] = [
  { id: 'temp', label: 'Temp °C', color: '#22d3ee' },
  { id: 'lux', label: 'Lux', color: '#fbbf24' },
  { id: 'water_voltage', label: 'Water V', color: '#34d399' },
  { id: 'led_brightness', label: 'LED %', color: '#a78bfa' },
]
const RANGES = [1, 6, 24, 168] as const // hours: 1h, 6h, 24h, 7d

type ChartView = { rangeHours: number; metrics: string[] }

export function Dashboard({ deviceId, telemetry }: DashboardProps) {
  const [chartData, setChartData] = useState<Array<Record<string, string | number | null>>>([])
  const [rangeHours, setRangeHours] = useState(24)
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(['temp'])
  const [dataLog, setDataLog] = useState<TelemetryPoint[]>([])
  const [logOpen, setLogOpen] = useState(false)
  const [pendingHeater, setPendingHeater] = useState<string | null>(null)
  const [pendingLed, setPendingLed] = useState<string | null>(null)
  const [brightnessSlider, setBrightnessSlider] = useState<number>(100)
  const [hasActiveCurveSchedule, setHasActiveCurveSchedule] = useState(false)
  const { refetch } = useLatestTelemetry(deviceId)

  useEffect(() => {
    if (telemetry?.led_brightness != null) setBrightnessSlider(telemetry.led_brightness)
  }, [telemetry?.led_brightness])

  useEffect(() => {
    if (!deviceId) {
      setHasActiveCurveSchedule(false)
      return
    }
    listSchedules(deviceId)
      .then((schedules) => {
        const hasCurve = schedules.some(
          (s) => s.scenario_type === 'curve' && s.enabled
        )
        setHasActiveCurveSchedule(hasCurve)
      })
      .catch(() => setHasActiveCurveSchedule(false))
  }, [deviceId])

  const refetchCurveState = useCallback(() => {
    if (!deviceId) return
    listSchedules(deviceId)
      .then((schedules) => {
        setHasActiveCurveSchedule(
          schedules.some((s) => s.scenario_type === 'curve' && s.enabled)
        )
      })
      .catch(() => setHasActiveCurveSchedule(false))
  }, [deviceId])

  const loadChart = useCallback(async () => {
    const metrics = selectedMetrics.length > 0 ? selectedMetrics : ['temp']
    if (!deviceId) return
    try {
      const to = new Date()
      const from = new Date(to.getTime() - rangeHours * 60 * 60 * 1000)
      const res = await getTelemetryMulti(
        deviceId,
        metrics,
        from.toISOString(),
        to.toISOString(),
        500
      )
      const points = (res.points || []).map((p: Record<string, string | number | null>) => ({
        ...p,
        ts: new Date(p.ts as string).toLocaleTimeString(undefined, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }),
        tsRaw: p.ts,
      }))
      setChartData(points)
    } catch (_) {}
  }, [deviceId, rangeHours, selectedMetrics])

  const loadDataLog = useCallback(async () => {
    if (!deviceId) return
    try {
      const res = await getTelemetryLog(deviceId, 100)
      setDataLog(res.rows || [])
    } catch (_) {}
  }, [deviceId])

  const toggleMetric = (m: string) => {
    setSelectedMetrics((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    )
  }

  const zoomIn = () => setRangeHours((h) => Math.max(1, Math.floor(h / 2)))
  const zoomOut = () => setRangeHours((h) => Math.min(168, h * 2))

  const saveView = () => {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ rangeHours, metrics: selectedMetrics }))
  }
  const loadView = () => {
    const s = localStorage.getItem(VIEW_STORAGE_KEY)
    if (s) {
      try {
        const v: ChartView = JSON.parse(s)
        setRangeHours(v.rangeHours)
        if (v.metrics?.length) setSelectedMetrics(v.metrics)
      } catch {}
    }
  }

  useEffect(() => {
    loadChart()
  }, [loadChart])

  useEffect(() => {
    if (logOpen) loadDataLog()
  }, [logOpen, loadDataLog])

  useEffect(() => {
    const handler = () => {
      refetch()
      loadChart()
      if (logOpen) loadDataLog()
    }
    window.addEventListener(SSE_REFETCH_EVENT, handler)
    return () => window.removeEventListener(SSE_REFETCH_EVENT, handler)
  }, [refetch, loadChart, logOpen, loadDataLog])

  const handleHeater = async (action: 'on' | 'off' | 'toggle') => {
    if (!deviceId) return
    setPendingHeater(action)
    try {
      const { correlation_id } = await sendHeaterCommand(deviceId, action)
      const start = Date.now()
      const check = async () => {
        const status = await getCommandStatus(correlation_id)
        if (status.status === 'ACKED') {
          setPendingHeater(null)
          refetch()
          return
        }
        if (Date.now() - start > ACK_TIMEOUT_MS) {
          setPendingHeater(null)
          return
        }
        setTimeout(check, 500)
      }
      setTimeout(check, 500)
    } catch (e) {
      setPendingHeater(null)
      alert(String(e))
    }
  }

  const handleLed = async (action: string, value?: number) => {
    if (!deviceId) return
    setPendingLed(action)
    try {
      const payload = value !== undefined ? { value } : undefined
      const { correlation_id } = await sendLedCommand(deviceId, action, payload)
      const start = Date.now()
      const check = async () => {
        const status = await getCommandStatus(correlation_id)
        if (status.status === 'ACKED') {
          setPendingLed(null)
          refetch()
          return
        }
        if (Date.now() - start > ACK_TIMEOUT_MS) {
          setPendingLed(null)
          return
        }
        setTimeout(check, 500)
      }
      setTimeout(check, 500)
    } catch (e) {
      setPendingLed(null)
      alert(String(e))
    }
  }

  if (!deviceId) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-12 text-center text-slate-400">
        No devices discovered. Connect an ESP32 and ensure MQTT broker is running.
      </div>
    )
  }

  const t = telemetry

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-6">
        <Card
          label="Temperature"
          value={t?.temp != null ? `${t.temp.toFixed(1)} °C` : '-'}
          variant="temp"
        />
        <Card
          label="Light (lux)"
          value={t?.lux != null ? Math.round(t.lux).toString() : '-'}
          variant="lux"
        />
        <Card
          label="Water"
          value={t?.water_ok === false ? 'ALARM' : t?.water_ok === true ? 'OK' : '-'}
          variant={t?.water_ok === false ? 'alarm' : 'ok'}
        />
        <Card
          label="Heater"
          value={t?.heater_on ? 'ON' : t?.heater_on === false ? 'OFF' : '-'}
          variant={t?.heater_on ? 'on' : 'off'}
        />
        <Card
          label="LED"
          value={
            t?.led_on != null
              ? `${t.led_on ? 'ON' : 'OFF'}${t.led_brightness != null ? ` ${t.led_brightness}%` : ''}`
              : '-'
          }
          variant={t?.led_on ? 'on' : 'off'}
        />
        <Card
          label="Last update"
          value={t?.ts ? new Date(t.ts).toLocaleTimeString() : '-'}
          variant="neutral"
        />
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-sm font-medium text-slate-300">Charts</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">Time:</span>
            {RANGES.map((h) => (
              <button
                key={h}
                onClick={() => setRangeHours(h)}
                className={`rounded px-2 py-1 text-xs font-medium ${
                  rangeHours === h ? 'bg-cyan-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                }`}
              >
                {h < 24 ? `${h}h` : `${h / 24}d`}
              </button>
            ))}
            <button
              onClick={zoomIn}
              className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600"
              title="Zoom in"
            >
              +
            </button>
            <button
              onClick={zoomOut}
              className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600"
              title="Zoom out"
            >
              −
            </button>
            <span className="text-slate-600">|</span>
            <span className="text-xs text-slate-500">Metrics:</span>
            {METRIC_OPTS.map((m) => (
              <label key={m.id} className="flex cursor-pointer items-center gap-1">
                <input
                  type="checkbox"
                  checked={selectedMetrics.includes(m.id)}
                  onChange={() => toggleMetric(m.id)}
                  className="rounded border-slate-600"
                />
                <span className="text-xs text-slate-300">{m.label}</span>
              </label>
            ))}
            <span className="text-slate-600">|</span>
            <button onClick={saveView} className="text-xs text-cyan-400 hover:underline">Save view</button>
            <button onClick={loadView} className="text-xs text-cyan-400 hover:underline">Load view</button>
          </div>
        </div>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData}>
              <defs>
                {METRIC_OPTS.map((m) => (
                  <linearGradient key={m.id} id={`color-${m.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={m.color} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={m.color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="ts" stroke="#64748b" fontSize={10} />
              <YAxis yAxisId="left" stroke="#64748b" fontSize={10} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
                labelStyle={{ color: '#94a3b8' }}
              />
              {(selectedMetrics.length > 0 ? selectedMetrics : ['temp']).map((mk) => {
                const opt = METRIC_OPTS.find((o) => o.id === mk)
                if (!opt) return null
                return (
                  <Area
                    key={mk}
                    yAxisId="left"
                    type="monotone"
                    dataKey={mk}
                    stroke={opt.color}
                    fill={`url(#color-${mk})`}
                    strokeWidth={2}
                    name={opt.label}
                  />
                )
              })}
              <Brush dataKey="ts" height={24} stroke="#334155" fill="#0f172a" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <button
          onClick={() => setLogOpen(!logOpen)}
          className="flex w-full items-center justify-between font-display text-sm font-medium text-slate-300 hover:text-slate-200"
        >
          Data log
          <span className="text-slate-500">{logOpen ? '▼' : '▶'}</span>
        </button>
        {logOpen && (
          <div className="mt-3 max-h-64 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="px-2 py-1">Time</th>
                  <th className="px-2 py-1">Temp</th>
                  <th className="px-2 py-1">Lux</th>
                  <th className="px-2 py-1">Water</th>
                  <th className="px-2 py-1">Heater</th>
                  <th className="px-2 py-1">LED</th>
                </tr>
              </thead>
              <tbody>
                {dataLog.map((r, i) => (
                  <tr key={i} className="border-t border-slate-800 text-slate-300">
                    <td className="px-2 py-1">{new Date(r.ts).toLocaleString()}</td>
                    <td className="px-2 py-1">{r.temp != null ? r.temp.toFixed(1) : '-'}</td>
                    <td className="px-2 py-1">{r.lux != null ? Math.round(r.lux) : '-'}</td>
                    <td className="px-2 py-1">{r.water_ok === true ? 'OK' : r.water_ok === false ? 'ALARM' : '-'}</td>
                    <td className="px-2 py-1">{r.heater_on ? 'ON' : r.heater_on === false ? 'OFF' : '-'}</td>
                    <td className="px-2 py-1">{r.led_on ? `${r.led_brightness ?? 0}%` : r.led_on === false ? 'OFF' : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <h2 className="mb-3 font-display text-sm font-medium text-slate-300">Heater</h2>
          <div className="flex gap-2">
            {(['on', 'off', 'toggle'] as const).map((action) => (
              <button
                key={action}
                onClick={() => handleHeater(action)}
                disabled={!!pendingHeater}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                  action === 'on'
                    ? 'bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800'
                    : action === 'off'
                      ? 'bg-rose-600 hover:bg-rose-500 disabled:bg-rose-800'
                      : 'bg-slate-600 hover:bg-slate-500 disabled:bg-slate-700'
                } text-white disabled:opacity-70`}
              >
                {pendingHeater === action ? '…' : action.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <h2 className="mb-3 font-display text-sm font-medium text-slate-300">LED light</h2>
          {hasActiveCurveSchedule && (
            <p className="mb-3 text-xs text-amber-400/90">
              Manual control disabled — LED is driven by the active 24h curve schedule below.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex gap-2">
              {(['on', 'off', 'toggle'] as const).map((action) => (
                <button
                  key={action}
                  onClick={() => handleLed(action)}
                  disabled={!!pendingLed || hasActiveCurveSchedule}
                  className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {pendingLed === action ? '…' : action.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="flex min-w-[160px] flex-1 flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={brightnessSlider}
                  disabled={hasActiveCurveSchedule}
                  className="h-2 flex-1 rounded-lg accent-amber-500 disabled:opacity-60 disabled:cursor-not-allowed"
                  onChange={(e) => setBrightnessSlider(Number((e.target as HTMLInputElement).value))}
                  onMouseUp={(e) =>
                    !hasActiveCurveSchedule &&
                    handleLed('set_brightness', Number((e.target as HTMLInputElement).value))
                  }
                  onTouchEnd={(e) =>
                    !hasActiveCurveSchedule &&
                    handleLed('set_brightness', Number((e.target as HTMLInputElement).value))
                  }
                />
                <span className="w-10 text-right text-sm text-slate-400">{brightnessSlider}%</span>
              </div>
              <span className="text-xs text-slate-500">
                {hasActiveCurveSchedule ? 'Brightness follows curve' : 'Brightness (0–100%)'}
              </span>
            </div>
          </div>
        </div>
        <Scenarios deviceId={deviceId} onSchedulesChange={refetchCurveState} />
        </div>
      </div>
    </div>
  )
}

function Card({
  label,
  value,
  variant,
}: {
  label: string
  value: string
  variant: 'temp' | 'lux' | 'ok' | 'alarm' | 'on' | 'off' | 'neutral'
}) {
  const colors: Record<string, string> = {
    temp: 'border-cyan-500/50 bg-cyan-950/30',
    lux: 'border-amber-500/50 bg-amber-950/30',
    ok: 'border-emerald-500/50 bg-emerald-950/30',
    alarm: 'border-rose-500/50 bg-rose-950/30',
    on: 'border-emerald-500/50 bg-emerald-950/30',
    off: 'border-slate-600/50 bg-slate-900/30',
    neutral: 'border-slate-700/50 bg-slate-900/30',
  }
  return (
    <div className={`rounded-xl border p-4 ${colors[variant] || colors.neutral}`}>
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 font-display text-lg font-semibold text-slate-100">{value}</div>
    </div>
  )
}
