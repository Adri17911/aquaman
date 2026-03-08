import { useState, useEffect } from 'react'
import {
  getHealth,
  getMqttSettings,
  updateMqttSettings,
  getDevices,
  addDevice,
  updateDevice,
  type ApiDevice,
} from '../api'

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
  isAdmin?: boolean
}

export function Settings({ isOpen, onClose, onSettingsChange }: SettingsProps) {
  const [health, setHealth] = useState<Awaited<ReturnType<typeof getHealth>> | null>(null)
  const [mqttSettings, setMqttSettings] = useState<Awaited<ReturnType<typeof getMqttSettings>> | null>(null)
  const [mqttBrokerHost, setMqttBrokerHost] = useState('')
  const [mqttSaveError, setMqttSaveError] = useState('')
  const [mqttSaveSuccess, setMqttSaveSuccess] = useState(false)
  const [devices, setDevices] = useState<ApiDevice[]>([])
  const [deviceManageError, setDeviceManageError] = useState('')
  const [addDeviceId, setAddDeviceId] = useState('')
  const [addDeviceName, setAddDeviceName] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingName, setEditingName] = useState<Record<string, string>>({})
  const [togglingEnabled, setTogglingEnabled] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      getHealth().then(setHealth).catch(() => setHealth(null))
      getMqttSettings().then((s) => {
        setMqttSettings(s)
        setMqttBrokerHost(s.broker_host)
      }).catch(() => setMqttSettings(null))
      getDevices().then(setDevices).catch(() => setDevices([]))
    }
  }, [isOpen])

  const handleMqttSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setMqttSaveError('')
    setMqttSaveSuccess(false)
    try {
      await updateMqttSettings({
        broker_host: mqttBrokerHost.trim() || 'localhost',
      })
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
    setDeviceManageError('')
    const id = addDeviceId.trim()
    if (!id) return
    setAdding(true)
    try {
      await addDevice(id, addDeviceName.trim() || undefined)
      setAddDeviceId('')
      setAddDeviceName('')
      const list = await getDevices()
      setDevices(list)
      onSettingsChange?.()
    } catch (err) {
      setDeviceManageError(err instanceof Error ? err.message : 'Failed to add device')
    } finally {
      setAdding(false)
    }
  }

  const handleUpdateName = async (deviceId: string) => {
    const name = editingName[deviceId]
    if (name === undefined) return
    setDeviceManageError('')
    try {
      await updateDevice(deviceId, { name: name.trim() || deviceId })
      setEditingName((prev) => {
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      const list = await getDevices()
      setDevices(list)
      onSettingsChange?.()
    } catch (err) {
      setDeviceManageError(err instanceof Error ? err.message : 'Failed to update name')
    }
  }

  const handleToggleEnabled = async (deviceId: string) => {
    const dev = devices.find((d) => d.device_id === deviceId)
    if (dev?.enabled === undefined) return
    setTogglingEnabled(deviceId)
    setDeviceManageError('')
    try {
      await updateDevice(deviceId, { enabled: !dev.enabled })
      const list = await getDevices()
      setDevices(list)
      onSettingsChange?.()
    } catch (err) {
      setDeviceManageError(err instanceof Error ? err.message : 'Failed to update')
    } finally {
      setTogglingEnabled(null)
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
        onClick={(e) => e.stopPropagation()}
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
            <section className="mb-6">
              <h3 className="mb-3 text-sm font-medium text-slate-300">MQTT broker</h3>
              <p className="mb-3 text-xs text-slate-500">
                Use the <strong>same</strong> broker your ESP32 connects to (the <code>mqttServer</code> in your sketch, e.g. 192.168.0.250). The app does not run the broker; both the app and the ESP32 connect to it. Devices appear when they publish to this broker.
              </p>
              {mqttSettings === null && (
                <p className="mb-2 text-sm text-amber-400">Could not load broker settings. Check connection and try again.</p>
              )}
              <form onSubmit={handleMqttSave} className="space-y-3">
                <div>
                  <label htmlFor="mqtt-host" className="mb-1 block text-xs text-slate-500">
                    Broker host (IP or hostname)
                  </label>
                  <input
                    id="mqtt-host"
                    type="text"
                    value={mqttBrokerHost}
                    onChange={(e) => setMqttBrokerHost(e.target.value)}
                    placeholder="192.168.0.250"
                    className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  />
                </div>
                {mqttSaveError && <p className="text-sm text-rose-400">{mqttSaveError}</p>}
                {mqttSaveSuccess && <p className="text-sm text-emerald-400">Broker host saved. Reconnecting…</p>}
                <button
                  type="submit"
                  className="w-full rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                >
                  Save
                </button>
              </form>
              <p className="mt-2 text-xs text-slate-500">
                Status: <span className={health?.mqtt_connected ? 'text-emerald-400' : 'text-amber-400'}>
                  {health?.mqtt_connected ? 'Connected' : 'Disconnected'}
                </span>
                {!health?.mqtt_connected && ' — Ensure Mosquitto is running and the host is correct.'}
              </p>
            </section>

            <section className="mb-6">
              <h3 className="mb-3 text-sm font-medium text-slate-300">Device management</h3>
              {deviceManageError && <p className="mb-2 text-sm text-rose-400">{deviceManageError}</p>}
              <div className="mb-4 space-y-2">
                {devices.map((d) => {
                  const typeLabel = d.capabilities?.room_sensor ? 'Room sensor' : 'Controller'
                  const nameVal = editingName[d.device_id] ?? d.name ?? d.device_id
                  return (
                    <div
                      key={d.device_id}
                      className={`rounded-lg border p-3 ${d.enabled === false ? 'border-slate-700 bg-slate-800/50' : 'border-slate-700 bg-slate-800'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          {editingName[d.device_id] !== undefined ? (
                            <div className="flex gap-1">
                              <input
                                type="text"
                                value={nameVal}
                                onChange={(e) => setEditingName((prev) => ({ ...prev, [d.device_id]: e.target.value }))}
                                className="flex-1 rounded border border-slate-600 bg-slate-700 px-2 py-1 text-sm text-slate-200"
                                placeholder="Display name"
                              />
                              <button
                                type="button"
                                onClick={() => handleUpdateName(d.device_id)}
                                className="rounded bg-cyan-600 px-2 py-1 text-xs text-white hover:bg-cyan-500"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingName((prev) => { const next = { ...prev }; delete next[d.device_id]; return next })}
                                className="rounded bg-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-500"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <span className="truncate font-medium text-slate-200" title={d.device_id}>
                              {d.name || d.device_id}
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-xs text-slate-500">{typeLabel}</span>
                          <span className={`text-xs ${d.online ? 'text-emerald-400' : 'text-slate-500'}`}>
                            {d.online ? '●' : '○'}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleToggleEnabled(d.device_id)}
                            disabled={togglingEnabled === d.device_id}
                            title={d.enabled === false ? 'Enable device' : 'Disable device'}
                            className={`rounded px-2 py-1 text-xs ${d.enabled === false ? 'bg-amber-600/80 text-white hover:bg-amber-500' : 'bg-slate-600 text-slate-300 hover:bg-slate-500'} disabled:opacity-50`}
                          >
                            {togglingEnabled === d.device_id ? '…' : d.enabled === false ? 'Disabled' : 'Enabled'}
                          </button>
                          {editingName[d.device_id] === undefined && (
                            <button
                              type="button"
                              onClick={() => setEditingName((prev) => ({ ...prev, [d.device_id]: d.name ?? d.device_id }))}
                              className="rounded bg-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-500"
                            >
                              Edit name
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-500">{d.device_id}</p>
                    </div>
                  )
                })}
              </div>
              <form onSubmit={handleAddDevice} className="space-y-2">
                <p className="text-xs text-slate-500">Add a device by ID (e.g. before it sends data):</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={addDeviceId}
                    onChange={(e) => setAddDeviceId(e.target.value)}
                    placeholder="device-id"
                    className="flex-1 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-500"
                  />
                  <input
                    type="text"
                    value={addDeviceName}
                    onChange={(e) => setAddDeviceName(e.target.value)}
                    placeholder="Name (optional)"
                    className="w-28 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={adding || !addDeviceId.trim()}
                  className="w-full rounded-lg bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500 disabled:opacity-50"
                >
                  {adding ? 'Adding…' : 'Add device'}
                </button>
              </form>
            </section>
          </div>
        </div>
      </div>
    </>
  )
}
