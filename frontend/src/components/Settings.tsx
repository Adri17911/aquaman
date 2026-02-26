import { useState, useEffect } from 'react'
import { getHealth, getMqttSettings, updateMqttSettings } from '../api'

const STORAGE_KEY_AUTO_DISCOVERY = 'aqua-auto-discovery'
const STORAGE_KEY_MANUAL_DEVICES = 'aqua-manual-devices'

export function getAutoDiscovery(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY_AUTO_DISCOVERY)
    return v === null ? true : v === 'true'
  } catch {
    return true
  }
}

export function setAutoDiscovery(value: boolean): void {
  localStorage.setItem(STORAGE_KEY_AUTO_DISCOVERY, String(value))
}

export function getManualDeviceIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MANUAL_DEVICES)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

export function addManualDeviceId(deviceId: string): void {
  const set = getManualDeviceIds()
  set.add(deviceId)
  localStorage.setItem(STORAGE_KEY_MANUAL_DEVICES, JSON.stringify([...set]))
}

interface SettingsProps {
  isOpen: boolean
  onClose: () => void
  onSettingsChange?: () => void
}

export function Settings({ isOpen, onClose, onSettingsChange }: SettingsProps) {
  const [autoDiscovery, setAutoDiscoveryState] = useState(true)
  const [deviceId, setDeviceId] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [addError, setAddError] = useState('')
  const [addSuccess, setAddSuccess] = useState(false)
  const [health, setHealth] = useState<Awaited<ReturnType<typeof getHealth>> | null>(null)
  const [mqttSettings, setMqttSettings] = useState<Awaited<ReturnType<typeof getMqttSettings>> | null>(null)
  const [mqttBrokerHost, setMqttBrokerHost] = useState('')
  const [mqttBrokerPort, setMqttBrokerPort] = useState('1883')
  const [mqttUsername, setMqttUsername] = useState('')
  const [mqttPassword, setMqttPassword] = useState('')
  const [mqttSaveError, setMqttSaveError] = useState('')
  const [mqttSaveSuccess, setMqttSaveSuccess] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setAutoDiscoveryState(getAutoDiscovery())
      getHealth().then(setHealth).catch(() => setHealth(null))
      getMqttSettings().then((s) => {
        setMqttSettings(s)
        setMqttBrokerHost(s.broker_host)
        setMqttBrokerPort(String(s.broker_port))
        setMqttUsername(s.username ?? '')
        setMqttPassword('')
      }).catch(() => setMqttSettings(null))
    }
  }, [isOpen])

  const handleAutoDiscoveryChange = (checked: boolean) => {
    setAutoDiscovery(checked)
    setAutoDiscoveryState(checked)
    onSettingsChange?.()
  }

  const handleMqttSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setMqttSaveError('')
    setMqttSaveSuccess(false)
    const port = parseInt(mqttBrokerPort, 10)
    if (isNaN(port) || port < 1 || port > 65535) {
      setMqttSaveError('Invalid port (1–65535)')
      return
    }
    try {
      const updates: { broker_host: string; broker_port: number; username?: string; password?: string } = {
        broker_host: mqttBrokerHost.trim() || 'localhost',
        broker_port: port,
      }
      if (mqttUsername.trim() !== '') updates.username = mqttUsername.trim()
      if (mqttPassword !== '') updates.password = mqttPassword
      await updateMqttSettings(updates)
      setMqttSaveSuccess(true)
      getHealth().then(setHealth).catch(() => {})
      onSettingsChange?.()
      setTimeout(() => setMqttSaveSuccess(false), 2000)
    } catch (err) {
      setMqttSaveError(err instanceof Error ? err.message : 'Failed to save')
    }
  }

  const handleAddDevice = async (e: React.FormEvent) => {
    e.preventDefault()
    setAddError('')
    setAddSuccess(false)
    const id = deviceId.trim()
    if (!id) {
      setAddError('Device ID is required')
      return
    }

    try {
      const r = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: id, name: deviceName.trim() || undefined }),
      })
      if (!r.ok) {
        const text = await r.text()
        throw new Error(text || 'Failed to add device')
      }
      addManualDeviceId(id)
      setDeviceId('')
      setDeviceName('')
      setAddSuccess(true)
      onSettingsChange?.()
      setTimeout(() => setAddSuccess(false), 2000)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add device')
    }
  }

  if (!isOpen) return null

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="fixed right-0 top-0 z-50 h-full w-full max-w-md border-l border-slate-700 bg-slate-900 shadow-xl sm:w-96"
        role="dialog"
        aria-labelledby="settings-title"
        aria-modal="true"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
            <h2 id="settings-title" className="font-display text-lg font-semibold text-slate-100">
              Settings
            </h2>
            <button
              onClick={onClose}
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              aria-label="Close settings"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {/* MQTT broker config */}
            <section className="mb-6">
              <h3 className="mb-3 text-sm font-medium text-slate-300">MQTT broker</h3>
              <form onSubmit={handleMqttSave} className="space-y-3">
                <div>
                  <label htmlFor="mqtt-host" className="mb-1 block text-xs text-slate-500">
                    Broker host
                  </label>
                  <input
                    id="mqtt-host"
                    type="text"
                    value={mqttBrokerHost}
                    onChange={(e) => setMqttBrokerHost(e.target.value)}
                    placeholder="192.168.1.250"
                    className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
                <div>
                  <label htmlFor="mqtt-port" className="mb-1 block text-xs text-slate-500">
                    Port
                  </label>
                  <input
                    id="mqtt-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={mqttBrokerPort}
                    onChange={(e) => setMqttBrokerPort(e.target.value)}
                    className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
                <div>
                  <label htmlFor="mqtt-username" className="mb-1 block text-xs text-slate-500">
                    Username (optional)
                  </label>
                  <input
                    id="mqtt-username"
                    type="text"
                    value={mqttUsername}
                    onChange={(e) => setMqttUsername(e.target.value)}
                    placeholder="Leave blank if not needed"
                    className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
                <div>
                  <label htmlFor="mqtt-password" className="mb-1 block text-xs text-slate-500">
                    Password (optional)
                  </label>
                  <input
                    id="mqtt-password"
                    type="password"
                    value={mqttPassword}
                    onChange={(e) => setMqttPassword(e.target.value)}
                    placeholder={mqttSettings?.has_password ? "•••••••• (leave blank to keep)" : "Leave blank if not needed"}
                    autoComplete="new-password"
                    className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
                {mqttSaveError && <p className="text-sm text-rose-400">{mqttSaveError}</p>}
                {mqttSaveSuccess && <p className="text-sm text-emerald-400">Broker settings saved. Reconnecting…</p>}
                <button
                  type="submit"
                  className="w-full rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                >
                  Save broker settings
                </button>
              </form>
              <p className="mt-2 text-xs text-slate-500">
                Status: <span className={health?.mqtt_connected ? 'text-emerald-400' : 'text-amber-400'}>
                  {health?.mqtt_connected ? 'Connected' : 'Disconnected'}
                </span>
                {!health?.mqtt_connected && ' — Ensure Mosquitto is running and the host/port are correct.'}
              </p>
            </section>

            {/* Auto discovery */}
            <section className="mb-6">
              <h3 className="mb-3 text-sm font-medium text-slate-300">Device discovery</h3>
              <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-700 bg-slate-800/50 p-4 transition hover:border-slate-600">
                <span className="text-sm text-slate-200">
                  Auto-discover devices on LAN (via MQTT)
                </span>
                <input
                  type="checkbox"
                  checked={autoDiscovery}
                  onChange={(e) => handleAutoDiscoveryChange(e.target.checked)}
                  className="h-5 w-5 rounded border-slate-600 bg-slate-700 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0 focus:ring-offset-slate-900"
                />
              </label>
              <p className="mt-1 text-xs text-slate-500">
                When enabled, devices publishing telemetry on aqua/+/telemetry are discovered automatically.
              </p>
            </section>

            {/* Add device */}
            <section>
              <h3 className="mb-3 text-sm font-medium text-slate-300">Add device manually</h3>
              <p className="text-xs text-slate-500 mb-3">
                If autodiscovery fails, add your ESP32 manually. Use the device_id from your sketch (e.g. esp32-01). The device will appear and go online once it publishes telemetry.
              </p>
              <form onSubmit={handleAddDevice} className="space-y-3">
                <div>
                  <label htmlFor="device-id" className="mb-1 block text-xs text-slate-500">
                    Device ID (e.g. esp32-01)
                  </label>
                  <input
                    id="device-id"
                    type="text"
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    placeholder="esp32-01"
                    className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
                <div>
                  <label htmlFor="device-name" className="mb-1 block text-xs text-slate-500">
                    Friendly name (optional)
                  </label>
                  <input
                    id="device-name"
                    type="text"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    placeholder="Living room aquarium"
                    className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
                {addError && (
                  <p className="text-sm text-rose-400">{addError}</p>
                )}
                {addSuccess && (
                  <p className="text-sm text-emerald-400">Device added successfully.</p>
                )}
                <button
                  type="submit"
                  className="w-full rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                >
                  Add device
                </button>
              </form>
            </section>
          </div>
        </div>
      </div>
    </>
  )
}
