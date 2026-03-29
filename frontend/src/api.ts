import { clearToken, getAuthHeaders, hasRecentAuthSuccess, isWithinLoginGrace, setLastAuthSuccess, setStoredUser, setToken } from './auth'
import type { AuthUser } from './auth'

const API_BASE = '/api'

export interface LoginResponse {
  token: string
  user: AuthUser
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const r = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password }),
  })
  if (!r.ok) {
    const msg = await apiErrorText(r, 'Login failed')
    throw new Error(msg)
  }
  const data = (await r.json()) as LoginResponse
  setToken(data.token)
  setStoredUser(data.user)
  return data
}

async function apiErrorText(r: Response, fallback: string): Promise<string> {
  const text = await r.text()
  if (!text) return fallback
  try {
    const body = JSON.parse(text) as { detail?: string }
    if (body.detail) return body.detail
  } catch {
    if (text.length < 400 && !text.startsWith('<!')) return text
    if (text.startsWith('<!')) return fallback + ' (server error)'
  }
  return fallback
}

export async function register(username: string, password: string): Promise<LoginResponse> {
  const r = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password }),
  })
  if (!r.ok) {
    const msg =
      r.status === 403
        ? 'An account already exists. Please sign in instead, or ask an admin to add you in Settings → Users.'
        : await apiErrorText(r, 'Registration failed')
    throw new Error(msg)
  }
  const data = (await r.json()) as LoginResponse
  setToken(data.token)
  setStoredUser(data.user)
  return data
}

export async function getMe(): Promise<AuthUser> {
  return fetcher<AuthUser>('/auth/me')
}

export interface ApiUser {
  id: number
  username: string
  is_admin: boolean
  created_at: string
}

export async function listUsers(): Promise<ApiUser[]> {
  return fetcher<ApiUser[]>('/users')
}

export async function createUser(username: string, password: string): Promise<ApiUser> {
  const r = await authFetch('/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function deleteUser(userId: number): Promise<void> {
  const r = await authFetch(`/users/${userId}`, { method: 'DELETE' })
  if (!r.ok) throw new Error(await r.text())
}

export const SESSION_EXPIRED_EVENT = 'aqua-session-expired'

function onSessionExpired() {
  if (isWithinLoginGrace() || hasRecentAuthSuccess()) return
  clearToken()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
  }
}

