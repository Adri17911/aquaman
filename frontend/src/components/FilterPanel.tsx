import { useCallback, useState } from 'react'
import {
  sendFilterCommand,
  getCommandStatus,
  getLatestTelemetry,
  type FilterBleScanResult,
  type TelemetryPoint,
} from '../api'

const ACK_SHORT_MS = 8000
const ACK_CONNECT_MS = 35000
const ACK_SCAN_MS = 25000
const ACK_POLL_MS = 100
const SCAN_RESULTS_POLL_MS = 350
const SCAN_RESULTS_WAIT_MS = 20000

interface FilterPanelProps {
  deviceId: string
  telemetry: TelemetryPoint | null
  refetchTelemetry: () => void
}

export function FilterPanel({ deviceId, telemetry, refetchTelemetry }: FilterPanelProps) {
  const [pending, setPending] = useState<string | null>(null)
  const [lastUiError, setLastUiError] = useState<string | null>(null)
  const [scanList, setScanList] = useState<FilterBleScanResult[]>([])
  const [selectedAddress, setSelectedAddress] = useState('')

  const waitAck = useCallback(async (correlationId: string, timeoutMs: number) => {
    const start = Date.now()
    const check = async (): Promise<boolean> => {
      const status = await getCommandStatus(correlationId)
      if (status.status === 'ACKED') return true
      if (Date.now() - start > timeoutMs) return false
      await new Promise((r) => setTimeout(r, ACK_POLL_MS))
      return check()
    }
    return check()
  }, [])

  const runAction = async (action: string, timeoutMs: number) => {
    setLastUiError(null)
    setPending(action)
    try {
      const { correlation_id } = await sendFilterCommand(deviceId, action)
      const ok = await waitAck(correlation_id, timeoutMs)
      if (!ok) setLastUiError('No acknowledgment from controller (check ESP32 / MQTT).')
      refetchTelemetry()
    } catch (e) {
      setLastUiError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(null)
    }
  }

  const runActionPayload = async (
    action: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ) => {
    setLastUiError(null)
    setPending(action)
    try {
      const { correlation_id } = await sendFilterCommand(deviceId, action, payload)
      const ok = await waitAck(correlation_id, timeoutMs)
      if (!ok) setLastUiError('No acknowledgment from controller (check ESP32 / MQTT).')
      refetchTelemetry()
    } catch (e) {
      setLastUiError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(null)
    }
  }

  const handleBleScan = async () => {
    setLastUiError(null)
    setPending('ble_scan')
    let userMsg: string | null = null
    try {
      const { correlation_id } = await sendFilterCommand(deviceId, 'ble_scan')
      const ok = await waitAck(correlation_id, ACK_SCAN_MS)
      if (!ok) {
        userMsg = 'Scan command was not acknowledged (check ESP32 / MQTT).'
      } else {
        const deadline = Date.now() + SCAN_RESULTS_WAIT_MS
        let results: FilterBleScanResult[] | null = null
        while (Date.now() < deadline) {
          const t = await getLatestTelemetry(deviceId)
          if (t?.filter_scan_status === 'error') {
            userMsg = 'BLE scan failed on the controller.'
            break
          }
          const r = t?.filter_scan_results
          if (Array.isArray(r) && r.length > 0) {
            results = r.filter((row): row is FilterBleScanResult => typeof row?.address === 'string')
            if (results.length > 0) break
          }
          await new Promise((r) => setTimeout(r, SCAN_RESULTS_POLL_MS))
        }
        if (!userMsg) {
          if (results && results.length > 0) {
            setScanList(results)
            setSelectedAddress((prev) =>
              results!.some((row) => row.address === prev) ? prev : results![0].address
            )
          } else {
            userMsg =
              'No Bluetooth devices in telemetry yet. If your ESP32 firmware does not handle the ble_scan command, update it so scan results are published in telemetry.'
          }
        }
      }
    } catch (e) {
      userMsg = e instanceof Error ? e.message : String(e)
    } finally {
      setPending(null)
      if (userMsg) setLastUiError(userMsg)
      refetchTelemetry()
    }
  }

  const handleBindBle = () => {
    const addr = selectedAddress.trim()
    if (!addr) return
    void runActionPayload('bind_ble', { address: addr }, ACK_SHORT_MS)
  }

  const fromTelemetry = telemetry?.filter_scan_results
  const displayList: FilterBleScanResult[] =
    scanList.length > 0
      ? scanList
      : Array.isArray(fromTelemetry)
        ? fromTelemetry.filter((row): row is FilterBleScanResult => typeof row?.address === 'string')
        : []

  const t = telemetry
  const bleOk = t?.filter_ble_connected === true
  const bleOff = t?.filter_ble_connected === false
  const powerStr =
    t?.filter_power === true ? 'ON' : t?.filter_power === false ? 'OFF' : '—'
  const modeStr = t?.filter_mode && t.filter_mode !== 'unknown' ? t.filter_mode : '—'
  const blobStr = t?.filter_state_blob_hex?.trim()
    ? t.filter_state_blob_hex.length > 48
      ? `${t.filter_state_blob_hex.slice(0, 48)}…`
      : t.filter_state_blob_hex
    : '—'
  const errStr = t?.filter_ble_error?.trim() || lastUiError || '—'
  const addrStr = t?.filter_last_address?.trim() || '—'
  const scanStatusStr = t?.filter_scan_status?.trim()

  const busy = pending !== null

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <h2 className="mb-1 font-display text-sm font-medium text-slate-300">
        AQUAEL UltraMax BT (via ESP32 bridge)
      </h2>
      <p className="mb-3 text-xs text-slate-500">
        Commands go to your aquarium controller over MQTT; the ESP32 connects to the filter over Bluetooth. Close the vendor app so only one central connects.
      </p>

      <div className="mb-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <p className="mb-2 text-xs text-slate-500">
          Pick the pump using Bluetooth Low Energy on the ESP32 (not Wi‑Fi). Run a scan while the device is powered and advertising, choose the correct row, bind the address, then press Connect.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleBleScan()}
            className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            {pending === 'ble_scan' ? 'Scanning…' : 'Scan for Bluetooth devices'}
          </button>
          <select
            className="min-w-[12rem] rounded-lg border border-slate-600 bg-slate-900 px-2 py-2 text-sm text-slate-200 disabled:opacity-50"
            value={selectedAddress}
            onChange={(e) => setSelectedAddress(e.target.value)}
            disabled={busy || displayList.length === 0}
          >
            <option value="">Select device…</option>
            {displayList.map((row) => {
              const label = row.name?.trim() || 'Unknown'
              const rssi =
                row.rssi != null && Number.isFinite(row.rssi) ? `, ${row.rssi} dBm` : ''
              return (
                <option key={row.address} value={row.address}>
                  {label} ({row.address}
                  {rssi})
                </option>
              )
            })}
          </select>
          <button
            type="button"
            disabled={busy || !selectedAddress.trim()}
            onClick={handleBindBle}
            className="rounded-lg bg-slate-600 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending === 'bind_ble' ? '…' : 'Use this address'}
          </button>
        </div>
        {(scanStatusStr || displayList.length > 0) && (
          <p className="mt-2 text-xs text-slate-500">
            {displayList.length > 0 ? (
              <>
                {displayList.length} device(s) in last results
                {scanStatusStr ? ` · status: ${scanStatusStr}` : ''}
              </>
            ) : (
              scanStatusStr && <>Last scan status: {scanStatusStr}</>
            )}
          </p>
        )}
      </div>

      <div className="mb-4 grid gap-2 text-xs text-slate-400 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <span className="text-slate-500">Filter BLE: </span>
          {bleOk ? <span className="text-emerald-400">Connected</span> : bleOff ? <span className="text-rose-400">Disconnected</span> : <span>Unknown</span>}
        </div>
        <div>
          <span className="text-slate-500">Power: </span>
          <span className="text-slate-200">{powerStr}</span>
        </div>
        <div>
          <span className="text-slate-500">Mode: </span>
          <span className="text-slate-200">{modeStr}</span>
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <span className="text-slate-500">State blob (hex): </span>
          <span className="break-all font-mono text-slate-300">{blobStr}</span>
        </div>
        <div>
          <span className="text-slate-500">Last address: </span>
          <span className="font-mono text-slate-300">{addrStr}</span>
        </div>
        <div className="sm:col-span-2">
          <span className="text-slate-500">Error: </span>
          <span className="text-rose-300/90">{errStr}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => runAction('connect', ACK_CONNECT_MS)}
          className="rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50"
        >
          {pending === 'connect' ? '…' : 'Connect'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => runAction('disconnect', ACK_SHORT_MS)}
          className="rounded-lg bg-slate-600 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500 disabled:opacity-50"
        >
          {pending === 'disconnect' ? '…' : 'Disconnect'}
        </button>
        <button
          type="button"
          disabled={busy || !bleOk}
          onClick={() => runAction('on', ACK_SHORT_MS)}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending === 'on' ? '…' : 'Filtration on'}
        </button>
        <button
          type="button"
          disabled={busy || !bleOk}
          onClick={() => runAction('off', ACK_SHORT_MS)}
          className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending === 'off' ? '…' : 'Filtration off'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {(
          [
            ['mode_constant', 'Constant'],
            ['mode_pulse', 'Pulse'],
            ['mode_dashed', 'Dashed'],
            ['mode_sine', 'Sine'],
          ] as const
        ).map(([action, label]) => (
          <button
            key={action}
            type="button"
            disabled={busy || !bleOk}
            onClick={() => runAction(action, ACK_SHORT_MS)}
            className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending === action ? '…' : label}
          </button>
        ))}
        <button
          type="button"
          disabled={busy || !bleOk}
          onClick={() => runAction('read_state', ACK_SHORT_MS)}
          className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending === 'read_state' ? '…' : 'Read state'}
        </button>
      </div>
    </div>
  )
}
