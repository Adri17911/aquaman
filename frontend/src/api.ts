const API_BASE = '/api'

async function fetcher<T>(url: string): Promise<T> {
  const r = await fetch(`${API_BASE}${url}`)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function getHealth() {
  return fetcher<{ status: string; mqtt_connected: boolean; mqtt_broker: string | null; devices_count: number }>('/health')
}

export async function getDevices() {
  return fetcher<Array<{ device_id: string; name: string; online: boolean; last_seen_ts: string | null }>>('/devices')
}

export async function getLatestTelemetry(deviceId: string | null) {
  if (!deviceId) return null
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
  return fetcher<TelemetryPoint | null>(`/telemetry/latest${q}`).catch(() => null)
}

export async function getTelemetryLog(deviceId: string, limit = 100) {
  const params = new URLSearchParams({ device_id: deviceId, limit: String(limit) })
  return fetcher<{ device_id: string; rows: TelemetryPoint[] }>(`/telemetry/log?${params}`)
}

export async function getTelemetrySeries(
  deviceId: string,
  metric: string,
  from?: string,
  to?: string,
  limit = 500
) {
  const params = new URLSearchParams({ device_id: deviceId, metric, limit: String(limit) })
  if (from) params.set('from_ts', from)
  if (to) params.set('to_ts', to)
  return fetcher<{ points: Array<{ ts: string; value: number | null }> }>(`/telemetry?${params}`)
}

export async function getTelemetryMulti(
  deviceId: string,
  metrics: string[],
  from?: string,
  to?: string,
  limit = 500
) {
  const params = new URLSearchParams({ device_id: deviceId, metrics: metrics.join(','), limit: String(limit) })
  if (from) params.set('from_ts', from)
  if (to) params.set('to_ts', to)
  return fetcher<{ points: Array<Record<string, string | number | null>> }>(`/telemetry?${params}`)
}

export async function sendHeaterCommand(deviceId: string, action: 'on' | 'off' | 'toggle') {
  const r = await fetch(`${API_BASE}/devices/${deviceId}/commands/heater`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<{ correlation_id: string; status: string }>
}

export async function sendLedCommand(
  deviceId: string,
  action: string,
  payload?: { value?: number }
) {
  const r = await fetch(`${API_BASE}/devices/${deviceId}/commands/led`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload: payload ?? null }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<{ correlation_id: string; status: string }>
}

export async function getCommandStatus(correlationId: string) {
  return fetcher<{ status: string; acked_at: string | null }>(`/commands/${correlationId}`)
}

export interface MqttSettings {
  broker_host: string
  broker_port: number
  username: string
  has_password: boolean
}

export async function getMqttSettings() {
  return fetcher<MqttSettings>('/settings/mqtt')
}

export async function updateMqttSettings(updates: {
  broker_host?: string
  broker_port?: number
  username?: string
  password?: string
}) {
  const r = await fetch(`${API_BASE}/settings/mqtt`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<MqttSettings>
}

export interface Schedule {
  id: number
  device_id: string
  name: string
  enabled: boolean
  scenario_type: string
  dawn_time: string
  dusk_time: string
  dawn_duration_minutes: number
  dusk_duration_minutes: number
  target_brightness: number
  days_of_week: string
  curve_points: [number, number][] | null
  created_at: string | null
}

export async function listSchedules(deviceId?: string | null): Promise<Schedule[]> {
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
  return fetcher<Schedule[]>(`/schedules${q}`)
}

export async function createSchedule(body: {
  device_id: string
  name: string
  scenario_type?: string
  dawn_time?: string
  dusk_time?: string
  dawn_duration_minutes?: number
  dusk_duration_minutes?: number
  target_brightness?: number
  days_of_week?: string
  enabled?: boolean
  curve_points?: string | null
}): Promise<Schedule> {
  const r = await fetch(`${API_BASE}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function updateSchedule(
  id: number,
  body: Partial<{
    name: string
    scenario_type: string
    dawn_time: string
    dusk_time: string
    dawn_duration_minutes: number
    dusk_duration_minutes: number
    target_brightness: number
    days_of_week: string
    enabled: boolean
    curve_points: string | null
  }>
): Promise<Schedule> {
  const r = await fetch(`${API_BASE}/schedules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function deleteSchedule(id: number): Promise<void> {
  const r = await fetch(`${API_BASE}/schedules/${id}`, { method: 'DELETE' })
  if (!r.ok) throw new Error(await r.text())
}

export interface TelemetryPoint {
  ts: string
  device_id: string
  temp: number | null
  lux: number | null
  water_ok: boolean | null
  heater_on: boolean | null
  water_voltage: number | null
  button_voltage: number | null
  button_pressed: boolean | null
  led_on?: boolean | null
  led_brightness?: number | null
}

// React hooks with simple polling + SSE invalidation
import { useEffect, useState, useCallback } from 'react'

export function useHealth(intervalMs = 5000) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getHealth>> | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const refetch = useCallback(async () => {
    try {
      const d = await getHealth()
      setData(d)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    }
  }, [])
  useEffect(() => {
    refetch()
    const id = setInterval(refetch, intervalMs)
    return () => clearInterval(id)
  }, [refetch, intervalMs])
  return { data, error, refetch }
}

export function useDevices(intervalMs = 5000) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getDevices>> | null>(null)
  const refetch = useCallback(async () => {
    try {
      const d = await getDevices()
      setData(d)
    } catch (_) {}
  }, [])
  useEffect(() => {
    refetch()
    const id = setInterval(refetch, intervalMs)
    return () => clearInterval(id)
  }, [refetch, intervalMs])
  return { data, refetch }
}

export function useLatestTelemetry(deviceId: string | null, intervalMs = 2000) {
  const [data, setData] = useState<TelemetryPoint | null>(null)
  const refetch = useCallback(async () => {
    if (!deviceId) return
    try {
      const d = await getLatestTelemetry(deviceId)
      setData(d ?? null)
    } catch (_) {}
  }, [deviceId])
  useEffect(() => {
    refetch()
    const id = setInterval(refetch, intervalMs)
    return () => clearInterval(id)
  }, [refetch, intervalMs])
  return { data, refetch }
}