async function fetcher<T>(url: string): Promise<T> {
  const r = await fetch(`${API_BASE}${url}`, { headers: { ...getAuthHeaders() } })
  if (r.status === 401) {
    onSessionExpired()
    throw new Error('Session expired')
  }
  if (r.ok) setLastAuthSuccess()
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function authFetch(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const r = await fetch(`${API_BASE}${url}`, {
    ...init,
    headers: { ...getAuthHeaders(), ...(init.headers as Record<string, string>) },
  })
  if (r.status === 401) {
    onSessionExpired()
    throw new Error('Session expired')
  }
  if (r.ok) setLastAuthSuccess()
  return r
}

export async function getHealth() {
  return fetcher<{ status: string; mqtt_connected: boolean; mqtt_broker: string | null; devices_count: number }>('/health')
}

export interface ApiDevice {
  device_id: string
  name: string
  online: boolean
  last_seen_ts: string | null
  last_status_ts?: string | null
  last_ip?: string | null
  capabilities?: Record<string, boolean>
  enabled?: boolean
}

export async function getDevices() {
  return fetcher<ApiDevice[]>('/devices')
}

export async function addDevice(deviceId: string, name?: string): Promise<{ device: ApiDevice; status: string }> {
  const r = await authFetch('/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId.trim(), name: name?.trim() || undefined }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function updateDevice(
  deviceId: string,
  updates: { name?: string; enabled?: boolean }
): Promise<{ device: ApiDevice; status: string }> {
  const r = await authFetch(`/devices/${encodeURIComponent(deviceId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function getLatestTelemetry(deviceId: string | null) {
  if (!deviceId) return null
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
  return fetcher<TelemetryPoint | null>(`/telemetry/latest${q}`).catch(() => null)
}

export async function getTelemetryLog(deviceId: string, limit = 100, offset = 0) {
  const params = new URLSearchParams({ device_id: deviceId, limit: String(limit), offset: String(offset) })
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
  limit = 500,
  bucket?: string
) {
  const params = new URLSearchParams({ device_id: deviceId, metrics: metrics.join(','), limit: String(limit) })
  if (from) params.set('from_ts', from)
  if (to) params.set('to_ts', to)
  if (bucket) params.set('bucket', bucket)
  return fetcher<{ points: Array<Record<string, string | number | null>> }>(`/telemetry?${params}`)
}

/** Time-aligned multi-device telemetry for correlation. Example: devicesSpec = "room-sensor-01:temp,humidity|controller-01:temp" */
export async function getTelemetryMultiDevice(
  devicesSpec: string,
  fromTs: string,
  toTs: string,
  bucket = '5m',
  limit = 2000
) {
  const params = new URLSearchParams({
    devices: devicesSpec,
    from_ts: fromTs,
    to_ts: toTs,
    bucket,
    limit: String(limit),
  })
  return fetcher<{
    specs: Array<{ device_id: string; metrics: string[] }>
    points: Array<Record<string, string | number | null>>
  }>(`/telemetry/multi_device?${params}`)
}

export async function sendHeaterCommand(deviceId: string, action: 'on' | 'off' | 'toggle') {
  const r = await authFetch(`/devices/${deviceId}/commands/heater`, {
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
  const r = await authFetch(`/devices/${deviceId}/commands/led`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload: payload ?? null }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<{ correlation_id: string; status: string }>
}

/** Rows from ESP32 filter bridge after MQTT filter action `ble_scan` (telemetry JSON). */
export interface FilterBleScanResult {
  address: string
  name?: string | null
  rssi?: number | null
}

export async function sendFilterCommand(
  deviceId: string,
  action: string,
  payload?: Record<string, unknown> | null
) {
  const r = await authFetch(`/devices/${encodeURIComponent(deviceId)}/commands/filter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload: payload ?? null }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<{ correlation_id: string; status: string }>
}

export async function getFilterState(deviceId: string) {
  return fetcher<{
    success: boolean
    message: string
    device_id: string
    ble_connected: boolean | null
    current_filter_power: boolean | null
    current_filter_mode: string | null
    last_state_blob_hex: string | null
    last_ble_error: string | null
    filter_last_address: string | null
    filter_scan_results?: FilterBleScanResult[] | null
    filter_scan_status?: string | null
    telemetry_ts: string | null
  }>(`/devices/${encodeURIComponent(deviceId)}/filter/state`)
}

export async function getCommandStatus(correlationId: string) {
  return fetcher<{ status: string; acked_at: string | null }>(`/commands/${correlationId}`)
}

export interface MqttSettings {
  broker_host: string
  broker_port: number
  username: string
  has_password: boolean
  use_tls: boolean
  ca_certs: string
  tls_insecure: boolean
  public_broker_host: string
  public_broker_port: number | null
}

export interface MqttConnection {
  enabled: boolean
  broker_host: string | null
  broker_port: number | null
  use_tls: boolean
  topic_root: string
}

export async function getMqttSettings() {
  return fetcher<MqttSettings>('/settings/mqtt')
}

export async function getMqttConnection() {
  return fetcher<MqttConnection>('/mqtt/connection')
}

export async function updateMqttSettings(updates: {
  broker_host?: string
  broker_port?: number
  username?: string
  password?: string
  use_tls?: boolean
  ca_certs?: string
  tls_insecure?: boolean
  public_broker_host?: string
  public_broker_port?: number
}) {
  const r = await authFetch('/settings/mqtt', {
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
  const r = await authFetch('/schedules', {
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
  const r = await authFetch(`/schedules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function deleteSchedule(id: number): Promise<void> {
  const r = await authFetch(`/schedules/${id}`, { method: 'DELETE' })
  if (!r.ok) throw new Error(await r.text())
}

export interface TelemetryPoint {
  ts: string
  device_id: string
  temp: number | null
  lux: number | null
  humidity: number | null
  water_ok: boolean | null
  heater_on: boolean | null
  water_voltage: number | null
  button_voltage: number | null
  button_pressed: boolean | null
  led_on?: boolean | null
  led_brightness?: number | null
  filter_ble_connected?: boolean | null
  filter_power?: boolean | null
  filter_mode?: string | null
  filter_state_blob_hex?: string | null
  filter_ble_error?: string | null
  filter_last_address?: string | null
  filter_scan_results?: FilterBleScanResult[] | null
  filter_scan_status?: string | null
}

// React hooks with simple polling + SSE invalidation
import { useEffect, useState, useCallback } from 'react'
import { SSE_REFETCH_EVENT } from './hooks/useSSE'

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
  useEffect(() => {
    const handler = () => refetch()
    window.addEventListener(SSE_REFETCH_EVENT, handler)
    return () => window.removeEventListener(SSE_REFETCH_EVENT, handler)
  }, [refetch])
  return { data, refetch }
}

export function useLatestTelemetry(deviceId: string | null, intervalMs = 1000) {
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
  useEffect(() => {
    const onSse = () => refetch()
    window.addEventListener(SSE_REFETCH_EVENT, onSse)
    return () => window.removeEventListener(SSE_REFETCH_EVENT, onSse)
  }, [refetch])
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') void refetch()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
    }
  }, [refetch])
  return { data, refetch }
}
