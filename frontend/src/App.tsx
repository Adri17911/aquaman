import { useCallback, useEffect, useState, useMemo } from 'react'
import { useSSE } from './hooks/useSSE'
import { Dashboard } from './components/Dashboard'
import { Login } from './components/Login'
import { Settings, getAutoDiscovery, getManualDeviceIds } from './components/Settings'
import { useDevices, useLatestTelemetry, useHealth, getMe, SESSION_EXPIRED_EVENT } from './api'
import { clearToken, getStoredUser } from './auth'
import type { AuthUser } from './auth'

function AuthenticatedApp({
  user,
  onLogout,
}: {
  user: AuthUser
  onLogout: () => void
}) {
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsVersion, setSettingsVersion] = useState(0)
  const { data: health } = useHealth()
  const { data: apiDevices } = useDevices()
  const { data: telemetry } = useLatestTelemetry(deviceId)
  useSSE()

  const devices = useMemo(() => {
    if (!apiDevices) return null
    const autoDiscovery = getAutoDiscovery()
    if (autoDiscovery) return apiDevices
    const manualIds = getManualDeviceIds()
    return apiDevices.filter((d) => manualIds.has(d.device_id))
  }, [apiDevices, settingsVersion])

  useEffect(() => {
    if (devices?.length && !deviceId) {
      setDeviceId(devices[0].device_id)
    } else if (devices && deviceId && !devices.some((d) => d.device_id === deviceId)) {
      setDeviceId(devices[0]?.device_id ?? null)
    }
  }, [devices, deviceId])

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <h1 className="font-display text-xl font-semibold tracking-tight text-cyan-400">
            AQUA
          </h1>
          <div className="flex items-center gap-4">
            <span className={`text-xs ${health?.mqtt_connected ? 'text-emerald-500' : 'text-amber-500'}`}>
              MQTT {health?.mqtt_connected ? 'connected' : 'disconnected'}
            </span>
            {devices && devices.length > 0 && (
              <select
                value={deviceId ?? ''}
                onChange={(e) => setDeviceId(e.target.value || null)}
                className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              >
                {devices.map((d) => (
                  <option key={d.device_id} value={d.device_id}>
                    {d.name || d.device_id} {d.online ? '●' : '○'}
                  </option>
                ))}
              </select>
            )}
            {apiDevices && apiDevices.length === 0 && !health?.mqtt_connected && (
              <span className="text-xs text-amber-500">MQTT disconnected — connect broker for devices</span>
            )}
            {apiDevices && apiDevices.length === 0 && health?.mqtt_connected && (
              <span className="text-xs text-slate-500">No devices yet — controller will appear when it sends data, or add in Settings</span>
            )}
            {apiDevices && apiDevices.length > 0 && devices && devices.length === 0 && (
              <span className="text-xs text-slate-500">Enable auto-discovery or add devices in Settings to show them</span>
            )}
            <span className="text-xs text-slate-500">
              {user.username}
              {user.is_admin ? ' (admin)' : ''}
            </span>
            <button
              onClick={() => setSettingsOpen(true)}
              className="rounded p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
              aria-label="Open settings"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button
              onClick={onLogout}
              className="rounded px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSettingsChange={() => setSettingsVersion((v) => v + 1)}
        isAdmin={user.is_admin}
      />
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Dashboard deviceId={deviceId} telemetry={telemetry} />
      </main>
    </div>
  )
}

function App() {
  const [user, setUser] = useState<ReturnType<typeof getStoredUser>>(null)
  const [authChecked, setAuthChecked] = useState(false)

  useEffect(() => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('aqua-token') : null
    if (!token) {
      setAuthChecked(true)
      return
    }
    getMe()
      .then((u) => {
        setUser(u)
        setAuthChecked(true)
      })
      .catch(() => {
        clearToken()
        setAuthChecked(true)
      })
  }, [])

  useEffect(() => {
    const handler = () => setUser(null)
    window.addEventListener(SESSION_EXPIRED_EVENT, handler)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler)
  }, [])

  const handleLoggedIn = useCallback(() => {
    setUser(getStoredUser())
  }, [])

  const handleLogout = useCallback(() => {
    clearToken()
    setUser(null)
  }, [])

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <span className="text-slate-500">Loading…</span>
      </div>
    )
  }

  if (!user) {
    return <Login onLoggedIn={handleLoggedIn} />
  }

  return <AuthenticatedApp user={user} onLogout={handleLogout} />
}

export default App
